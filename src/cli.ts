#!/usr/bin/env node
import readline from "node:readline/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { type Approver, denyAllApprover } from "./core/loop.js";
import { createHarness } from "./index.js";
import { ttyApprover } from "./policy/approver.js";
import type { PermissionMode } from "./policy/engine.js";
import { PERMISSION_MODES, SANDBOX_CHOICES, loadSettings } from "./policy/settings.js";
import type { SandboxChoice } from "./policy/sandbox/index.js";
import type { AgentEvent } from "./core/events.js";
import { type Usage, addUsage, emptyUsage } from "./providers/canonical.js";
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
                          workspace) | plan (solo lee: deniega todo lo que preguntaría) | bypass (no
                          pregunta; un deny sigue ganando)
      --allow <regla>     regla allow extra, repetible: --allow "Edit(src/**)"
      --deny <regla>      regla deny extra, repetible: --deny "Edit(**/.env*)"
      --sandbox <modo>    auto (defecto: bwrap en Linux, sandbox-exec en macOS) | bwrap | seatbelt |
                          none (los comandos corren con todos tus permisos)
      --no-network        sin red dentro del sandbox
      --no-agents         sin subagentes (quita la tool Agent)
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
    sandbox: { type: "string" },
    "no-network": { type: "boolean" },
    "no-agents": { type: "boolean" },
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
  process.stderr.write("--permission-mode debe ser default, acceptEdits, plan o bypass\n");
  process.exit(2);
}

const requestedSandbox = values.sandbox;
if (requestedSandbox && !SANDBOX_CHOICES.has(requestedSandbox)) {
  process.stderr.write("--sandbox debe ser auto, bwrap, seatbelt o none\n");
  process.exit(2);
}

// El bloque `permissions` de <workspace>/.harness/settings.json, más --allow y --deny. El flag manda sobre el fichero.
const settings = loadSettings(path.resolve(values.workspace ?? process.cwd()));
const permissionMode = (requestedMode as PermissionMode | undefined) ?? settings.mode;

// Con terminal en stdin y stderr se pregunta; sin ella (CI, `< /dev/null`) todo `ask` se convierte en `deny`.
const canAsk = !!process.stdin.isTTY && !!process.stderr.isTTY;
const rl = canAsk ? readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true }) : null;
const approver: Approver = rl ? ttyApprover(rl) : denyAllApprover;

// El sandbox: --sandbox manda sobre el fichero; la red se corta con --no-network o desde el fichero, nunca se abre.
const sandboxChoice = (requestedSandbox as SandboxChoice | undefined) ?? settings.sandbox.mode;
const network = values["no-network"] ? "none" : settings.sandbox.network;

const { agent, bus, workspace, model, policy, bash, skills, mcp, agents, subagentRuns, warnings, endRun, followUp, dispose } = await createHarness({
  ...(permissionMode ? { permissionMode } : {}),
  ...(values["no-agents"] ? { agents: false } : {}),
  ...(sandboxChoice ? { sandbox: sandboxChoice } : {}),
  ...(network ? { network } : {}),
  rules: {
    allow: [...settings.rules.allow, ...values.allow],
    ask: settings.rules.ask,
    deny: [...settings.rules.deny, ...values.deny],
  },
  hooks: settings.hooks,
  approver,
  ...(values.workspace ? { workspace: values.workspace } : {}),
  ...(values.model ? { model: values.model } : {}),
  ...(values["base-url"] ? { baseURL: values["base-url"] } : {}),
  config: { ...(maxTurns ? { maxTurns } : {}), ...(contextWindow ? { contextWindow } : {}) },
}).catch((e: unknown) => {
  // Por ejemplo, `--sandbox bwrap` sin bwrap: pedir un sandbox concreto que no funciona impide arrancar.
  process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});

/** 1234 -> 1,2k; 4096 -> 4,1k */
const k = (n: number) => (n >= 1_000 ? `${(n / 1_000).toFixed(1).replace(".", ",")}k` : String(n));

/** Salida de un comando, sangrada y con 20 líneas como mucho. */
const indent = (s: string) => {
  const lines = s.split("\n");
  const shown = lines.length > 20 ? [...lines.slice(0, 20), `… (${lines.length - 20} líneas más)`] : lines;
  return shown.map((l) => `  | ${l}`).join("\n");
};

const short = (v: unknown) => {
  const s = JSON.stringify(v);
  return s.length > 100 ? `${s.slice(0, 100)}…` : s;
};

/** Lo que ocupa un turno: entrada (con caché) y salida. */
const used = (u: Usage) => u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.outputTokens;
const ctxLine = (u: Usage) => `ctx ${k(used(u))}/${k(agent.contextWindow)} (${Math.round((used(u) / agent.contextWindow) * 100)}%)`;
const contextLine = (e: Extract<AgentEvent, { t: "context" }>) =>
  `~ ${e.action === "cleared" ? `limpiados ${e.count} resultados antiguos` : "conversación compactada"}: ${k(e.before)} -> ${k(e.after)} tokens`;

