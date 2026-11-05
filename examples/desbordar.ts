/**
 * Provoca el desbordamiento de la ventana contra un servidor real y enseña qué devuelve.
 *
 * Envía siempre la misma conversación (generada con una semilla fija, texto realista) y mucho más larga que una
 * ventana de 4.096 tokens. La clave del system prompt y la del último mensaje caben; la de la tarea, que está al
 * principio, es lo primero que descarta un servidor que recorta. No pasa por el loop: usa el adaptador tal cual,
 * para ver lo que el loop recibiría.
 *
 *   npx tsx examples/desbordar.ts [--base-url http://localhost:11434/v1] [--model qwen2.5:7b]
 */
import { parseArgs } from "node:util";
import { estimateRequest } from "../src/context/manager.js";
import type { CanonicalRequest, Message } from "../src/providers/canonical.js";
import { OpenAIProvider } from "../src/providers/openai.js";

const { values } = parseArgs({ options: { "base-url": { type: "string" }, model: { type: "string" } } });
const baseURL = values["base-url"] ?? process.env.OPENAI_BASE_URL ?? "http://localhost:11434/v1";
const model = values.model ?? process.env.HARNESS_MODEL ?? "qwen2.5:7b";

const SYSTEM_KEY = "ALFA-3141";
const TASK_KEY = "BRAVO-2718";

/** Generador con semilla (mulberry32): la misma conversación en cada ejecución. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = rng(20261105);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const num = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));

const modulos = ["facturación", "inventario", "pedidos", "envíos", "devoluciones", "catálogo", "pagos", "notificaciones"];
const frases = [
  () => `El módulo de ${pick(modulos)} tarda ${num(180, 2400)} ms en responder cuando hay más de ${num(40, 400)} peticiones en cola.`,
  () => `Hemos revisado el ticket ${pick(["PED", "FAC", "ENV"])}-${num(1000, 9999)} y el fallo solo aparece con importes superiores a ${num(50, 900)} EUR.`,
  () => `La migración de ${pick(modulos)} se aplazó al sprint ${num(14, 31)} porque falta cerrar ${num(2, 9)} casos de prueba.`,
  () => `En el despliegue del ${num(1, 28)} de ${pick(["marzo", "abril", "mayo", "junio", "septiembre"])} hubo ${num(1, 6)} reintentos en ${pick(modulos)} y ninguna pérdida de datos.`,
  () => `Se acordó que ${pick(["Marta", "Iván", "Lucía", "Andrés", "Noelia"])} revise el índice de ${pick(modulos)} antes del jueves.`,
  () => `La caché de ${pick(modulos)} se invalida cada ${num(5, 60)} minutos; propusimos subirlo a ${num(61, 240)} y medir el efecto.`,
  () => `El informe de errores muestra ${num(3, 120)} excepciones por hora en ${pick(modulos)}, la mayoría por tiempos de espera.`,
  () => `Queda pendiente documentar cómo se reintenta una petición de ${pick(modulos)} si el proveedor responde con un 503.`,
];

const parrafo = () => Array.from({ length: num(6, 9) }, () => pick(frases)()).join(" ");
const nota = (n: number) => `Notas de la reunión ${n}:\n\n${parrafo()}\n\n${parrafo()}\n\n${parrafo()}`;

const mensajes: Message[] = [{ role: "user", content: [{ type: "text", text: `Vamos a repasar unas notas de reuniones. Al final te pediré dos claves. La clave de la tarea es ${TASK_KEY}.` }] }];
for (let i = 1; i <= 12; i++) {
  mensajes.push({ role: "assistant", content: [{ type: "text", text: "Entendido." }] });
  mensajes.push({ role: "user", content: [{ type: "text", text: nota(i) }] });
}
mensajes.push({ role: "assistant", content: [{ type: "text", text: "Entendido." }] });
mensajes.push({ role: "user", content: [{ type: "text", text: "Ahora responde solo con dos datos: la clave de la tarea y la clave del sistema." }] });

const req: CanonicalRequest = {
  model,
  system: [{ text: `Eres un asistente de revisión de notas. La clave del sistema es ${SYSTEM_KEY}. Responde de forma breve.` }],
  tools: [],
  messages: mensajes,
  maxTokens: 256,
};

let status = 0;
const provider = new OpenAIProvider({
  baseURL,
  fetch: async (input, init) => {
    const res = await fetch(input, init);
    status = res.status;
    return res;
  },
});

const t0 = Date.now();
let end: { text: string; stop: string; promptTokens: number; cachedTokens: number; outputTokens: number } | undefined;
for await (const ev of provider.stream(req, new AbortController().signal)) {
  if (ev.t === "message_end") {
    const text = ev.message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    // El adaptador separa lo que el servidor ya tenía en caché del resto; el `prompt_tokens` del servidor es la suma.
    end = { text, stop: ev.stopReason, promptTokens: ev.usage.inputTokens + ev.usage.cacheReadTokens, cachedTokens: ev.usage.cacheReadTokens, outputTokens: ev.usage.outputTokens };
  }
}
const seconds = ((Date.now() - t0) / 1000).toFixed(1);
if (!end) throw new Error("el servidor no devolvió un mensaje");

console.log(`modelo: ${model}`);
console.log(`conversación: ${mensajes.length} mensajes, unos ${estimateRequest(req)} tokens estimados (4 caracteres por token)`);
console.log(`HTTP ${status} · final: ${end.stop} · prompt_tokens: ${end.promptTokens} (${end.cachedTokens} en caché) · salida: ${end.outputTokens} · ${seconds} s`);
console.log(`respuesta: ${end.text.trim()}`);
console.log(`clave del sistema (${SYSTEM_KEY}): ${end.text.includes(SYSTEM_KEY) ? "aparece" : "no aparece"}`);
console.log(`clave de la tarea (${TASK_KEY}): ${end.text.includes(TASK_KEY) ? "aparece" : "no aparece"}`);
