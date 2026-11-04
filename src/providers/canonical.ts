/**
 * Formato canónico del harness.
 *
 * Es deliberadamente el modelo de content blocks de Anthropic: es el más expresivo
 * (tool_use/tool_result emparejados por id). El resto de proveedores se adaptan
 * a esto en el borde, nunca al revés.
 */

export type TextBlock = { type: "text"; text: string };

export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };

export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

export type Block = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: "user" | "assistant";
  content: Block[];
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
}

/** Partes del system prompt. `cache: true` marca el final de un prefijo estable. */
export interface SystemPart {
  text: string;
  cache?: boolean;
}

export interface CanonicalRequest {
  model: string;
  system: SystemPart[];
  tools: ToolSpec[];
  messages: Message[];
  maxTokens: number;
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "pause_turn"
  | "refusal"
  | "other";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

export const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
});

export type ProviderEvent =
  | { t: "text_delta"; text: string }
  | { t: "tool_use_start"; id: string; name: string }
  | { t: "message_end"; message: Message; stopReason: StopReason; usage: Usage };

export interface ProviderCapabilities {
  cache: boolean;
  parallelTools: boolean;
  contextWindow: number;
}

export interface Provider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  /** Debe terminar siempre con exactamente un `message_end` o lanzar. */
  stream(req: CanonicalRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}

export const toolUses = (m: Message): ToolUseBlock[] =>
  m.content.filter((b): b is ToolUseBlock => b.type === "tool_use");

export const textOf = (m: Message): string =>
  m.content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
