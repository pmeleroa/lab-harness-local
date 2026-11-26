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
import type { HookRunner } from "../hooks/runner.js";
import type { Decision, PolicyEngine } from "../policy/engine.js";
import type { SessionRecord, SessionStore } from "../session/jsonl-store.js";
import { FileStateCache } from "../tools/file-state.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { AgentEvent, AgentRef, AgentState, EventBus, RunEndReason } from "./events.js";

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
  /** El subagente que pide permiso; ausente si es el agente principal. */
  agent?: AgentRef;
}

export type Approver = (req: ApprovalRequest) => Promise<ApprovalAnswer>;

/** Sin terminal (CI, `< /dev/null`): todo lo que requiera confirmación se deniega. Fallar cerrado. */
export const denyAllApprover: Approver = async () => ({ kind: "deny", feedback: "No interactive user available." });

/**
 * Un solo prompt de permiso a la vez, aunque las herramientas de lectura (o varios subagentes) corran en paralelo.
 * El agente principal y sus subagentes comparten el mismo lock.
 */
export class ApprovalLock {
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
  /** Avisos de tareas en segundo plano que han terminado: se entregan antes de la siguiente llamada al modelo. */
  notifications?: { drain(): Block[] };
  /** Hooks PreToolUse y PostToolUse, dentro del sandbox. */
  hooks?: HookRunner;
  /** Compartido con los subagentes para que sus prompts de permiso no se pisen. */
  approvalLock?: ApprovalLock;
  /** Identidad del agente si es un subagente (va en las peticiones de permiso). */
  ref?: AgentRef;
  /** Transcript: cada mensaje, uso, compactación y decisión de permisos, en el orden en que pasan. */
  session: SessionStore;
}

export interface RunResult {
  reason: RunEndReason;
  /** Texto del último mensaje del asistente. */
  text: string;
  usage: Usage;
  turns: number;
  toolCalls: number;
  /** Mayor contexto ocupado en un turno de este run (entrada + salida). */
  peakContext: number;
  error?: string;
}

const INTERRUPTED = "Interrupted by user before this tool ran.";

/** Parte de la ventana que como máximo se reserva para la respuesta. */
const RESERVE_FRACTION = 0.25;

export class Agent {
  readonly messages: Message[] = [];

  /** La historia tal como la ve el modelo: con los tool_result limpiados sustituidos por la nota. */
  get visibleMessages(): Message[] {
    return this.clearing.view(this.messages);
  }
  private _state: AgentState = "idle";
  private readonly clearing = new ToolResultClearing();
  /** Tokens reales de la última petición y lo que estimábamos de ella: calibra la estimación de lo añadido después. */
  private measured: { tokens: number; estimate: number } | null = null;
  /** La última petición que el servidor no recortó: base para detectar que la siguiente sí lo ha sido. */
  private lastSample: RequestSample | null = null;

  /** Lo que el modelo ha leído en este run: Edit y Write lo exigen antes de modificar un fichero. */
  private fileState = new FileStateCache();
  private readonly approvalLock: ApprovalLock;

  constructor(
    private deps: AgentDeps,
    private cfg: AgentConfig,
  ) {
    this.approvalLock = deps.approvalLock ?? new ApprovalLock();
  }

  get state(): AgentState {
    return this._state;
  }

