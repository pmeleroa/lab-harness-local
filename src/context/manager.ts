import type { Block, CanonicalRequest, Message, ToolResultBlock } from "../providers/canonical.js";
import { truncateMiddle } from "../tools/types.js";

/**
 * Gestión del contexto en tres escalones, de más barato a más caro:
 *  1. Tope por tokens a cada tool_result, al producirlo.
 *  2. Clearing: el contenido de los tool_result antiguos se sustituye por una nota (la llamada se conserva).
 *  3. Compaction: el modelo resume la conversación y el resumen la sustituye entera.
 *
 * Sin tokenizador local: se estima con ~4 caracteres/token y se calibra con el uso real del último turno.
 */

export interface ContextPolicy {
  /** Tope de un tool_result, en tokens. Además, nunca más del 20 % del espacio útil de la ventana. */
  maxToolResultTokens: number;
  /** Fracción del espacio útil (ventana - maxTokens) a partir de la cual se limpian tool_results antiguos. */
  clearAt: number;
  /** Fracción a partir de la cual se compacta (si el clearing no ha bastado). */
  compactAt: number;
  /** Los tool_result más recientes que nunca se limpian. */
  keepToolResults: number;
}

export const defaultContextPolicy: ContextPolicy = {
  maxToolResultTokens: 25_000,
  clearAt: 0.6,
  compactAt: 0.85,
  keepToolResults: 6,
};

export const CHARS_PER_TOKEN = 4;
export const estimateText = (s: string): number => Math.ceil(s.length / CHARS_PER_TOKEN);

export function estimateBlock(b: Block): number {
  switch (b.type) {
    case "text":
      return estimateText(b.text);
    case "tool_use":
      return estimateText(b.name + JSON.stringify(b.input));
    case "tool_result":
      return estimateText(b.content);
  }
}

export const estimateMessages = (ms: Message[]): number =>
  ms.reduce((n, m) => n + m.content.reduce((k, b) => k + estimateBlock(b), 0), 0);

export const estimateRequest = (req: CanonicalRequest): number =>
  estimateMessages(req.messages) +
  req.system.reduce((n, p) => n + estimateText(p.text), 0) +
  req.tools.reduce((n, t) => n + estimateText(JSON.stringify(t)), 0);

/** Recorta un tool_result a `maxTokens`, conservando cabeza y cola. */
export function capToolResult(content: string, maxTokens: number): string {
  if (estimateText(content) <= maxTokens) return content;
  return truncateMiddle(content, maxTokens * CHARS_PER_TOKEN);
}

export const CLEARED_NOTE = "[Old tool result cleared to save context. Run the tool again if you need this output.]";

/** Por debajo de esto no compensa limpiar: la nota ocuparía casi lo mismo. */
const MIN_CLEARABLE_TOKENS = 100;

/**
 * Los tool_result limpiados. El conjunto solo crece: entre dos limpiezas el prefijo de la conversación no
 * cambia y la caché de prompt sigue sirviendo. No se persiste: al retomar, la primera llamada vuelve a limpiar.
 */
export class ToolResultClearing {
  private readonly cleared = new Set<string>();

  get size(): number {
    return this.cleared.size;
  }

  reset(): void {
    this.cleared.clear();
  }

  /** La conversación tal como se envía: los resultados limpiados, sustituidos por la nota. */
  view(messages: Message[]): Message[] {
    if (!this.cleared.size) return messages;
    return messages.map((m) =>
      m.role === "user" && m.content.some((b) => b.type === "tool_result" && this.cleared.has(b.tool_use_id))
        ? { role: m.role, content: m.content.map((b) => (b.type === "tool_result" && this.cleared.has(b.tool_use_id) ? cleared(b) : b)) }
        : m,
    );
  }

  /**
   * Limpia todos los resultados salvo los `keep` más recientes. Todos de una vez (no uno a uno) para romper la
   * caché lo menos posible. Devuelve cuántos ha limpiado y los tokens estimados que libera.
   */
  clearOld(messages: Message[], keep: number): { count: number; freed: number } {
    const results = messages.flatMap((m) => m.content.filter((b): b is ToolResultBlock => b.type === "tool_result"));
    const candidates = results.slice(0, Math.max(0, results.length - keep));
    let count = 0;
    let freed = 0;
    for (const r of candidates) {
      if (this.cleared.has(r.tool_use_id)) continue;
      const tokens = estimateText(r.content);
      if (tokens < MIN_CLEARABLE_TOKENS) continue;
      this.cleared.add(r.tool_use_id);
      count++;
      freed += tokens - estimateText(CLEARED_NOTE);
    }
    return { count, freed };
  }
}

const cleared = (b: ToolResultBlock): ToolResultBlock => ({ ...b, content: CLEARED_NOTE });

export const COMPACT_PROMPT = `Your context window is almost full, so this conversation is about to be replaced by a summary that you write now.
Write it for yourself: after this, the summary is all you will remember. Do not call any tools. Include:
1. The user's requests and goals, quoting their exact words when they matter, and any constraint or preference they stated.
2. What has been done so far: files read, created or changed (with paths) and the key decisions and why.
3. Errors found and how they were fixed, and anything that did not work.
4. The current state: what is in progress right now and the exact next steps to finish the task.
5. Facts you will need again (names, commands, versions, values) so you do not have to look them up.
Reply only with the summary, inside <summary></summary> tags.`;

/** El mensaje que sustituye a la conversación tras compactar. */
export function summaryMessage(summary: string): Message {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `<conversation_summary>\nThe earlier conversation was compacted to free context. This is your summary of it:\n\n${summary}\n</conversation_summary>\n\nContinue from where you left off; if the task was finished, wait for the user's next request.`,
      },
    ],
  };
}

export function extractSummary(text: string): string {
  // Una etiqueta abierta y sin cerrar es un resumen cortado: no vale como resumen.
  if (/<summary>/.test(text) && !/<summary>[\s\S]*?<\/summary>/.test(text)) return "";
  const m = /<summary>([\s\S]*?)<\/summary>/.exec(text);
  return (m ? m[1]! : text).trim();
}
