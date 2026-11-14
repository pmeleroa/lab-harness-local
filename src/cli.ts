#!/usr/bin/env node
import readline from "node:readline/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { type Approver, denyAllApprover } from "./core/loop.js";
import { createHarness } from "./index.js";
import { ttyApprover } from "./policy/approver.js";
import type { PermissionMode } from "./policy/engine.js";
import { PERMISSION_MODES, loadSettings } from "./policy/settings.js";
import type { AgentEvent } from "./core/events.js";
import { VERSION } from "./version.js";

const HELP = `lab-harness-local ${VERSION}: un harness para agentes de código en terminal

Uso: npm run dev -- [opciones] "<pregunta>"

  -w, --workspace <dir>   directorio sobre el que trabaja (defecto: el actual)
  -m, --model <id>        modelo (defecto: $HARNESS_MODEL o qwen2.5:7b)
      --base-url <url>    endpoint compatible con chat completions, con /v1
                          (defecto: $OPENAI_BASE_URL o http://localhost:11434/v1)
      --context-window <n>  ventana de contexto del modelo, en tokens (defecto: 4096)
      --max-turns <n>     turnos máximos del run (defecto: 25)
      --permission-mode <modo>  default (pregunta antes de escribir) | acceptEdits (escribe dentro del
                          workspace) | bypass (no pregunta; un deny sigue ganando)
      --allow <regla>     regla allow extra, repetible: --allow "Edit(src/**)"
      --deny <regla>      regla deny extra, repetible: --deny "Edit(**/.env*)"
  -h, --help
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    workspace: { type: "string", short: "w" },
    model: { type: "string", short: "m" },
    "base-url": { type: "string" },
    "context-window": { type: "string" },
    "max-turns": { type: "string" },
    "permission-mode": { type: "string" },
    allow: { type: "string", multiple: true, default: [] },
    deny: { type: "string", multiple: true, default: [] },
    help: { type: "boolean", short: "h" },
  },
});

const prompt = positionals.join(" ").trim();
if (values.help || !prompt) {
  process.stdout.write(HELP);
  process.exit(values.help ? 0 : 2);
}

const maxTurns = values["max-turns"] ? Number(values["max-turns"]) : undefined;
if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns < 1)) {
  process.stderr.write("--max-turns debe ser un entero positivo\n");
  process.exit(2);
}

const contextWindow = values["context-window"] ? Number(values["context-window"]) : undefined;
if (contextWindow !== undefined && (!Number.isInteger(contextWindow) || contextWindow < 1)) {
  process.stderr.write("--context-window debe ser un entero positivo\n");
  process.exit(2);
}

const requestedMode = values["permission-mode"];
if (requestedMode && !PERMISSION_MODES.has(requestedMode)) {
  process.stderr.write("--permission-mode debe ser default, acceptEdits o bypass\n");
  process.exit(2);
}

// El bloque `permissions` de <workspace>/.harness/settings.json, más --allow y --deny. El flag manda sobre el fichero.
const settings = loadSettings(path.resolve(values.workspace ?? process.cwd()));
const permissionMode = (requestedMode as PermissionMode | undefined) ?? settings.mode;

// Con terminal en stdin y stderr se pregunta; sin ella (CI, `< /dev/null`) todo `ask` se convierte en `deny`.
const canAsk = !!process.stdin.isTTY && !!process.stderr.isTTY;
const rl = canAsk ? readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true }) : null;
const approver: Approver = rl ? ttyApprover(rl) : denyAllApprover;

const { agent, bus, workspace, model, policy, warnings } = await createHarness({
  ...(permissionMode ? { permissionMode } : {}),
  rules: {
    allow: [...settings.rules.allow, ...values.allow],
    ask: settings.rules.ask,
    deny: [...settings.rules.deny, ...values.deny],
  },
  approver,
  ...(values.workspace ? { workspace: values.workspace } : {}),
  ...(values.model ? { model: values.model } : {}),
  ...(values["base-url"] ? { baseURL: values["base-url"] } : {}),
  config: { ...(maxTurns ? { maxTurns } : {}), ...(contextWindow ? { contextWindow } : {}) },
});

/** 1234 -> 1,2k; 4096 -> 4,1k */
const k = (n: number) => (n >= 1_000 ? `${(n / 1_000).toFixed(1).replace(".", ",")}k` : String(n));

const short = (v: unknown) => {
  const s = JSON.stringify(v);
  return s.length > 100 ? `${s.slice(0, 100)}…` : s;
};

let atLineStart = true;
bus.on((e: AgentEvent) => {
  if (e.t === "text_delta") {
    process.stdout.write(e.text);
    atLineStart = e.text.endsWith("\n");
    return;
  }
  const line =
    e.t === "permission_decision"
      ? // Una regla que deniega se ve siempre. Un `ask` que se convierte en `deny` solo cuando no había nadie a quien
        // preguntar: con terminal, el usuario ya vio el prompt.
        e.decision === "deny" && (e.source === "policy" || !canAsk)
        ? `x ${e.call.name} denegado: ${e.reason}${e.source === "user" ? " (sin terminal para preguntar)" : ""}`
        : null
      : e.t === "tool_start"
      ? `> ${e.call.name} ${short(e.call.input)}`
      : e.t === "tool_end"
        ? `  ${e.result.is_error ? "error" : "ok"} (${e.durationMs} ms${e.result.content.includes("characters omitted") ? ", recortado al tope" : ""})`
        : e.t === "warning"
          ? `! ${e.message}`
          : e.t === "context"
            ? `~ ${e.action === "cleared" ? `limpiados ${e.count} resultados antiguos` : "conversación compactada"}: ${k(e.before)} -> ${k(e.after)} tokens`
            : e.t === "turn_end"
              ? e.truncated
                ? "ctx ? (el servidor recortó la conversación)"
                : `ctx ${k(e.usage.inputTokens + e.usage.cacheReadTokens + e.usage.cacheWriteTokens + e.usage.outputTokens)}/${k(agent.contextWindow)} (${Math.round(((e.usage.inputTokens + e.usage.cacheReadTokens + e.usage.cacheWriteTokens + e.usage.outputTokens) / agent.contextWindow) * 100)}%)`
              : null;
  if (line === null) return;
  if (!atLineStart) process.stdout.write("\n");
  process.stderr.write(`${line}\n`);
  atLineStart = true;
});

process.stderr.write(`workspace: ${workspace}\nmodelo: ${model}\nmodo: ${policy.mode}${settings.file ? "" : " (sin .harness/settings.json: ningún deny)"}\n`);
for (const w of settings.warnings) process.stderr.write(`! ${w}\n`);
for (const w of warnings) process.stderr.write(`! ${w}\n`);
process.stderr.write("\n");
const ctl = new AbortController();
process.once("SIGINT", () => ctl.abort());
// Con terminal, readline captura Ctrl+C: si había una pregunta pendiente, se sale sin ejecutar nada más.
rl?.once("SIGINT", () => {
  process.stderr.write("\ninterrumpido\n");
  process.exit(130);
});

const result = await agent.run(prompt, ctl.signal);
if (!atLineStart) process.stdout.write("\n");
process.stderr.write(
  `\n[${result.reason}] ${result.turns} turnos, ${result.toolCalls} llamadas, ${result.usage.inputTokens} tokens de entrada, ${result.usage.outputTokens} de salida\n`,
);
if (result.error) process.stderr.write(`${result.error}\n`);
rl?.close();
process.exit(result.reason === "end_turn" ? 0 : 1);
