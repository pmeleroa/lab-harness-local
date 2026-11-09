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
import {
  type ContextPolicy,
  COMPACT_PROMPT,
  ToolResultClearing,
  capToolResult,
  defaultContextPolicy,
  estimateRequest,
  extractSummary,
  summaryMessage,
} from "../context/manager.js";
import { OVERFLOW_MIN_GROWTH_COMPACT, type RequestSample, looksTruncated } from "../context/overflow.js";
import type { PolicyEngine } from "../policy/engine.js";
import { FileStateCache } from "../tools/file-state.js";
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
  /** Ventana de contexto del modelo. Sin ella, la que declara el provider. */
  contextWindow?: number;
  /** Tope de tool_results, clearing y compaction (ver context/manager.ts). */
  context: ContextPolicy;
}

export const defaultAgentConfig = (model: string): AgentConfig => ({
  model,
  maxTokens: 4_096,
  maxTurns: 25,
  maxToolCalls: 100,
  maxRepeatedFailures: 3,
  context: defaultContextPolicy,
});

export type ApprovalAnswer =
  | { kind: "allow_once" }
  | { kind: "allow_always"; rule: string }
  | { kind: "deny"; feedback?: string };

export interface ApprovalRequest {
  call: ToolUseBlock;
  reason: string;
  suggestedRule: string | null;
}

export type Approver = (req: ApprovalRequest) => Promise<ApprovalAnswer>;

/** Sin terminal (CI, `< /dev/null`): todo lo que requiera confirmación se deniega. Fallar cerrado. */
export const denyAllApprover: Approver = async () => ({ kind: "deny", feedback: "No interactive user available." });

/** Un solo prompt de permiso a la vez, aunque las herramientas de lectura corran en paralelo. */
class ApprovalLock {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export interface AgentDeps {
  provider: Provider;
  registry: ToolRegistry;
  bus: EventBus;
  system: SystemPart[];
  workspace: string;
  policy: PolicyEngine;
  approver: Approver;
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

/** Parte de la ventana que como máximo se reserva para la respuesta. */
const RESERVE_FRACTION = 0.25;

export class Agent {
  readonly messages: Message[] = [];
  private _state: AgentState = "idle";
  private readonly clearing = new ToolResultClearing();
  /** Tokens reales de la última petición y lo que estimábamos de ella: calibra la estimación de lo añadido después. */
  private measured: { tokens: number; estimate: number } | null = null;
  /** La última petición que el servidor no recortó: base para detectar que la siguiente sí lo ha sido. */
  private lastSample: RequestSample | null = null;

  /** Lo que el modelo ha leído en este run: Edit y Write lo exigen antes de modificar un fichero. */
  private fileState = new FileStateCache();
  private approvalLock = new ApprovalLock();

  constructor(
    private deps: AgentDeps,
    private cfg: AgentConfig,
  ) {}

  get state(): AgentState {
    return this._state;
  }

  get contextWindow(): number {
    return this.cfg.contextWindow ?? this.deps.provider.capabilities.contextWindow;
  }

  /** Lo que ocuparía ahora la petición: el último uso real más la estimación de lo añadido desde entonces. */
  contextTokens(): number {
    const estimate = estimateRequest(this.buildRequest());
    return this.measured ? Math.max(0, this.measured.tokens + estimate - this.measured.estimate) : estimate;
  }

  /** Reserva para la respuesta: `maxTokens`, sin pasar del 25 % de la ventana. También es el `max_tokens` que se envía. */
  get reserve(): number {
    return Math.max(1, Math.min(this.cfg.maxTokens, Math.floor(this.contextWindow * RESERVE_FRACTION)));
  }

