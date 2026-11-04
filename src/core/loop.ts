import {
  type Block,
  type CanonicalRequest,
  type Message,
  type Provider,
  type StopReason,
  type SystemPart,
  type ToolResultBlock,
  type ToolUseBlock,
  type Usage,
  addUsage,
  emptyUsage,
  textOf,
  toolUses,
} from "../providers/canonical.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { AgentEvent, AgentState, EventBus, RunEndReason } from "./events.js";

export interface AgentConfig {
  model: string;
  maxTokens: number;
  /** Límites por run(). Son el cinturón de seguridad contra loops infinitos y facturas. */
  maxTurns: number;
  maxToolCalls: number;
  /** Misma llamada fallando N veces seguidas => el modelo está atascado. */
  maxRepeatedFailures: number;
}

export const defaultAgentConfig = (model: string): AgentConfig => ({
  model,
  maxTokens: 4_096,
  maxTurns: 25,
  maxToolCalls: 100,
  maxRepeatedFailures: 3,
});

export interface AgentDeps {
  provider: Provider;
  registry: ToolRegistry;
  bus: EventBus;
  system: SystemPart[];
  workspace: string;
}

export interface RunResult {
  reason: RunEndReason;
  /** Texto del último mensaje del asistente. */
  text: string;
  usage: Usage;
  turns: number;
  toolCalls: number;
  error?: string;
}

const INTERRUPTED = "Interrupted by user before this tool ran.";

export class Agent {
  readonly messages: Message[] = [];
  private _state: AgentState = "idle";

  constructor(
    private deps: AgentDeps,
    private cfg: AgentConfig,
  ) {}

  get state(): AgentState {
    return this._state;
  }

  /**
   * Ejecuta un turno de usuario completo: modelo -> herramientas -> modelo ... hasta end_turn
   * o hasta que salte un límite. Puede llamarse varias veces (conversación multi-turno).
   */
  async run(prompt: string, signal: AbortSignal = new AbortController().signal): Promise<RunResult> {
    this.pushUser([{ type: "text", text: prompt }]);

    const failures = new Map<string, number>();
    let usage = emptyUsage();
    let toolCalls = 0;
    let lastText = "";
    let retriedEmpty = false;

    const end = (reason: RunEndReason, turns: number, error?: string): RunResult => {
      this.setState(reason === "aborted" ? "aborted" : reason === "error" ? "error" : "done");
      this.emit({ t: "run_end", reason, usage, turns });
      return { reason, text: lastText, usage, turns, toolCalls, ...(error ? { error } : {}) };
    };

    for (let turn = 1; turn <= this.cfg.maxTurns; turn++) {
      if (signal.aborted) return end("aborted", turn - 1);

      // 1. Modelo
      this.setState("awaiting_model");
      let assistant: Message;
      let stopReason: StopReason;
      let turnUsage: Usage;
      try {
        const res = await this.callModel(signal);
        assistant = res.message;
        stopReason = res.stopReason;
        turnUsage = res.usage;
        usage = addUsage(usage, res.usage);
        this.emit({ t: "turn_end", turn, usage: res.usage });
      } catch (e) {
        // Abort durante el stream: el mensaje parcial se descarta, el emparejamiento sigue intacto.
        if (signal.aborted) return end("aborted", turn - 1);
        return end("error", turn - 1, errorMessage(e));
      }

      // Respuesta vacía: no se guarda (ninguna API acepta un assistant sin contenido). Suele ser una tool call
      // que el servidor no supo parsear (p. ej. un nombre de herramienta inexistente) y la descartó.
      // Una vez por run se le explica al modelo y se repite; si vuelve a pasar, el run acaba.
      if (assistant.content.length === 0) {
        if (stopReason === "max_tokens") return end("max_tokens", turn);
        const out = turnUsage.outputTokens;
        const why = out > 0 ? `${out} output tokens were generated, but the server returned no text and no tool call` : "the model returned no text and no tool call";
        if (!retriedEmpty) {
          retriedEmpty = true;
          this.emit({ t: "warning", message: `Empty response: ${why}. Retrying with feedback to the model.` });
          this.pushUser([{ type: "text", text: this.emptyResponseFeedback() }]);
          continue;
        }
        return end("empty_response", turn, `Empty response again after feedback: ${why}. The model is probably calling a tool that does not exist; try a model with better tool support.`);
      }

      this.messages.push(assistant);
      lastText = textOf(assistant) || lastText;

      // 2. ¿Terminó?
      const calls = toolUses(assistant);
      if (calls.length === 0) {
        if (stopReason === "max_tokens") return end("max_tokens", turn);
        if (stopReason === "refusal") return end("refusal", turn);
        return end("end_turn", turn);
      }

      // 3. Herramientas. Todo tool_use recibe su tool_result, pase lo que pase.
      toolCalls += calls.length;
      this.setState("executing_tools");
      const results = await this.executeCalls(calls, signal);
      this.pushUser(results);

      if (signal.aborted) return end("aborted", turn);
      if (toolCalls >= this.cfg.maxToolCalls) return end("max_tool_calls", turn);

      // 4. Circuit breaker
      for (const [i, r] of results.entries()) {
        const key = `${calls[i]!.name}:${stableStringify(calls[i]!.input)}`;
        if (r.is_error) failures.set(key, (failures.get(key) ?? 0) + 1);
        else failures.delete(key);
        if ((failures.get(key) ?? 0) >= this.cfg.maxRepeatedFailures) {
          this.emit({ t: "warning", message: `Stopping: ${calls[i]!.name} failed ${this.cfg.maxRepeatedFailures} times with the same input.` });
          return end("repeated_failure", turn);
        }
      }
    }
    return end("max_turns", this.cfg.maxTurns);
  }

