import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { BackgroundTasks, TaskInfo } from "../core/background.js";
import { type Sandbox, type SandboxSpec, noSandbox, realpathOrSelf } from "../policy/sandbox/index.js";
import { defineTool, isInside, truncateMiddle } from "./types.js";

export interface BashSessionOptions {
  workspace: string;
  sandbox?: Sandbox;
  network?: SandboxSpec["network"];
  hiddenPaths?: string[];
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  maxOutputChars?: number;
  /** Variables que nunca llegan al proceso hijo. */
  scrubEnv?: RegExp;
}

export interface ExecResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  interrupted: boolean;
  cwdReset: boolean;
}

const SOFT_BUFFER_CAP = 2 * 1024 * 1024;
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** SIGTERM al grupo del proceso y, si sigue vivo a los 2 s, SIGKILL. */
function terminateGroup(pid: number | undefined): void {
  const killGroup = (sig: NodeJS.Signals) => {
    try {
      if (pid) process.kill(-pid, sig);
    } catch {
      /* ya terminó */
    }
  };
  killGroup("SIGTERM");
  setTimeout(() => killGroup("SIGKILL"), 2000).unref();
}

/**
 * Shell "persistente" sin proceso persistente: cada comando es un proceso nuevo
 * (aislable con sandbox, matable por grupo), pero cwd y variables exportadas se
 * conservan entre llamadas vía un directorio de estado.
 */
export class BashSession {
  readonly workspace: string;
  cwd: string;
  readonly stateDir: string;
  private opts: Required<Omit<BashSessionOptions, "workspace">>;

  constructor(o: BashSessionOptions) {
    this.workspace = realpathOrSelf(o.workspace);
    this.cwd = this.workspace;
    this.stateDir = realpathOrSelf(mkdtempSync(path.join(os.tmpdir(), "harness-sh-")));
    this.opts = {
      sandbox: o.sandbox ?? noSandbox,
      network: o.network ?? "host",
      hiddenPaths: o.hiddenPaths ?? [],
      defaultTimeoutMs: o.defaultTimeoutMs ?? 120_000,
      maxTimeoutMs: o.maxTimeoutMs ?? 600_000,
      maxOutputChars: o.maxOutputChars ?? 30_000,
      scrubEnv: o.scrubEnv ?? /(API_KEY|_TOKEN|_SECRET|PASSWORD|PASSWD)$/i,
    };
  }

  get sandboxName(): string {
    return this.opts.sandbox.name;
  }

  async exec(command: string, o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ExecResult> {
    const timeoutMs = Math.min(o.timeoutMs ?? this.opts.defaultTimeoutMs, this.opts.maxTimeoutMs);
    const st = q(this.stateDir);
    const script = [
      `__h_state=${st}`,
      `[ -f "$__h_state/env.sh" ] && . "$__h_state/env.sh" >/dev/null 2>&1`,
      `cd ${q(this.cwd)} 2>/dev/null || cd ${q(this.workspace)}`,
      `trap '__h_rc=$?; pwd -P > "$__h_state/cwd"; export -p > "$__h_state/env.sh"; exit $__h_rc' EXIT`,
      command,
    ].join("\n");

    const [bin, args, env] = this.spawnArgs(script);
    const child = spawn(bin, args, { cwd: this.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });

    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString("utf8");
      if (buf.length > SOFT_BUFFER_CAP) {
        buf = truncateMiddle(buf, SOFT_BUFFER_CAP / 2);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    let timedOut = false;
    let interrupted = false;
    const terminate = () => terminateGroup(child.pid);
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const onAbort = () => {
      interrupted = true;
      terminate();
    };
    o.signal?.addEventListener("abort", onAbort, { once: true });
    if (o.signal?.aborted) onAbort();

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("error", (e) => {
        buf += `\n${e.message}`;
        resolve(127);
      });
      child.on("close", (code) => resolve(code));
    });
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);