/**
 * Un evento de un subagente, sangrado y con su etiqueta: sus tools, los errores, su contexto. Su texto no se enseña:
 * es para el principal, que solo recibe el informe final.
 */
const subagentLine = (e: AgentEvent, tag: string): string | null => {
  const pre = `  · ${tag}`;
  switch (e.t) {
    case "tool_start":
      return `${pre} > ${e.call.name} ${short(e.call.input)}`;
    case "tool_end":
      return e.result.is_error ? `${pre}   error: ${e.result.content.split("\n")[0]!.slice(0, 120)}` : null;
    case "hook_blocked":
      return `${pre} x bloqueado por un hook: ${e.message}`;
    case "permission_decision":
      return e.decision === "deny" && (e.source === "policy" || !canAsk) ? `${pre} x ${e.call.name} denegado: ${e.reason}` : null;
    case "warning":
      return `${pre} ! ${e.message}`;
    case "context":
      return `${pre} ${contextLine(e)}`;
    case "turn_end":
      return `${pre} ${e.truncated ? "ctx ? (el servidor recortó la conversación)" : ctxLine(e.usage)}`;
    default:
      return null;
  }
};

/** Prompt de cada llamada a Agent, por id de tool_use. */
const agentPrompts = new Map<string, string>();
const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

let atLineStart = true;
const writeLine = (line: string) => {
  if (!atLineStart) process.stdout.write("\n");
  process.stderr.write(`${line}\n`);
  atLineStart = true;
};

bus.on((e: AgentEvent) => {
  // Uno en segundo plano: nada de lo que hace (su resultado llega como aviso). Lo cuentan task_start y task_end.
  if (e.agent?.background || ((e.t === "subagent_start" || e.t === "subagent_end") && e.background)) return;
  if (e.agent) {
    const line = subagentLine(e, `${e.agent.type}·${e.agent.id}`);
    if (line) writeLine(line);
    return;
  }
  if (e.t === "text_delta") {
    process.stdout.write(e.text);
    atLineStart = e.text.endsWith("\n");
    return;
  }
  const isAgentCall = (e.t === "tool_start" || e.t === "tool_end") && e.call.name === "Agent";
  // El prompt que escribe el principal es todo lo que sabrá el subagente: se guarda para enseñarlo al arrancar.
  if (isAgentCall && e.t === "tool_start") agentPrompts.set(e.call.id, String((e.call.input as { prompt?: unknown }).prompt ?? ""));
  const line =
    e.t === "subagent_start"
      ? `> Agent ${e.type}·${e.id}: ${e.description}\n  prompt: ${oneLine(agentPrompts.get(e.toolUseId) ?? "", 300)}`
      : e.t === "subagent_end"
        ? `  < ${e.type}·${e.id} ${e.reason === "end_turn" ? "informe listo" : e.reason}: ${e.turns} turnos, ${e.toolCalls} llamadas, ` +
          `contexto máximo ${k(e.peakContext)}, ${k(e.usage.inputTokens + e.usage.cacheReadTokens + e.usage.cacheWriteTokens)} tokens de entrada, ` +
          `${k(e.usage.outputTokens)} de salida, ${Math.round(e.durationMs / 1000)} s`
        : isAgentCall && e.t === "tool_start"
          ? null // lo cuenta subagent_start, que ya sabe su id; o task_start, si va en segundo plano
          : isAgentCall && e.t === "tool_end"
            ? e.result.content.startsWith("Started agent·")
              ? null
              : e.result.is_error && !e.result.content.startsWith("[subagent")
                ? `  error: ${e.result.content.split("\n")[0]}`
                : `  al principal vuelve un informe de ~${k(Math.ceil(e.result.content.length / 4))} tokens`
            : null;
  if (line !== null || e.t === "subagent_start" || e.t === "subagent_end" || isAgentCall) {
    if (line !== null) writeLine(line);
    return;
  }
  const other =
    e.t === "permission_decision"
      ? // Una regla que deniega se ve siempre. Un `ask` que se convierte en `deny` solo cuando no había nadie a quien
        // preguntar: con terminal, el usuario ya vio el prompt.
        e.decision === "deny" && (e.source === "policy" || !canAsk)
        ? `x ${e.call.name} denegado: ${e.reason}${e.source === "user" ? " (sin terminal para preguntar)" : ""}`
        : null
      : e.t === "tool_start"
      ? `> ${e.call.name} ${short(e.call.input)}`
      : e.t === "hook_blocked"
      ? // Ni se pidió permiso ni se ejecutó: se enseña la llamada y lo que el hook le dice al modelo.
        `> ${e.call.name} ${short(e.call.input)}\nx bloqueado por un hook: ${e.message}`
      : e.t === "tool_end"
        ? `  ${e.result.is_error ? "error" : "ok"} (${e.durationMs} ms${e.result.content.includes("characters omitted") ? ", recortado al tope" : ""})` +
          // De un comando se enseña también lo que devolvió: es lo que el modelo va a leer.
          (e.call.name === "Bash" ? `\n${indent(e.result.content)}` : "")
        : e.t === "task_start"
          ? `& ${e.kind}·${e.id} en segundo plano: ${e.description}`
          : e.t === "task_end"
            ? `& ${e.kind}·${e.id} ${e.status}${e.exitCode != null ? ` (código ${e.exitCode})` : ""}`
            : e.t === "warning"
              ? `! ${e.message}`
              : e.t === "context"
                ? contextLine(e)
                : e.t === "turn_end"
                  ? e.truncated
                    ? "ctx ? (el servidor recortó la conversación)"
                    : ctxLine(e.usage)
                  : null;
  if (other !== null) writeLine(other);
});

