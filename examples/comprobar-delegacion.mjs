#!/usr/bin/env node
// Comprueba una ejecución de la demo de delegación: leer seis ficheros de examples/delegacion y resumir en una línea
// qué hace cada uno.
//
//   node examples/comprobar-delegacion.mjs respuesta.txt traza.txt
//
// `respuesta.txt` es lo que el harness escribió en stdout (la respuesta del modelo); `traza.txt`, lo que escribió en
// stderr. Acierta si la respuesta nombra los seis ficheros y la traza muestra que se leyeron enteros con Read, el
// principal o sus subagentes: un resumen que nombra todo sin leerlo (o tras leer la primera línea) sale de los
// nombres, no del código. Entero es sin `offset` y sin `limit`, o con un `limit` que cubre el fichero (todos tienen
// menos de 80 líneas).
//
// Una lectura cuenta solo si consta que terminó bien. La CLI escribe `> Read` al empezar, antes de saber si el
// fichero existe, así que cada ruta se resuelve contra el `workspace:` de la cabecera de la traza y tiene que ser
// exactamente uno de los seis, y el turno en que se pidió tiene que haber terminado sin errores: en el principal, con
// un `ok` por cada llamada; en un subagente, que no enseña los `ok`, sin ninguna línea de error y con su turno
// cerrado. Las salidas de un turno no dicen a qué llamada corresponden, así que ante un error no cuenta ninguna
// lectura de ese turno.
import { readFileSync } from "node:fs";
import path from "node:path";

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

const trace = readFileSync(traceFile, "utf8").split("\n");
const workspace = trace.map((l) => /^workspace: (.+)$/.exec(l)?.[1]).find(Boolean);
if (!workspace) {
  console.log("fallo: la traza no tiene la línea «workspace:» de la cabecera");
  process.exit(1);
}

/** La ruta de una lectura entera, relativa al workspace, o null si no es una lectura entera o no se puede leer. */
const wholeRead = (json) => {
  try {
    const { file_path: p, offset, limit } = JSON.parse(json);
    const whole = (offset === undefined || offset <= 1) && (limit === undefined || limit >= 80);
    return typeof p === "string" && whole ? path.relative(workspace, path.resolve(workspace, p)) : null;
  } catch {
    return null; // una línea recortada por la CLI (más de 100 caracteres) no se cuenta
  }
};

// Un turno por agente: del `ctx` en que acaba la respuesta del modelo hasta el siguiente (o el fin del subagente).
// En él van sus llamadas y sus resultados.
const read = new Set();
const turns = new Map(); // agente ("" el principal) -> { reads, calls, oks, errors }
const open = (who) => turns.set(who, { reads: [], calls: 0, oks: 0, errors: 0 });
const close = (who) => {
  const t = turns.get(who);
  turns.delete(who);
  if (!t || t.errors) return;
  // El principal enseña un `ok` por llamada; un subagente solo enseña los errores.
  if (who === "" && t.oks !== t.calls) return;
  for (const f of t.reads) read.add(f);
};
for (const line of trace) {
  const sub = /^  · (\S+) (.*)$/.exec(line);
  if (sub) {
    const [, who, rest] = sub;
    if (rest.startsWith("ctx ")) {
      close(who);
      open(who);
    } else if (/^ {2}error: |^x bloqueado/.test(rest)) {
      if (turns.has(who)) turns.get(who).errors++;
    } else {
      const m = /^> Read (\{.*\})$/.exec(rest);
      const f = m && wholeRead(m[1]);
      if (f && turns.has(who)) turns.get(who).reads.push(f);
    }
    continue;
  }
  const end = /^ {2}< (\S+) /.exec(line);
  if (end) {
    close(end[1]);
    continue;
  }
  const main = turns.get("");
  if (line.startsWith("ctx ") || /^\[\w+\] \d+ turnos/.test(line)) {
    close("");
    open("");
  } else if (!main) {
    continue;
  } else if (line.startsWith("x bloqueado por un hook")) {
    // El hook paró la llamada de la línea anterior: ni empezó ni tendrá `ok`.
    main.calls--;
    main.reads.pop();
  } else if (/^ {2}ok \(\d+ ms/.test(line)) {
    main.oks++;
  } else if (/^ {2}error \(\d+ ms/.test(line)) {
    main.errors++;
  } else if (line.startsWith("> ") && !line.startsWith("> Agent ")) {
    main.calls++;
    const m = /^> Read (\{.*\})$/.exec(line);
    const f = m && wholeRead(m[1]);
    if (f) main.reads.push(f);
  }
}
const unread = FILES.filter((f) => !read.has(f));

const fallos = [];
if (unnamed.length) fallos.push(`no nombra ${unnamed.join(", ")}`);
if (unread.length) fallos.push(`no leyó enteros ${unread.join(", ")}`);
if (fallos.length) {
  console.log(`fallo: ${fallos.join("; ")}`);
  process.exit(1);
}
console.log(`ok: nombra los ${FILES.length} ficheros y los leyó enteros`);