    const cwdReset = this.updateCwd();
    const output = truncateMiddle(buf.trimEnd(), this.opts.maxOutputChars);
    return { output, exitCode, timedOut, interrupted, cwdReset };
  }

  /**
   * Lanza un comando que sigue corriendo después de volver: la salida (stdout y stderr) va a un fichero en el
   * directorio de estado. Parte del cwd y del entorno actuales pero no los modifica (sin trap EXIT): un proceso
   * que acaba tarde no puede pisar el cwd de la sesión. Sin timeout; termina al abortar `signal`. Cuando bash
   * sale, se mata lo que quede en su grupo para no dejar huérfanos.
   */
  spawnBackground(command: string, signal: AbortSignal): { logFile: string; done: Promise<{ exitCode: number | null }> } {
    const logFile = path.join(this.stateDir, `bg-${randomUUID().slice(0, 8)}.log`);
    const script = [
      `[ -f ${q(path.join(this.stateDir, "env.sh"))} ] && . ${q(path.join(this.stateDir, "env.sh"))} >/dev/null 2>&1`,
      `cd ${q(this.cwd)} 2>/dev/null || cd ${q(this.workspace)}`,
      command,
    ].join("\n");
    const [bin, args, env] = this.spawnArgs(script);
    const fd = openSync(logFile, "a");
    const child = spawn(bin, args, { cwd: this.cwd, env, detached: true, stdio: ["ignore", fd, fd] });
    closeSync(fd); // el hijo tiene su copia

    const onAbort = () => terminateGroup(child.pid);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    const done = new Promise<{ exitCode: number | null }>((resolve) => {
      child.on("error", () => resolve({ exitCode: 127 }));
      child.on("exit", (code) => {
        signal.removeEventListener("abort", onAbort);
        terminateGroup(child.pid);
        resolve({ exitCode: code });
      });
    });
    return { logFile, done };
  }

  private spawnArgs(script: string): [string, string[], NodeJS.ProcessEnv] {
    const argv = this.opts.sandbox.wrap(["bash", "--noprofile", "--norc", "-c", script], {
      cwd: this.cwd,
      writablePaths: [this.workspace, this.stateDir],
      hiddenPaths: this.opts.hiddenPaths,
      network: this.opts.network,
    });
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!this.opts.scrubEnv.test(k)) env[k] = v;
    env.TMPDIR = this.stateDir; // /tmp es un tmpfs efímero dentro de bwrap
    const [bin, ...args] = argv;
    return [bin!, args, env];
  }

  get maxOutputChars(): number {
    return this.opts.maxOutputChars;
  }

  private updateCwd(): boolean {
    try {
      const next = readFileSync(path.join(this.stateDir, "cwd"), "utf8").trim();
      if (!next) return false;
      if (isInside(this.workspace, next)) {
        this.cwd = next;
        return false;
      }
      this.cwd = this.workspace; // fuera del workspace: se resetea
      return true;
    } catch {
      return false;
    }
  }

  dispose(): void {
    rmSync(this.stateDir, { recursive: true, force: true });
  }
}

/** Lo que el modelo ve de la salida de una tarea al terminar: la cola, que es donde suele estar el resultado. */
const NOTIFY_TAIL_CHARS = 2000;

interface ShellEntry {
  command: string;
  logFile: string;
  /** Bytes del log ya devueltos por BashOutput. */
  offset: number;
}

/**
 * Comandos de Bash en segundo plano de un agente: los lanza como tareas del registro y guarda dónde está la
 * salida de cada uno. Lo comparten Bash (run_in_background), BashOutput y KillShell.
 */
export class BackgroundShells {
  private shells = new Map<string, ShellEntry>();

  constructor(
    readonly session: BashSession,
    readonly tasks: BackgroundTasks,
  ) {}

  start(command: string, description?: string): TaskInfo {
    let logFile = "";
    const info = this.tasks.start({
      kind: "shell",
      description: description ?? command,
      run: async (signal) => {
        const bg = this.session.spawnBackground(command, signal);
        logFile = bg.logFile;
        const { exitCode } = await bg.done;
        const tail = truncateTail(readRange(bg.logFile, 0).trimEnd(), NOTIFY_TAIL_CHARS);
        return {
          status: exitCode === 0 ? "completed" : "failed",
          exitCode,
          summary: [`Command exited with code ${exitCode ?? "null"}: ${command}`, tail ? `Last output:\n${tail}` : "(no output)"].join("\n"),
        };
      },
    });
    // run() se llama de forma síncrona dentro de start(), así que logFile ya está asignado.
    this.shells.set(info.id, { command, logFile, offset: 0 });
    return info;
  }

  /** Salida nueva desde la última lectura y estado actual. undefined si el id no es un shell de este agente. */
  read(id: string): { output: string; task: TaskInfo } | undefined {
    const sh = this.shells.get(id);
    const task = this.tasks.get(id);
    if (!sh || !task) return undefined;
    const size = fileSize(sh.logFile);
    const output = truncateMiddle(readRange(sh.logFile, sh.offset, size).trimEnd(), this.session.maxOutputChars);
    sh.offset = size;
    return { output, task };
  }

  async kill(id: string): Promise<TaskInfo | undefined> {
    if (!this.shells.has(id)) return undefined;
    return this.tasks.kill(id, { notify: false });
  }

  has(id: string): boolean {
    return this.shells.has(id);
  }
}

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Lee [start, end) de un log que puede ser enorme (un dev server horas en marcha): si pasa del tope, solo cabeza
 * y cola, que luego recorta truncateMiddle.
 */