  /**
   * Sustituye la conversación y el destino del transcript (resume). Solo con el agente parado:
   * a mitad de un run() dejaría la conversación inconsistente.
   */
  restore(messages: Message[], session: SessionStore): void {
    if (this._state !== "idle" && this._state !== "done" && this._state !== "aborted" && this._state !== "error")
      throw new Error(`Cannot restore a session while the agent is ${this._state}.`);
    this.messages.splice(0, this.messages.length, ...messages);
    this.deps.session = session;
    this.clearing.reset();
    this.measured = null;
    this.lastSample = null;
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
  async run(prompt: string | Block[], signal: AbortSignal = new AbortController().signal): Promise<RunResult> {
    // Bloques en lugar de texto: los avisos de subagentes en segundo plano, como prompt de un run más (headless).
    const content: Block[] = typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt;
    this.pushUser(content);

    const failures = new Map<string, number>();
    let usage = emptyUsage();
    let toolCalls = 0;
    let peakContext = 0;
    let lastText = "";
    let retriedEmpty = false;

    const end = (reason: RunEndReason, turns: number, error?: string): RunResult => {
      this.setState(reason === "aborted" ? "aborted" : reason === "error" ? "error" : "done");
      this.emit({ t: "run_end", reason, usage, turns });
      return { reason, text: lastText, usage, turns, toolCalls, peakContext, ...(error ? { error } : {}) };
    };

    for (let turn = 1; turn <= this.cfg.maxTurns; turn++) {
      if (signal.aborted) return end("aborted", turn - 1);

      // 1. Modelo, con los avisos de tareas en segundo plano entregados
      this.deliverNotifications();
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
        const u = res.usage;
        peakContext = Math.max(peakContext, u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.outputTokens);
        this.emit({ t: "turn_end", turn, usage: res.usage, ...(res.truncated ? { truncated: true } : {}) });
        this.deps.session.append({ type: "usage", ts: now(), turn, usage: res.usage });
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
      this.deps.session.append({ type: "message", ts: now(), message: assistant });
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
    // La historia anterior no se borra del transcript: este registro dice que, desde aquí, se empieza por el resumen.
    this.deps.session.append({ type: "compact", ts: now(), summary, ...(keep ? { kept: keep } : {}) });
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

    // Hooks antes de permisos: un bloqueo no llega a preguntar al usuario.
    const notes: string[] = [];
    if (this.deps.hooks && !this.deps.hooks.empty) {
      const pre = await this.deps.hooks.run("PreToolUse", { tool: call.name, input }, signal);
      if (pre.block) {
        this.emit({ t: "hook_blocked", call, message: pre.message });
        // El hook va antes que el motor: no hay decisión de permisos, la decisión es del hook.
        this.recordApproval(call, { decision: "deny", origin: "hook", reason: pre.message });
        return result(pre.message, true);
      }
      // Si se canceló mientras corría el hook, el runner lo mata y no bloquea: no se sigue hacia los permisos ni la tool.
      if (signal.aborted) return result(INTERRUPTED, true);
      notes.push(...pre.notes);
    }
    const withNotes = (r: ToolResultBlock): ToolResultBlock =>
      notes.length ? { ...r, content: `${String(r.content)}\n\n${notes.join("\n")}` } : r;

    // Permisos: el motor decide sobre la ruta real; `ask` pasa por el approver.
    const target = tool.permissionTarget(input, { workspace: this.deps.workspace });
    const decision = this.deps.policy.evaluate(call, target);
    let source: "policy" | "user" = "policy";
    let allowed = decision.kind === "allow";
    let denyMessage = `Permission denied: ${decision.reason}.`;
    if (decision.kind === "ask") {
      const settled = await this.approvalLock.run(async (): Promise<{ by: "policy"; decision: Decision } | { by: "user"; answer: ApprovalAnswer }> => {
        // Las llamadas en paralelo se evalúan antes de que el usuario responda a la primera: si un «siempre» ya
        // cubre a esta, se reevalúa con las reglas de sesión actuales en lugar de volver a preguntar. Entonces no
        // decide el usuario, sino la regla que creó.
        const again = this.deps.policy.evaluate(call, target);
        if (again.kind !== "ask") return { by: "policy", decision: again };
        this.emit({ t: "permission_request", call, reason: decision.reason });
        const answer = await this.deps.approver({
          call,
          reason: decision.reason,
          suggestedRule: this.deps.policy.suggestRule(call, target),
          ...(this.deps.ref ? { agent: this.deps.ref } : {}),
        });
        return { by: "user", answer };
      });
      if (signal.aborted) return result(INTERRUPTED, true);
      if (settled.by === "policy") {
        const again = settled.decision;
        allowed = again.kind === "allow";
        if (!allowed) denyMessage = `Permission denied: ${again.reason}.`;
        this.recordApproval(call, fromDecision(again));
      } else {
        const { answer } = settled;
        source = "user";
        allowed = answer.kind !== "deny";
        if (answer.kind === "allow_always") this.deps.policy.addSessionRule("allow", answer.rule);
        if (answer.kind === "deny")
          denyMessage = `The user denied this action${answer.feedback ? `: ${answer.feedback}` : "."} Do not retry it with another tool; ask the user how to proceed if needed.`;
        this.recordApproval(call, {
          decision: allowed ? "allow" : "deny",
          origin: "user",
          reason: decision.reason,
          answer: answer.kind === "allow_once" ? "once" : answer.kind === "allow_always" ? "always" : "no",
          ...(answer.kind === "allow_always" ? { rule: answer.rule } : {}),
          ...(answer.kind === "deny" && answer.feedback ? { feedback: answer.feedback } : {}),
        });
      }
    } else {
      this.recordApproval(call, fromDecision(decision));
    }
    this.emit({ t: "permission_decision", call, decision: allowed ? "allow" : "deny", source, reason: decision.reason });
    if (!allowed) return withNotes(result(denyMessage, true));

    this.emit({ t: "tool_start", call });
    const t0 = Date.now();
    let out: ToolResultBlock;
    try {
      const searchable =
        target.kind === "path" && target.access === "read"
          ? (p: string) => !this.deps.policy.hidesFromSearch(call.name, p, target.path)
          : undefined;
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
    if (this.deps.hooks && !this.deps.hooks.empty) {
      const post = await this.deps.hooks.run(
        "PostToolUse",
        { tool: call.name, input, result: { content: String(out.content), isError: !!out.is_error } },
        signal,
      );
      notes.push(...post.notes);
    }
    out = withNotes(out);
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

  /** Una línea `approval` por decisión, entre el tool_use y su tool_result: quién decidió y por qué. */
  private recordApproval(call: ToolUseBlock, d: Omit<Extract<SessionRecord, { type: "approval" }>, "type" | "ts" | "toolUseId" | "tool">): void {
    this.deps.session.append({ type: "approval", ts: now(), toolUseId: call.id, tool: call.name, ...d });
  }

  /** Siempre hay un mensaje de usuario al final cuando se llama: el prompt, los tool_result o el aviso de respuesta vacía. */
  private deliverNotifications(): void {
    const blocks = this.deps.notifications?.drain() ?? [];
    if (blocks.length) this.pushUser(blocks, true);
  }

  /** La API exige alternancia: bloques de usuario consecutivos se fusionan en un mensaje. */
  private pushUser(content: Block[], notice = false): void {
    const last = this.messages.at(-1);
    if (last?.role === "user") last.content.push(...content);
    else this.messages.push({ role: "user", content: [...content] });
    this.deps.session.append({ type: "message", ts: now(), message: { role: "user", content }, ...(notice ? { notice: true as const } : {}) });
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

const now = () => new Date().toISOString();

/** Una decisión del motor tal como va al registro `approval` (un `ask` nunca llega aquí: lo decide el usuario). */
function fromDecision(d: Decision) {
  return {
    decision: d.kind === "allow" ? ("allow" as const) : ("deny" as const),
    origin: d.origin,
    reason: d.reason,
    ...(d.rule ? { rule: d.rule } : {}),
    ...(d.ruleSource ? { ruleSource: d.ruleSource } : {}),
  };
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