  /** Espacio para la entrada: la ventana menos lo reservado para la respuesta. */
  private get available(): number {
    return Math.max(1, this.contextWindow - this.reserve);
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
        usage = addUsage(usage, await this.manageContext(signal));
        const res = await this.callModel(signal);
        assistant = res.message;
        stopReason = res.stopReason;
        turnUsage = res.usage;
        usage = addUsage(usage, res.usage);
        this.emit({ t: "turn_end", turn, usage: res.usage, ...(res.truncated ? { truncated: true } : {}) });
        // El servidor recortó la conversación y respondió igual: lo dicho no parte de la tarea. Se descarta la
        // respuesta, la historia sigue completa en `messages` y el run acaba con nombre en vez de pasar por normal.
        if (res.truncated) return end("context_overflow", turn, this.overflowMessage(res.sent));
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
      messages: this.clearing.view(this.messages),
      maxTokens: this.reserve,
    };
  }

  private async callModel(signal: AbortSignal) {
    const req = this.buildRequest();
    const estimate = estimateRequest(req);
    for await (const ev of this.deps.provider.stream(req, signal)) {
      if (ev.t === "text_delta") this.emit({ t: "text_delta", text: ev.text });
      else if (ev.t === "message_end") {
        const u = ev.usage;
        const tokens = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
        // Un dato de una petición recortada no calibra: haría creer que hay sitio.
        const truncated = looksTruncated(this.lastSample, { tokens, estimate });
        // Un provider sin uso (0) no calibra: mejor la estimación sola.
        if (tokens > 0 && !truncated) {
          this.measured = { tokens, estimate };
          this.lastSample = { tokens, estimate };
        }
        return { ...ev, truncated, sent: { tokens, estimate } };
      }
    }
    throw new Error("Provider stream ended without message_end");
  }

  private overflowMessage(sent: RequestSample): string {
    return (
      `The server answered, but it reported ${sent.tokens} prompt tokens for a conversation estimated at ${sent.estimate}: ` +
      `it most likely dropped the start of the conversation, the task included, and answered without it. ` +
      `The configured context window is ${this.contextWindow} tokens. Set the real one with --context-window, ` +
      `or raise the server's (Ollama: OLLAMA_CONTEXT_LENGTH).`
    );
  }

  /**
   * Antes de cada llamada: si el contexto pasa de `clearAt`, limpia tool_results antiguos; si aun así pasa de
   * `compactAt`, compacta. Devuelve el consumo de la compaction (cuenta para el run).
   */
  private async manageContext(signal: AbortSignal): Promise<Usage> {
    const p = this.cfg.context;
    let used = this.contextTokens();
    if (used > p.clearAt * this.available) {
      const { count } = this.clearing.clearOld(this.messages, p.keepToolResults);
      if (count) {
        const after = this.contextTokens();
        this.emit({ t: "context", action: "cleared", count, before: used, after });
        used = after;
      }
    }
    if (used <= p.compactAt * this.available) return emptyUsage();
    try {
      return (await this.compact(signal)) ?? emptyUsage();
    } catch (e) {
      if (signal.aborted) throw e;
      this.emit({ t: "warning", message: `Compaction failed: ${errorMessage(e)}` });
      return emptyUsage();
    }
  }

