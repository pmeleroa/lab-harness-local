import type {
  Block,
  CanonicalRequest,
  Message,
  Provider,
  ProviderCapabilities,
  ProviderEvent,
  StopReason,
  ToolUseBlock,
  Usage,
} from "./canonical.js";

/**
 * Adapter para la API chat completions de OpenAI y los servidores que la imitan
 * (Ollama, vLLM, LiteLLM en modo OpenAI). Sin SDK: fetch + SSE.
 *
 * Lo que el formato canónico tiene y este protocolo no:
 *  - cache_control: no se envía; los tokens cacheados se leen si el servidor los da;
 *  - is_error en tool_result: va como prefijo del contenido.
 */

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  tools?: { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }[];
  max_tokens: number;
  stream: true;
  stream_options: { include_usage: true };
}

export const TOOL_ERROR_PREFIX = "[tool error] ";

/** Petición canónica -> chat completions. */
export function toOpenAIParams(req: CanonicalRequest): ChatParams {
  const messages: ChatMessage[] = [];
  const system = req.system.map((p) => p.text).join("\n\n");
  if (system) messages.push({ role: "system", content: system });

  for (const m of req.messages) {
    if (m.role === "assistant") {
      const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      const calls = m.content
        .filter((b): b is ToolUseBlock => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: "function" as const,
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      if (!text && !calls.length) continue;
      messages.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }

    // Usuario: los tool_result van primero, como mensajes `tool` justo detrás del assistant que los pidió.
    const parts: string[] = [];
    for (const b of m.content) {
      if (b.type === "tool_result") {
        const content = b.is_error ? TOOL_ERROR_PREFIX + b.content : b.content;
        messages.push({ role: "tool", tool_call_id: b.tool_use_id, content });
      } else if (b.type === "text") parts.push(b.text);
    }
    if (!parts.length) continue;
    messages.push({ role: "user", content: parts.join("\n\n") });
  }

  const params: ChatParams = {
    model: req.model,
    messages,
    max_tokens: req.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.tools.length)
    params.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  return params;
}

function mapFinish(s: string | null | undefined, hasToolCalls: boolean): StopReason {
  // Algunos servidores cierran con "stop" aunque haya tool calls.
  if (hasToolCalls && (s === "stop" || s === "tool_calls" || s === "function_call" || !s)) return "tool_use";
  switch (s) {
    case "stop":
      return "end_turn";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

/** `inputTokens` excluye lo leído de caché, como en Anthropic. */
function mapUsage(u: OpenAIUsage | undefined): Usage {
  const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (u?.prompt_tokens ?? 0) - cached),
    outputTokens: u?.completion_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

interface ChunkToolCall {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface Chunk {
  choices?: {
    delta?: { content?: string | null; tool_calls?: ChunkToolCall[] };
    finish_reason?: string | null;
  }[];
  usage?: OpenAIUsage | null;
  error?: { message?: string };
}

/** Acumula los chunks de un stream y produce los eventos canónicos. */
export class ChunkAccumulator {
  private text = "";
  private calls: { id: string; name: string; args: string; started: boolean }[] = [];
  private finish: string | null = null;
  private usage: OpenAIUsage | undefined;

  *push(chunk: Chunk): Generator<ProviderEvent> {
    if (chunk.error) throw new Error(`openai stream error: ${chunk.error.message ?? "unknown"}`);
    if (chunk.usage) this.usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const d = choice.delta ?? {};
    if (d.content) {
      this.text += d.content;
      yield { t: "text_delta", text: d.content };
    }
    for (const tc of d.tool_calls ?? []) {
      let i = tc.index ?? this.calls.length;
      // Un id nuevo en un índice ya ocupado es otra llamada (servidores que mandan todo con index 0).
      if (tc.id && this.calls[i]?.id && this.calls[i]!.id !== tc.id) i = this.calls.length;
      const call = (this.calls[i] ??= { id: "", name: "", args: "", started: false });
      if (tc.id) call.id = tc.id;
      if (tc.function?.name) call.name ||= tc.function.name;
      if (tc.function?.arguments) call.args += tc.function.arguments;
      if (!call.started && call.name) {
        // Hay servidores que no mandan id: se inventa uno estable para emparejar el resultado.
        call.id ||= `call_${i}_${Math.random().toString(36).slice(2, 10)}`;
        call.started = true;
        yield { t: "tool_use_start", id: call.id, name: call.name };
      }
    }
    if (choice.finish_reason) this.finish = choice.finish_reason;
  }

  end(): ProviderEvent {
    const content: Block[] = [];
    if (this.text) content.push({ type: "text", text: this.text });
    const calls = this.calls.filter((c) => c && c.name);
    for (const c of calls) content.push({ type: "tool_use", id: c.id, name: c.name, input: parseArgs(c.args) });
    const message: Message = { role: "assistant", content };
    return { t: "message_end", message, stopReason: mapFinish(this.finish, calls.length > 0), usage: mapUsage(this.usage) };
  }
}

/** Argumentos vacíos = sin input. Si no son JSON, se pasan tal cual y la validación de la tool lo rechaza. */
function parseArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Lee un cuerpo SSE y devuelve el JSON de cada `data:`. Para en `[DONE]`. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<Chunk> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(bytes, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      if (data) yield JSON.parse(data) as Chunk;
    }
  }
}

export interface OpenAIProviderOptions {
  /** Se envía como `Authorization: Bearer`. Ollama y vLLM sin --api-key no la necesitan. */
  apiKey?: string;
  /** Incluye la versión: `https://api.openai.com/v1`, `http://localhost:11434/v1`. */
  baseURL: string;
  headers?: Record<string, string>;
  maxRetries?: number;
  contextWindow?: number;
  fetch?: typeof fetch;
}

export class OpenAIProvider implements Provider {
  readonly id = "openai";
  readonly capabilities: ProviderCapabilities;
  private base: string;
  private fetchImpl: typeof fetch;

  constructor(private opts: OpenAIProviderOptions) {
    this.base = opts.baseURL.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.capabilities = {
      cache: false,
      parallelTools: true,
      contextWindow: opts.contextWindow ?? 128_000,
    };
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
      ...this.opts.headers,
    };
  }

  /** Reintenta 429/5xx y errores de red con backoff exponencial, solo antes de empezar a leer. */
  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const max = this.opts.maxRetries ?? 4;
    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined;
      let err: unknown;
      try {
        res = await this.fetchImpl(this.base + path, { ...init, ...(signal ? { signal } : {}) });
      } catch (e) {
        if (signal?.aborted) throw e;
        err = e;
      }
      if (res?.ok) return res;
      const retryable = !res || res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= max) {
        if (!res) throw err;
        const body = (await res.text().catch(() => "")).slice(0, 500);
        throw new Error(`openai ${init.method ?? "GET"} ${path}: ${res.status} ${body}`);
      }
      await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** attempt)));
    }
  }

  async *stream(req: CanonicalRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const res = await this.request(
      "/chat/completions",
      { method: "POST", headers: this.headers(), body: JSON.stringify(toOpenAIParams(req)) },
      signal,
    );
    if (!res.body) throw new Error("openai: empty response body");
    const acc = new ChunkAccumulator();
    for await (const chunk of sseData(res.body)) yield* acc.push(chunk);
    yield acc.end();
  }
}
