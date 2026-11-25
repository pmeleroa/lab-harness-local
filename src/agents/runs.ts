import type { RunEndReason } from "../core/events.js";
import type { Usage } from "../providers/canonical.js";

/** Una ejecución de subagente en esta sesión: lo que consumió aparte y lo poco que devolvió al principal. */
export interface SubagentRun {
  id: string;
  type: string;
  description: string;
  reason: RunEndReason;
  turns: number;
  toolCalls: number;
  usage: Usage;
  durationMs: number;
  /** Mayor contexto que ocupó su conversación: vive aparte, no en la del agente principal. */
  peakContext: number;
  /** Tokens (estimados) de su informe: lo único que entra en el contexto del principal. */
  reportTokens: number;
}

/** Limita cuántos subagentes corren a la vez: el resto espera turno en orden de llegada. */
export class Semaphore {
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiting.push(r));
    else this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }
}