function readRange(file: string, start: number, end = fileSize(file)): string {
  if (end <= start) return "";
  const fd = openSync(file, "r");
  try {
    const read = (from: number, len: number) => {
      const b = Buffer.alloc(len);
      const n = readSync(fd, b, 0, len, from);
      return b.subarray(0, n).toString("utf8");
    };
    const len = end - start;
    if (len <= SOFT_BUFFER_CAP) return read(start, len);
    const half = SOFT_BUFFER_CAP / 2;
    return `${read(start, half)}\n\n[... ${len - 2 * half} bytes omitted ...]\n\n${read(end - half, half)}`;
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

function truncateTail(s: string, maxChars: number): string {
  return s.length <= maxChars ? s : `[...]\n${s.slice(-maxChars)}`;
}

const shellLabel = (id: string) => `shell·${id}`;

function statusLine(t: TaskInfo): string {
  if (t.status === "running") return "[still running]";
  if (t.status === "killed") return "[killed]";
  return `[exited with code ${t.exitCode ?? "null"}]`;
}

/** Con `shells`, el modelo puede lanzar comandos en segundo plano (solo el agente principal). */
export function createBashTool(session: BashSession, shells?: BackgroundShells) {
  const base = z.object({
    command: z.string().min(1).describe("The command to run"),
    timeout_ms: z.number().int().min(1000).max(600_000).optional().describe("Timeout in milliseconds"),
    description: z.string().optional().describe("Short description of what the command does (shown to the user)"),
  });
  const full = base.extend({
    run_in_background: z
      .boolean()
      .optional()
      .describe("Run the command in the background and return immediately. Use BashOutput to read its output"),
  });
  return defineTool({
    name: "Bash",
    description: [
      "Runs a bash command and returns combined stdout/stderr.",
      "- The working directory and exported environment variables persist between calls.",
      "- The working directory cannot leave the workspace; it is reset if it does.",
      `- Default timeout 120s (max 600s), set with timeout_ms. Output is truncated in the middle when long.`,
      "- Prefer the Read/Edit/Write tools over cat/sed/echo for file operations, and Glob/Grep over find/grep/rg.",
      "- Chain dependent commands with &&. Avoid interactive commands (they have no stdin).",
      ...(shells
        ? [
            "- For long-running commands (dev servers, watchers, long builds or test suites) set run_in_background instead of",
            "  appending `&`: you get an id at once, read new output with BashOutput, stop it with KillShell, and you are",
            "  notified when it exits. A background command starts from the current directory and environment but cannot",
            "  change them. It has no timeout, and it is killed when the session ends.",
          ]
        : []),
      session.sandboxName === "none"
        ? "- Commands run without a sandbox."
        : "- Commands run in a sandbox: writes are only allowed inside the workspace.",
    ].join("\n"),
    // Sin shells, el campo ni aparece: zod descarta las claves desconocidas.
    schema: (shells ? full : base) as typeof full,
    readOnly: false,
    // El cwd persiste entre llamadas: una redirección relativa escribe desde ahí, no desde la raíz del workspace.
    permissionTarget: (input) => ({ kind: "command", command: input.command, cwd: session.cwd }),

    async run(input, ctx) {
      if (input.run_in_background && shells) {
        const t = shells.start(input.command, input.description);
        return {
          content: `Started ${shellLabel(t.id)} in the background. Read its output with BashOutput (id "${t.id}") when you need it; you will be notified when it exits, so do not poll in a loop.`,
        };
      }
      const r = await session.exec(input.command, {
        ...(input.timeout_ms !== undefined ? { timeoutMs: input.timeout_ms } : {}),
        signal: ctx.signal,
      });
      const notes: string[] = [];
      if (r.timedOut) notes.push("[command timed out and was killed]");
      if (r.interrupted) notes.push("[command interrupted by user]");
      if (r.cwdReset) notes.push(`[cwd left the workspace; reset to ${session.workspace}]`);
      if (r.exitCode !== 0 && r.exitCode !== null) notes.push(`[exit code ${r.exitCode}]`);
      const body = r.output || "(no output)";
      return {
        content: [body, ...notes].join("\n"),
        isError: r.timedOut || r.interrupted || (r.exitCode !== 0 && r.exitCode !== null),
      };
    },
  });
}

const unknownShell = (id: string) => ({ content: `No background shell with id "${id}".`, isError: true });

export function createBashOutputTool(shells: BackgroundShells) {
  return defineTool({
    name: "BashOutput",
    description: [
      "Returns the output a background Bash command has produced since the last call, and whether it is still running.",
      "- Use it to check a dev server is up or to look at a long build; you are notified anyway when the command exits.",
      "- Do not call it repeatedly just to wait.",
    ].join("\n"),
    schema: z.object({ id: z.string().min(1).describe("The id returned by Bash with run_in_background") }),
    readOnly: true,
    permissionTarget: (input) => ({ kind: "task", id: input.id }),

    async run(input) {
      const r = shells.read(input.id);
      if (!r) return unknownShell(input.id);
      return { content: [r.output || "(no new output)", statusLine(r.task)].join("\n") };
    },
  });
}

export function createKillShellTool(shells: BackgroundShells) {
  return defineTool({
    name: "KillShell",
    description: "Stops a background Bash command and everything it started.",
    schema: z.object({ id: z.string().min(1).describe("The id returned by Bash with run_in_background") }),
    readOnly: false,
    permissionTarget: (input) => ({ kind: "task", id: input.id }),

    async run(input) {
      const before = shells.has(input.id) ? shells.tasks.get(input.id) : undefined;
      if (!before) return unknownShell(input.id);
      if (before.status !== "running") return { content: `${shellLabel(input.id)} had already finished ${statusLine(before)}.` };
      await shells.kill(input.id);
      return { content: `Killed ${shellLabel(input.id)}.` };
    },
  });
}
