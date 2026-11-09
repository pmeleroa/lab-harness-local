import type { ToolResultBlock, ToolUseBlock, Usage } from "../providers/canonical.js";

export type AgentState = "idle" | "awaiting_model" | "executing_tools" | "done" | "aborted" | "error";

/**
 * Único stream de salida del agente. La CLI y los tests consumen exactamente los mismos
 * eventos: ninguna interfaz accede al estado interno del loop.
 */
export type AgentEvent =
  | { t: "state"; state: AgentState }
  | { t: "text_delta"; text: string }
  | { t: "tool_start"; call: ToolUseBlock }
  /** El motor decidió `ask` y se le pregunta al usuario. */
  | { t: "permission_request"; call: ToolUseBlock; reason: string }
  /** Resultado final de los permisos para esta llamada; `source` dice quién decidió. */
  | { t: "permission_decision"; call: ToolUseBlock; decision: "allow" | "deny"; source: "policy" | "user"; reason: string }
  | { t: "tool_end"; call: ToolUseBlock; result: ToolResultBlock; durationMs: number }
  /** `truncated`: el servidor recortó la conversación; su uso no sirve para calibrar el contexto. */
  | { t: "turn_end"; turn: number; usage: Usage; truncated?: boolean }
  /** El loop liberó contexto: limpió `count` tool_results antiguos o compactó la conversación. En tokens. */
  | { t: "context"; action: "cleared" | "compacted"; before: number; after: number; count?: number }
  | { t: "warning"; message: string }
  | { t: "run_end"; reason: RunEndReason; usage: Usage; turns: number };

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