process.stderr.write(`workspace: ${workspace}\nmodelo: ${model}\nmodo: ${policy.mode}${settings.file ? "" : " (sin .harness/settings.json: ningún deny)"}\nsandbox: ${bash.sandboxName}${network !== "none" ? "" : bash.sandboxName === "none" ? " (--no-network no tiene efecto sin sandbox)" : ", sin red"}\n`);
// Lo que amplía al harness sin tocar su código: qué skills ve el modelo y qué hooks del repositorio se ejecutan.
if (skills.length) process.stderr.write(`skills: ${skills.map((s) => (s.modelInvocable ? s.name : `${s.name} (no invocable)`)).join(", ")}\n`);
// Los tipos de .harness/agents son contenido del repositorio: instrucciones y tools que el modelo puede lanzar.
if (agents.length) process.stderr.write(`subagentes: ${agents.map((a) => (a.source === "proyecto" ? `${a.name} (de .harness/agents)` : a.name)).join(", ")}\n`);
const hookList = (["PreToolUse", "PostToolUse"] as const).flatMap((ev) => (settings.hooks[ev] ?? []).map((h) => `${ev}${h.matcher ? `(${h.matcher})` : ""}: ${h.command}`));
if (hookList.length) {
  process.stderr.write(`hooks (código del repositorio, ${bash.sandboxName === "none" ? "SIN sandbox" : "dentro del sandbox"}):\n`);
  for (const h of hookList) process.stderr.write(`  ${h}\n`);
}
// Los servidores de .mcp.json son procesos que el harness ya ha lanzado: qué se ejecuta, con cuántas tools y con qué sandbox.
for (const s of mcp.servers()) {
  const cmd = [s.config.command, ...s.config.args].join(" ");
  const box = s.sandbox === "none" ? "SIN sandbox" : `sandbox ${s.sandbox}${network === "none" || s.config.network === "none" ? ", sin red" : ""}`;
  process.stderr.write(`mcp: ${s.name} (${cmd}) ${s.status === "connected" ? `${s.tools.length} tools` : "no conectado"}, ${box}\n`);
}
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

let result = await agent.run(prompt, ctl.signal);
// El principal: lo de todos sus runs (el de la pregunta y los que lanzan los avisos de subagentes en segundo plano).
let totals = { turns: result.turns, toolCalls: result.toolCalls, usage: result.usage, peakContext: result.peakContext };
// Subagentes en segundo plano: se espera a sus informes y se hace otro run con ellos (con un límite de rondas).
if (result.reason === "end_turn") {
  const last = await followUp(
    async (p) => {
      const r = await agent.run(p, ctl.signal);
      totals = { turns: totals.turns + r.turns, toolCalls: totals.toolCalls + r.toolCalls, usage: addUsage(totals.usage, r.usage), peakContext: Math.max(totals.peakContext, r.peakContext) };
      return r;
    },
    {
      onWait: (ps) => writeLine(`… esperando a ${ps.map((p) => `${p.kind}·${p.id}`).join(", ")}`),
      onRound: (ns) => writeLine(`<- ${ns.map((n) => `${n.task.kind}·${n.task.id}`).join(", ")}: otro run con su aviso`),
    },
  );
  if (last) result = last;
}
// Un run de la CLI no tiene turno siguiente: los comandos que sigan en segundo plano se matan (y se avisa).
await endRun();
if (!atLineStart) process.stdout.write("\n");
/** Entrada total (lo que se envió, también lo que el servidor sirvió de su caché) y salida. */
const tokens = (u: Usage) =>
  `${u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens} tokens de entrada${u.cacheReadTokens ? ` (${u.cacheReadTokens} de caché)` : ""}, ${u.outputTokens} de salida`;
process.stderr.write(`\n[${result.reason}] ${totals.turns} turnos, ${totals.toolCalls} llamadas, ${tokens(totals.usage)}, contexto máximo ${totals.peakContext}\n`);
// Lo que gastaron los subagentes va aparte: no ocupó la ventana del principal, pero se pagó igual.
if (subagentRuns.length) {
  const u = subagentRuns.reduce((acc, r) => addUsage(acc, r.usage), emptyUsage());
  process.stderr.write(
    `[subagentes] ${subagentRuns.length} (${subagentRuns.map((r) => `${r.type}·${r.id}`).join(", ")}), ${tokens(u)}, ` +
      `contexto máximo ${Math.max(...subagentRuns.map((r) => r.peakContext))}\n`,
  );
}
if (result.error) process.stderr.write(`${result.error}\n`);
rl?.close();
dispose();
process.exit(result.reason === "end_turn" ? 0 : 1);
