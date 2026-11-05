/**
 * Detección de una conversación recortada por el servidor.
 *
 * Un servidor como Ollama descarta lo más antiguo cuando la petición no cabe y responde HTTP 200 con un final
 * normal. Lo único que delata el recorte es el uso que informa: `prompt_tokens` deja de crecer aunque la
 * conversación sí. La proporción con la estimación sola no sirve (al desbordar queda en 0,6–0,9 con una conversación
 * que crece turno a turno, dentro del rango normal), así que la señal principal es el crecimiento entre peticiones.
 */

/** Lo medido en una petición: tokens que informó el servidor y estimación de lo que se envió. */
export interface RequestSample {
  tokens: number;
  estimate: number;
}

/** Por debajo de esta fracción del crecimiento estimado, el uso informado no ha crecido: el servidor ha recortado. */
export const OVERFLOW_GROWTH_RATIO = 0.1;
/** Crecimiento estimado mínimo (tokens) para fiarse de la señal; con menos, el ruido de la estimación domina. */
export const OVERFLOW_MIN_GROWTH = 200;
/**
 * Crecimiento mínimo para la petición de compaction: es el historial más la orden de resumir (unos cientos de tokens),
 * y justo ahí el recorte importa más, porque un resumen mal hecho sustituye a la conversación entera.
 */
export const OVERFLOW_MIN_GROWTH_COMPACT = 50;
/** Tamaño estimado mínimo (tokens) para aplicar la proporción a una primera petición, sin petición previa. */
export const OVERFLOW_MIN_FIRST = 500;

/**
 * ¿Salió recortada la petición `cur`? `prev` es la última petición que no lo estaba, si la conversación sigue
 * siendo la misma (sin compactar, limpiar ni cambiar de modelo desde entonces). Sin uso informado (0) no se decide.
 *
 * Límites conocidos: no ve un recorte con poco crecimiento (menos de OVERFLOW_MIN_GROWTH), ni uno en una primera
 * petición con un system prompt largo (sobrevive más y la proporción sube), ni el desplazamiento de contexto durante
 * la generación (el servidor informa el prompt entero); a este último lo previene la reserva de respuesta.
 */
export function looksTruncated(prev: RequestSample | null, cur: RequestSample, minGrowth = OVERFLOW_MIN_GROWTH): boolean {
  if (cur.tokens <= 0) return false;
  if (!prev) return cur.estimate >= OVERFLOW_MIN_FIRST && cur.tokens < OVERFLOW_GROWTH_RATIO * cur.estimate;
  const grown = cur.estimate - prev.estimate;
  return grown >= minGrowth && cur.tokens - prev.tokens < OVERFLOW_GROWTH_RATIO * grown;
}
