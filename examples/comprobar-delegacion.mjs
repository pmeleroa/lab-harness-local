#!/usr/bin/env node
// Comprueba la respuesta a la pregunta de la demo de delegación: el plazo de devolución del plan Pro y el fichero
// donde está ese número. Se le pasa el fichero con lo que el harness escribió en stdout (la respuesta del modelo).
//
//   node examples/comprobar-delegacion.mjs respuesta.txt
//
// Acierta si la respuesta dice 45 días y nombra src/config/limits.ts. No mira cómo llegó: eso está en la traza.
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("uso: node comprobar-delegacion.mjs <fichero con la respuesta>");
  process.exit(2);
}
const answer = readFileSync(file, "utf8");
const fallos = [];
if (!/\b45\b/.test(answer)) fallos.push("no dice 45 días");
if (!/config\/limits\.ts/.test(answer)) fallos.push("no nombra src/config/limits.ts");
if (fallos.length) {
  console.log(`fallo: ${fallos.join("; ")}`);
  process.exit(1);
}
console.log("ok: 45 días, en src/config/limits.ts");
