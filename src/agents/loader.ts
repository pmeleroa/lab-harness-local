import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { PermissionMode } from "../policy/engine.js";
import { matchMcpRule } from "../policy/rules.js";
import { parseSkillFile } from "../skills/loader.js";

/**
 * Tipo de subagente: un system prompt, las tools que puede usar, el modelo y el modo de permisos.
 * Los integrados vienen aquí; el resto, de ficheros `.harness/agents/<nombre>.md`.
 */
export interface AgentDefinition {
  name: string;
  description: string;
  /** Instrucciones propias del tipo: van al system prompt del subagente. */
  prompt: string;
  /** Tools permitidas. Sin lista, todas las del agente principal salvo Agent. */
  tools?: string[];
  /** Otro modelo del mismo servidor. Sin él, el del agente principal. */
  model?: string;
  /** Solo puede restringir: se aplica el más restrictivo entre este y el del agente principal. */
  mode?: PermissionMode;
  maxTurns?: number;
  source: "integrado" | "usuario" | "proyecto";
  file?: string;
}

/** La tool que lanza subagentes. Un subagente nunca la recibe: un solo nivel de profundidad. */
export const AGENT_TOOL = "Agent";

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const MODES = new Set<PermissionMode>(["plan", "default", "acceptEdits", "bypass"]);

export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    name: "explore",
    description:
      "Read-only search across the workspace. Use it to find where something is defined or used, map how a feature " +
      "works across files, or answer a question that needs reading many files. Returns conclusions with path:line " +
      "references, not file dumps. Several can run in parallel.",
    prompt: [
      "You are a read-only search agent. Find what was asked and report it.",
      "- Use Glob to find files, Grep to search contents and Read to read them; read-only Bash (ls, git log/show/diff)",
      "  for the rest. You cannot modify anything.",
      "- Search broadly first, then read only the relevant parts of files.",
      "- Your final message is the only thing the caller sees: answer the question directly, with path:line",
      "  references and short excerpts only when they matter. Do not paste whole files.",
    ].join("\n"),
    tools: ["Read", "Glob", "Grep", "Bash"],
    mode: "plan",
    maxTurns: 40,
    source: "integrado",
  },
  {
    name: "general",
    description:
      "General-purpose agent for a self-contained multi-step task (research, a focused change, running and fixing " +
      "tests) that would otherwise fill this conversation with intermediate output. Has the same tools as you.",
    prompt: [
      "You are a subagent working on a self-contained task delegated by another agent.",
      "- Do the task completely, verifying your work when possible.",
      "- Your final message is the only thing the caller sees: report what you found or changed (files, path:line),",
      "  what you verified and anything left undone. Be concise.",
    ].join("\n"),
    source: "integrado",
  },
];

/** Dónde se buscan definiciones. En el lab, solo las del proyecto, como las skills: no hay capa de usuario. */
export function agentRoots(workspace: string): { dir: string; source: AgentDefinition["source"] }[] {
  return [{ dir: path.join(workspace, ".harness", "agents"), source: "proyecto" }];
}

/**
 * Integrados + `<raíz>/<nombre>.md`. Con el mismo nombre gana la más específica (la del proyecto sobre la
 * integrada). `knownTools` filtra las tools de cada definición: las desconocidas y Agent se descartan con aviso.
 */
export function loadAgents(
  workspace: string,
  knownTools: string[],
  roots = agentRoots(workspace),
): { agents: AgentDefinition[]; warnings: string[] } {
  const byName = new Map(BUILTIN_AGENTS.map((a) => [a.name, a]));
  const warnings: string[] = [];
  for (const root of roots) {
    if (!existsSync(root.dir)) continue;
    for (const entry of readdirSync(root.dir).sort()) {
      if (!entry.endsWith(".md")) continue;
      const file = path.join(root.dir, entry);
      const { meta, body } = parseSkillFile(readFileSync(file, "utf8"));
      const name = meta.name || entry.slice(0, -3);
      if (!NAME_RE.test(name)) {
        warnings.push(`agente ignorado (nombre no válido "${name}"): ${file}`);
        continue;
      }
      if (!meta.description) {
        warnings.push(`agente ignorado (sin description): ${file}`);
        continue;
      }
      const def: AgentDefinition = { name, description: meta.description.replace(/\s+/g, " ").trim(), prompt: body, source: root.source, file };

      if (meta.tools) {
        const listed = parseList(meta.tools);
        // Las MCP (`mcp__<servidor>`, `mcp__<servidor>__<tool>`, con comodín) no se conocen hasta conectar: se aceptan.
        const dropped = listed.filter((t) => t === AGENT_TOOL || (!knownTools.includes(t) && !t.startsWith("mcp__")));
        if (dropped.length) warnings.push(`agente ${name}: tools ignoradas (${dropped.join(", ")}): ${file}`);
        def.tools = listed.filter((t) => !dropped.includes(t));
      }
      if (meta.model && meta.model !== "inherit") def.model = meta.model;
      if (meta.mode) {
        if (MODES.has(meta.mode as PermissionMode)) def.mode = meta.mode as PermissionMode;
        else warnings.push(`agente ${name}: mode "${meta.mode}" no válido, se ignora: ${file}`);
      }
      if (meta.maxTurns) {
        const n = Number(meta.maxTurns);
        if (Number.isInteger(n) && n > 0) def.maxTurns = n;
        else warnings.push(`agente ${name}: maxTurns "${meta.maxTurns}" no válido, se ignora: ${file}`);
      }
      byName.set(name, def);
    }
  }
  return { agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), warnings };
}

/** `Read, Bash`, `[Read, Bash]` o `Read Bash`. */
function parseList(raw: string): string[] {
  return raw
    .replace(/^\[|\]$/g, "")
    .split(/[\s,]+/)
    .map((t) => t.replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/** Las tools que recibe un subagente de este tipo, de entre las disponibles. Nunca Agent. */
export function toolsFor(def: AgentDefinition, available: string[]): string[] {
  return available.filter((t) => t !== AGENT_TOOL && (!def.tools || def.tools.includes(t)));
}

/**
 * Si un subagente de este tipo puede recibir una tool MCP (antes del filtro del modo plan). Una definición con
 * `tools` que nombra alguna MCP recibe solo esas; una que no nombra ninguna, o sin `tools`, todas. Así `explore`
 * (que lista solo tools integradas) recibe las de `mcp.readOnly`, y una definición que quiera limitarlas las nombra.
 */
export function mcpToolAllowed(def: AgentDefinition, toolName: string, server: string): boolean {
  const listed = def.tools?.filter((t) => t.startsWith("mcp__")) ?? [];
  return !listed.length || listed.some((t) => matchMcpRule(t, toolName, server));
}
