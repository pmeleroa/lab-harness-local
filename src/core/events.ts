import type { ToolResultBlock, ToolUseBlock, Usage } from "../providers/canonical.js";
import type { TaskKind, TaskStatus } from "./background.js";

export type AgentState = "idle" | "awaiting_model" | "executing_tools" | "done" | "aborted" | "error";

/** Quién emite un evento cuando no es el agente principal: un subagente lanzado con la tool Agent. */
export interface AgentRef {
  /** Id corto del subagente (8 caracteres). */
  id: string;
  /** Tipo de subagente: explore, general o uno definido en .harness/agents. */
  type: string;
  /**
   * Lanzado con run_in_background: corre fuera de cualquier turno del principal, y las interfaces no intercalan
   * sus tools (su resultado llega como aviso).
   */
  background?: boolean;
}

/**
 * Único stream de salida del agente. La CLI y los tests consumen exactamente los mismos
 * eventos: ninguna interfaz accede al estado interno del loop.
 * Los eventos de un subagente llegan al mismo bus con `agent`; los del principal, sin él.
 */
export type AgentEvent = AgentEventBody & { agent?: AgentRef };

export type AgentEventBody =
  | { t: "state"; state: AgentState }
  | { t: "text_delta"; text: string }
  | { t: "tool_start"; call: ToolUseBlock }
  /** El motor decidió `ask` y se le pregunta al usuario. */
  | { t: "permission_request"; call: ToolUseBlock; reason: string }
  /** Resultado final de los permisos para esta llamada; `source` dice quién decidió. */
  | { t: "permission_decision"; call: ToolUseBlock; decision: "allow" | "deny"; source: "policy" | "user"; reason: string }
  | { t: "tool_end"; call: ToolUseBlock; result: ToolResultBlock; durationMs: number }
  /** Un hook PreToolUse bloqueó la llamada: no se pidió permiso ni se ejecutó. `message` es lo que recibe el modelo. */
  | { t: "hook_blocked"; call: ToolUseBlock; message: string }
  /** `truncated`: el servidor recortó la conversación; su uso no sirve para calibrar el contexto. */
  | { t: "turn_end"; turn: number; usage: Usage; truncated?: boolean }
  /** El loop liberó contexto: limpió `count` tool_results antiguos o compactó la conversación. En tokens. */
  | { t: "context"; action: "cleared" | "compacted"; before: number; after: number; count?: number }
  | { t: "warning"; message: string }
  | { t: "task_start"; id: string; kind: TaskKind; description: string }
  | { t: "task_end"; id: string; kind: TaskKind; status: TaskStatus; durationMs: number; summary: string; exitCode?: number | null }
  | { t: "run_end"; reason: RunEndReason; usage: Usage; turns: number }
  | { t: "subagent_start"; id: string; type: string; description: string; toolUseId: string; background?: true }
  | {
      t: "subagent_end";
      id: string;
      type: string;
      toolUseId: string;
      background?: true;
      reason: RunEndReason;
      usage: Usage;
      turns: number;
      toolCalls: number;
      durationMs: number;
      /** Mayor contexto que llegó a ocupar su conversación (entrada + salida de un turno). */
      peakContext: number;
    };

export type RunEndReason =
  /** El modelo respondió sin pedir más herramientas. */
  | "end_turn"
  /** La respuesta se cortó por el tope de tokens de salida. */
  | "max_tokens"
  | "refusal"
  | "aborted"
  /** Se agotaron los turnos del run. */
  | "max_turns"
  | "max_tool_calls"
  /** La misma llamada falló N veces seguidas: el modelo está atascado. */
  | "repeated_failure"
  /** El servidor recortó la conversación y respondió con normalidad: lo respondido no parte de la tarea. */
  | "context_overflow"
  /** El modelo terminó sin texto ni tool call, también tras avisarle. */
  | "empty_response"
  | "error";

export type Listener = (e: AgentEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();

  /** Bus para un subagente: lo que emite llega a este bus etiquetado con su `agent`. */
  child(agent: AgentRef): EventBus {
    const bus = new EventBus();
    bus.on((e) => this.emit({ ...e, agent }));
    return bus;
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  emit(e: AgentEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // Un consumidor roto (p. ej. la salida por terminal) nunca debe tumbar el loop.
      }
    }
  }
}
