#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createHarness } from "./index.js";
import type { AgentEvent } from "./core/events.js";
import { VERSION } from "./version.js";

const HELP = `lab-harness-local ${VERSION}: un agente de solo lectura para preguntar sobre un repositorio

Uso: npm run dev -- [opciones] "<pregunta>"

  -w, --workspace <dir>   directorio sobre el que trabaja (defecto: el actual)
  -m, --model <id>        modelo (defecto: $HARNESS_MODEL o qwen2.5:7b)
      --base-url <url>    endpoint compatible con chat completions, con /v1
                          (defecto: $OPENAI_BASE_URL o http://localhost:11434/v1)
      --max-turns <n>     turnos máximos del run (defecto: 25)
  -h, --help
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    workspace: { type: "string", short: "w" },
    model: { type: "string", short: "m" },
    "base-url": { type: "string" },
    "max-turns": { type: "string" },
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

const { agent, bus, workspace, model } = createHarness({
  ...(values.workspace ? { workspace: values.workspace } : {}),
  ...(values.model ? { model: values.model } : {}),
  ...(values["base-url"] ? { baseURL: values["base-url"] } : {}),
  ...(maxTurns ? { config: { maxTurns } } : {}),
});

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
    e.t === "tool_start"
      ? `> ${e.call.name} ${short(e.call.input)}`
      : e.t === "tool_end"
        ? `  ${e.result.is_error ? "error" : "ok"} (${e.durationMs} ms)`
        : e.t === "warning"
          ? `! ${e.message}`
          : null;
  if (line === null) return;
  if (!atLineStart) process.stdout.write("\n");
  process.stderr.write(`${line}\n`);
  atLineStart = true;
});

process.stderr.write(`workspace: ${workspace}\nmodelo: ${model}\n\n`);
const ctl = new AbortController();
process.once("SIGINT", () => ctl.abort());

const result = await agent.run(prompt, ctl.signal);
if (!atLineStart) process.stdout.write("\n");
process.stderr.write(
  `\n[${result.reason}] ${result.turns} turnos, ${result.toolCalls} llamadas, ${result.usage.inputTokens} tokens de entrada, ${result.usage.outputTokens} de salida\n`,
);
if (result.error) process.stderr.write(`${result.error}\n`);
process.exit(result.reason === "end_turn" ? 0 : 1);
