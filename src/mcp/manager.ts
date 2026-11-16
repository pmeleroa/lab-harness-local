import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import os from "node:os";
import { type Sandbox, noSandbox } from "../policy/sandbox/index.js";
import { VERSION } from "../version.js";
import type { McpServerConfig, McpServerEntry } from "./config.js";

export type McpStatus = "pending" | "connected" | "failed";

export interface McpTool {
  server: string;
  name: string;
  description?: string;
  inputSchema: Tool["inputSchema"];
  /** Lo que declara el servidor (readOnlyHint...). Informativo: el motor de permisos no se fía de ello. */
  annotations?: Tool["annotations"];
}

export interface McpServerState {
  name: string;
  config: McpServerConfig;
  status: McpStatus;
  /** Por qué falló (incluye las últimas líneas de stderr del servidor). */
  error?: string;
  tools: McpTool[];
  /** Nombre y versión que declara el servidor. */
  serverInfo?: { name: string; version: string };
  /** Con qué sandbox se lanzó el proceso (`none` solo con `--sandbox none` o si no hay ninguno disponible). */
  sandbox: Sandbox["name"];
}

export interface McpManagerOptions {
  /** cwd de los servidores. */
  workspace: string;
  /** El mismo sandbox que Bash y los hooks: todo servidor stdio corre dentro. */
  sandbox?: Sandbox;
  hiddenPaths?: string[];
  /** La red del harness. Si está cortada, ningún servidor la tiene. */
  network?: "none" | "host";
  /** Límite para conectar y listar tools. Defecto 10 s. */
  connectTimeoutMs?: number;
  /** Límite de una llamada sin progreso. Defecto 10 min: una tool MCP puede ser una consulta larga. */
  callTimeoutMs?: number;
}

interface Live {
  client: Client;
  stderr: StderrTail;
}

/** Conexiones con los servidores MCP de la sesión. Un fallo deja el servidor en `failed`, nunca lanza al arrancar. */
export class McpManager {
  private readonly states = new Map<string, McpServerState>();
  private readonly live = new Map<string, Live>();
  private disposed = false;

  constructor(
    entries: McpServerEntry[],
    private readonly o: McpManagerOptions,
  ) {
    const sandbox = o.sandbox ?? noSandbox;
    for (const e of entries) this.states.set(e.name, { name: e.name, config: e.config, status: "pending", tools: [], sandbox: sandbox.name });
  }

  /** Conecta todos en paralelo. Resuelve cuando cada uno está conectado o ha fallado. */
  async connectAll(): Promise<void> {
    await Promise.all([...this.states.keys()].map((n) => this.connect(n)));
  }

  servers(): McpServerState[] {
    return [...this.states.values()];
  }

  /** Tools de los servidores conectados. */
  tools(): McpTool[] {
    return this.servers().flatMap((s) => (s.status === "connected" ? s.tools : []));
  }

  async callTool(server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const live = this.live.get(server);
    const state = this.states.get(server);
    if (!live || state?.status !== "connected")
      throw new Error(`MCP server "${server}" is not connected${state?.error ? `: ${state.error}` : ""}`);
    const result = await live.client.callTool({ name: tool, arguments: args }, undefined, {
      ...(signal ? { signal } : {}),
      timeout: this.o.callTimeoutMs ?? 600_000,
      resetTimeoutOnProgress: true,
    });
    // Servidores antiguos pueden devolver `toolResult` en lugar de `content`.
    if (!Array.isArray(result.content)) return { content: [{ type: "text", text: JSON.stringify(result.toolResult ?? result) }] };
    return result as CallToolResult;
  }

  /** Cierra las conexiones y termina los procesos. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const all = [...this.live.values()];
    this.live.clear();
    await Promise.allSettled(all.map((l) => l.client.close()));
  }

  private async connect(name: string): Promise<void> {
    const state = this.states.get(name)!;
    const timeout = this.o.connectTimeoutMs ?? 10_000;
    const stderr = new StderrTail();
    const client = new Client({ name: "lab-harness-local", version: VERSION });
    try {
      await client.connect(this.transport(state.config, stderr), { timeout });
      const tools = await listTools(client, name, timeout);
      if (this.disposed) {
        await client.close();
        return;
      }
      const info = client.getServerVersion();
      Object.assign(state, { status: "connected", tools, ...(info ? { serverInfo: { name: info.name, version: info.version } } : {}) });
      this.live.set(name, { client, stderr });
      // Si el servidor muere después, se marca como caído: las llamadas siguientes dan un error claro.
      client.onclose = () => {
        if (this.live.get(name)?.client !== client) return;
        this.live.delete(name);
        if (!this.disposed) Object.assign(state, { status: "failed", error: withStderr("connection closed", stderr) });
      };
    } catch (e) {
      await client.close().catch(() => {});
      Object.assign(state, { status: "failed", error: withStderr(errorText(e, timeout), stderr) });
    }
  }

  private transport(c: McpServerConfig, stderr: StderrTail): StdioClientTransport {
    // Dentro del sandbox, como Bash: escritura solo en el workspace y el tmp, sin leer las rutas de credenciales.
    // La red, la del harness; el servidor solo puede cortarla para sí.
    const sandbox = this.o.sandbox ?? noSandbox;
    const network = this.o.network === "none" || c.network === "none" ? "none" : "host";
    const argv = sandbox.wrap([c.command, ...c.args], {
      cwd: this.o.workspace,
      writablePaths: [this.o.workspace, os.tmpdir()],
      hiddenPaths: this.o.hiddenPaths ?? [],
      network,
    });
    // `env` sustituye al entorno entero en el SDK: se parte del mínimo seguro que da el SDK (PATH, HOME...), no de
    // todo el nuestro. Las credenciales llegan solo por el `env` de su configuración.
    const t = new StdioClientTransport({
      command: argv[0]!,
      args: argv.slice(1),
      env: { ...getDefaultEnvironment(), ...c.env },
      cwd: this.o.workspace,
      stderr: "pipe",
    });
    t.stderr?.on("data", (d: Buffer) => stderr.push(d.toString("utf8")));
    return t;
  }
}

async function listTools(client: Client, server: string, timeout: number): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {}, { timeout });
    for (const t of page.tools)
      tools.push({ server, name: t.name, inputSchema: t.inputSchema, ...(t.description ? { description: t.description } : {}), ...(t.annotations ? { annotations: t.annotations } : {}) });
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

function errorText(e: unknown, timeout: number): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/timed out|RequestTimeout|-32001/i.test(msg)) return `no response after ${Math.round(timeout / 1000)}s`;
  return msg.replace(/^MCP error -?\d+: /, "");
}

function withStderr(msg: string, stderr: StderrTail): string {
  const tail = stderr.text();
  return tail ? `${msg} (stderr: ${tail})` : msg;
}

/** Últimos caracteres de stderr: un servidor stdio que falla suele explicar por qué ahí. */
class StderrTail {
  private buf = "";
  push(s: string): void {
    this.buf = (this.buf + s).slice(-2000);
  }
  text(): string {
    return this.buf.trim().split("\n").slice(-3).join(" | ").slice(-300);
  }
}
