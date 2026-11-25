#!/usr/bin/env node
// Comprueba una ejecución de la demo de delegación: leer seis ficheros de examples/delegacion y resumir en una línea
// qué hace cada uno.
//
//   node examples/comprobar-delegacion.mjs respuesta.txt traza.txt
//
// `respuesta.txt` es lo que el harness escribió en stdout (la respuesta del modelo); `traza.txt`, lo que escribió en
// stderr. Acierta si la respuesta nombra los seis ficheros y la traza muestra que se leyeron los seis con Read, el
// principal o sus subagentes: un resumen que nombra todo sin leerlo sale de los nombres, no del código.
import { readFileSync } from "node:fs";

export const FILES = [
  "src/orders/refunds.ts",
  "src/orders/checkout.ts",
  "src/billing/invoices.ts",
  "src/billing/taxes.ts",
  "src/shipping/rates.ts",
  "src/shipping/zones.ts",
];

const [answerFile, traceFile] = process.argv.slice(2);
if (!answerFile || !traceFile) {
  console.error("uso: node comprobar-delegacion.mjs <respuesta> <traza>");
  process.exit(2);
}
const answer = readFileSync(answerFile, "utf8").toLowerCase();
// Basta el nombre del fichero (refunds.ts o refunds): el modelo no siempre repite la ruta entera.
const unnamed = FILES.filter((f) => !answer.includes(f.split("/").pop().replace(/\.ts$/, "")));

// `> Read {...}` del principal y `  · explore·<id> > Read {...}` de un subagente.
const read = new Set();
for (const line of readFileSync(traceFile, "utf8").split("\n")) {
  const m = /> Read (\{.*\})$/.exec(line);
  if (!m) continue;
  try {
    const p = JSON.parse(m[1]).file_path;
    if (typeof p === "string") read.add(p.replace(/^.*?src\//, "src/"));
  } catch {
    // una línea recortada por la CLI (más de 100 caracteres) no se cuenta
  }
}
const unread = FILES.filter((f) => !read.has(f));

const fallos = [];
if (unnamed.length) fallos.push(`no nombra ${unnamed.join(", ")}`);
if (unread.length) fallos.push(`no leyó ${unread.join(", ")}`);
if (fallos.length) {
  console.log(`fallo: ${fallos.join("; ")}`);
  process.exit(1);
}
console.log(`ok: nombra y leyó los ${FILES.length} ficheros`);
