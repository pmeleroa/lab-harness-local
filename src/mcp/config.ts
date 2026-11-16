import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const StdioSchema = z.object({
  type: z.literal("stdio").optional(),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  /**
   * En el lab, todo servidor stdio corre dentro del sandbox, como Bash y los hooks. Aquí solo se puede cortar
   * su red (`{ "network": "none" }`); `false` se ignora con aviso: un repositorio no puede apagar el sandbox.
   */
  sandbox: z.union([z.boolean(), z.object({ network: z.enum(["none", "host"]).optional() })]).optional(),
});

export interface McpServerConfig {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  /** `none`: el servidor no tiene red aunque el harness sí. Nunca abre la red si el harness la cortó. */
  network?: "none";
}

export interface McpServerEntry {
  name: string;
  config: McpServerConfig;
  /** El fichero del que sale (`<workspace>/.mcp.json`). */
  file: string;
}

export interface McpConfigLoad {
  servers: McpServerEntry[];
  warnings: string[];
}

export const mcpConfigFile = (workspace: string) => path.join(workspace, ".mcp.json");

/** El nombre acaba en `mcp__<servidor>__<tool>`, que la API limita a [a-zA-Z0-9_-]. */
const NAME = /^[a-zA-Z0-9_-]{1,32}$/;

/**
 * Servidores MCP de `<workspace>/.mcp.json`. Son código del repositorio que se ejecuta al arrancar. El lab solo
 * tiene esta capa y solo el transporte stdio; `harness` añade la de usuario, `--mcp-config` y HTTP.
 */
export function loadMcpConfig(workspace: string, env: NodeJS.ProcessEnv = process.env): McpConfigLoad {
  const file = mcpConfigFile(workspace);
  const warnings: string[] = [];
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { servers: [], warnings };
    throw new Error(`No se puede leer la configuración MCP ${file}: ${(e as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    // Un fichero roto no tumba el arranque.
    return { servers: [], warnings: [`MCP: JSON inválido en ${file}, ignorado.`] };
  }
  const servers = (data as { mcpServers?: unknown } | null)?.mcpServers;
  if (servers === undefined) return { servers: [], warnings };
  if (typeof servers !== "object" || servers === null || Array.isArray(servers))
    return { servers: [], warnings: [`MCP: "mcpServers" en ${file} no es un objeto, ignorado.`] };
  const out: McpServerEntry[] = [];
  for (const [name, value] of Object.entries(servers)) {
    const config = parseServer(name, value, file, env, warnings);
    if (config) out.push({ name, config, file });
  }
  return { servers: out, warnings };
}

function parseServer(name: string, value: unknown, file: string, env: NodeJS.ProcessEnv, warnings: string[]): McpServerConfig | null {
  const where = `servidor MCP "${name}" (${file})`;
  // Sin "__": separa servidor y tool en `mcp__<servidor>__<tool>`.
  if (!NAME.test(name) || name.includes("__")) {
    warnings.push(`Ignorado el ${where}: el nombre solo admite letras, números, "_" y "-" (máx. 32, sin "__").`);
    return null;
  }
  const v = value as { type?: unknown; url?: unknown } | null;
  if (v?.type !== undefined && v.type !== "stdio") {
    warnings.push(`Ignorado el ${where}: el lab solo tiene el transporte stdio.`);
    return null;
  }
  if (v?.type === undefined && typeof v?.url === "string") {
    warnings.push(`Ignorado el ${where}: el lab solo tiene el transporte stdio.`);
    return null;
  }
  const parsed = StdioSchema.safeParse(value);
  if (!parsed.success) {
    warnings.push(`Ignorado el ${where}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")}`);
    return null;
  }
  const missing = new Set<string>();
  const x = (s: string) => expandVars(s, env, missing);
  const sb = parsed.data.sandbox;
  if (sb === false) warnings.push(`El ${where} pide "sandbox": false: se ignora y corre dentro del sandbox (usa --sandbox none).`);
  const config: McpServerConfig = {
    type: "stdio",
    command: x(parsed.data.command),
    args: parsed.data.args.map(x),
    env: Object.fromEntries(Object.entries(parsed.data.env).map(([k, val]) => [k, x(val)])),
    ...(typeof sb === "object" && sb.network === "none" ? { network: "none" as const } : {}),
  };
  // Sin la variable, el servidor arrancaría con una credencial vacía: mejor no conectarlo y decir cuál falta.
  if (missing.size) {
    warnings.push(`Ignorado el ${where}: variables sin definir: ${[...missing].map((m) => `$${m}`).join(", ")}.`);
    return null;
  }
  return config;
}

/** `${VAR}` y `${VAR:-defecto}`. Lo que no tiene esa forma (`$VAR`, `$$`) se deja tal cual. */
export function expandVars(s: string, env: NodeJS.ProcessEnv, missing: Set<string>): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, def: string | undefined) => {
    const v = env[name];
    if (v !== undefined && v !== "") return v;
    if (def !== undefined) return def;
    missing.add(name);
    return "";
  });
}
