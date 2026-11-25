#!/usr/bin/env node
// Comprueba una ejecución de la demo de delegación: «Resume en una línea qué hace cada directorio de src/».
//
//   node examples/comprobar-delegacion.mjs respuesta.txt [traza.txt]
//
// `respuesta.txt` es lo que el harness escribió en stdout (la respuesta del modelo); `traza.txt`, lo que escribió en
// stderr. Acierta si la respuesta nombra los ocho directorios de src/. Con la traza, dice además cuántos ficheros
// distintos se leyeron con Read, los del principal y los de sus subagentes: un resumen que nombra todo sin leer nada
// sale de los nombres de los directorios, no del código.
import { readFileSync } from "node:fs";

const AREAS = ["plans", "policies", "config", "orders", "billing", "shipping", "customers", "notifications"];

const [answerFile, traceFile] = process.argv.slice(2);
if (!answerFile) {
  console.error("uso: node comprobar-delegacion.mjs <respuesta> [traza]");
  process.exit(2);
}
const answer = readFileSync(answerFile, "utf8").toLowerCase();
const missing = AREAS.filter((a) => !answer.includes(a));

let read = "";
if (traceFile) {
  // `> Read {...}` del principal y `  · explore·<id> > Read {...}` de un subagente.
  const files = new Set();
  for (const line of readFileSync(traceFile, "utf8").split("\n")) {
    const m = /> Read (\{.*\})$/.exec(line);
    if (!m) continue;
    try {
      const p = JSON.parse(m[1]).file_path;
      if (typeof p === "string") files.add(p.replace(/^.*?src\//, "src/"));
    } catch {
      // una línea recortada por la CLI (más de 100 caracteres) no se cuenta
    }
  }
  read = `; ${files.size} ficheros leídos`;
}
if (missing.length) {
  console.log(`fallo: no nombra ${missing.join(", ")}${read}`);
  process.exit(1);
}
console.log(`ok: nombra los ${AREAS.length} directorios${read}`);