  // ---------------------------------------------------------------------------

  /** La petición que se enviaría ahora al modelo. */
  buildRequest(): CanonicalRequest {
    return {
      model: this.cfg.model,
      system: this.deps.system,
      tools: this.deps.registry.specs(),
      messages: this.messages,
      maxTokens: this.cfg.maxTokens,
    };
  }

  private async callModel(signal: AbortSignal) {
    for await (const ev of this.deps.provider.stream(this.buildRequest(), signal)) {
      if (ev.t === "text_delta") this.emit({ t: "text_delta", text: ev.text });
      else if (ev.t === "message_end") return ev;
    }
    throw new Error("Provider stream ended without message_end");
  }

  /**
   * Las llamadas se ejecutan en paralelo si todas son de solo lectura; si no, una a una y en orden.
   * El orden de los resultados = orden de las llamadas.
   */
  private async executeCalls(calls: ToolUseBlock[], signal: AbortSignal): Promise<ToolResultBlock[]> {
    const results: ToolResultBlock[] = [];
    let batch: ToolUseBlock[] = [];
    const flush = async () => {
      results.push(...(await Promise.all(batch.map((c) => this.executeOne(c, signal)))));
      batch = [];
    };
    for (const call of calls) {
      if (this.deps.registry.isReadOnly(call.name, call.input)) {
        batch.push(call);
        continue;
      }
      await flush();
      results.push(await this.executeOne(call, signal));
    }
    await flush();
    return results;
  }

  private async executeOne(call: ToolUseBlock, signal: AbortSignal): Promise<ToolResultBlock> {
    const result = (content: string, isError = false): ToolResultBlock => ({
      type: "tool_result",
      tool_use_id: call.id,
      content,
      ...(isError ? { is_error: true } : {}),
    });

    if (signal.aborted) return result(INTERRUPTED, true);

    // Un input inválido o una herramienta desconocida no rompen el run: vuelven al modelo como error.
    const parsed = this.deps.registry.parse(call.name, call.input);
    if (!parsed.ok) return result(parsed.error, true);
    const { tool, input } = parsed;

    this.emit({ t: "tool_start", call });
    const t0 = Date.now();
    let out: ToolResultBlock;
    try {
      const r = await tool.run(input, { workspace: this.deps.workspace, signal, callId: call.id });
      out = result(r.content, !!r.isError);
    } catch (e) {
      out = result(`Tool ${call.name} failed: ${errorMessage(e)}`, true);
    }
    this.emit({ t: "tool_end", call, result: out, durationMs: Date.now() - t0 });
    return out;
  }

  /** Lo que se le dice al modelo tras una respuesta vacía: qué herramientas existen. */
  private emptyResponseFeedback(): string {
    const names = this.deps.registry.specs().map((s) => s.name);
    return [
      "<system-reminder>",
      "Your previous response was empty: it was probably a call to a tool that does not exist, and it was discarded.",
      `The only tools you can call are: ${names.join(", ")}.`,
      "Answer the user's last message again, with text or with a call to one of those tools.",
      "</system-reminder>",
    ].join("\n");
  }

  /** La API exige alternancia: bloques de usuario consecutivos se fusionan en un mensaje. */
  private pushUser(content: Block[]): void {
    const last = this.messages.at(-1);
    if (last?.role === "user") last.content.push(...content);
    else this.messages.push({ role: "user", content: [...content] });
  }

  private setState(s: AgentState): void {
    if (s === this._state) return;
    this._state = s;
    this.emit({ t: "state", state: s });
  }

  private emit(e: AgentEvent): void {
    this.deps.bus.emit(e);
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}