  /**
   * Sustituye la conversación por un resumen escrito por el modelo. Un último prompt del usuario sin
   * tool_results se conserva literal detrás del resumen. Devuelve el consumo, o null si no había nada que compactar.
   */
  async compact(signal: AbortSignal = new AbortController().signal): Promise<Usage | null> {
    const last = this.messages.at(-1);
    const keep = last?.role === "user" && !last.content.some((b) => b.type === "tool_result") ? last : null;
    const history = this.clearing.view(keep ? this.messages.slice(0, -1) : this.messages);
    if (history.length === 0) return null;

    const tail = history.at(-1)!;
    const messages: Message[] =
      tail.role === "user"
        ? [...history.slice(0, -1), { role: "user", content: [...tail.content, { type: "text", text: COMPACT_PROMPT }] }]
        : [...history, { role: "user", content: [{ type: "text", text: COMPACT_PROMPT }] }];

    const before = this.contextTokens();
    const req = { ...this.buildRequest(), messages };
    let end: { message: Message; stopReason: StopReason; usage: Usage } | null = null;
    for await (const ev of this.deps.provider.stream(req, signal)) if (ev.t === "message_end") end = ev;
    if (!end) throw new Error("Provider stream ended without message_end");
    // Si el servidor recortó la propia petición, el resumen no parte de la conversación entera (y quizá ni de la tarea):
    // sustituirla por él borraría la historia. Mejor un error, que manageContext convierte en aviso.
    const sent = { tokens: end.usage.inputTokens + end.usage.cacheReadTokens + end.usage.cacheWriteTokens, estimate: estimateRequest(req) };
    if (looksTruncated(this.lastSample, sent, OVERFLOW_MIN_GROWTH_COMPACT)) {
      throw new Error(
        `the server truncated the compaction request (${sent.tokens} prompt tokens for an estimated ${sent.estimate}), so the summary would miss part of the conversation; ` +
          `the conversation was left as it was. Set the real context window with --context-window.`,
      );
    }
    // Un resumen cortado por max_tokens (o rechazado) no está completo: sustituir la historia por él perdería
    // restricciones y trabajo pendiente. Se deja la conversación como estaba.
    if (end.stopReason === "max_tokens" || end.stopReason === "refusal") {
      throw new Error(
        `the summary was not completed (stop reason: ${end.stopReason}, output limit ${req.maxTokens} tokens); the conversation was left as it was. ` +
          `Raise the context window or maxTokens so the summary fits.`,
      );
    }
    const summary = extractSummary(textOf(end.message));
    if (!summary) throw new Error("the model returned an empty or unterminated summary");

    const next = summaryMessage(summary);
    if (keep) next.content.push(...keep.content);
    this.messages.splice(0, this.messages.length, next);
    this.clearing.reset();
    this.measured = null;
    this.lastSample = null;
    this.emit({ t: "context", action: "compacted", before, after: this.contextTokens() });
    return end.usage;
  }

  /** Tope de un tool_result: el de la política, y nunca más del 20 % del espacio útil. */
  private get toolResultCap(): number {
    return Math.min(this.cfg.context.maxToolResultTokens, Math.floor(this.available * 0.2));
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

    // Permisos: el motor decide sobre la ruta real; `ask` pasa por el approver.
    const target = tool.permissionTarget(input, { workspace: this.deps.workspace });
    const decision = this.deps.policy.evaluate(call, target);
    let source: "policy" | "user" = "policy";
    let allowed = decision.kind === "allow";
    let denyMessage = `Permission denied: ${decision.reason}.`;
    if (decision.kind === "ask") {
      source = "user";
      const answer = await this.approvalLock.run(async (): Promise<ApprovalAnswer> => {
        // Las llamadas en paralelo se evalúan antes de que el usuario responda a la primera: si un «siempre» ya
        // cubre a esta, se reevalúa con las reglas de sesión actuales en lugar de volver a preguntar.
        const again = this.deps.policy.evaluate(call, target);
        if (again.kind === "allow") return { kind: "allow_once" };
        if (again.kind === "deny") return { kind: "deny", feedback: again.reason };
        this.emit({ t: "permission_request", call, reason: decision.reason });
        return this.deps.approver({ call, reason: decision.reason, suggestedRule: this.deps.policy.suggestRule(call, target) });
      });
      if (signal.aborted) return result(INTERRUPTED, true);
      allowed = answer.kind !== "deny";
      if (answer.kind === "allow_always") this.deps.policy.addSessionRule("allow", answer.rule);
      if (answer.kind === "deny")
        denyMessage = `The user denied this action${answer.feedback ? `: ${answer.feedback}` : "."} Do not retry it with another tool; ask the user how to proceed if needed.`;
    }
    this.emit({ t: "permission_decision", call, decision: allowed ? "allow" : "deny", source, reason: decision.reason });
    if (!allowed) return result(denyMessage, true);

    this.emit({ t: "tool_start", call });
    const t0 = Date.now();
    let out: ToolResultBlock;
    try {
      const searchable =
        target.access === "read" ? (p: string) => !this.deps.policy.hidesFromSearch(call.name, p, target.path) : undefined;
      const r = await tool.run(input, {
        workspace: this.deps.workspace,
        signal,
        fileState: this.fileState,
        callId: call.id,
        ...(searchable ? { searchable } : {}),
      });
      out = result(capToolResult(r.content, this.toolResultCap), !!r.isError);
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
