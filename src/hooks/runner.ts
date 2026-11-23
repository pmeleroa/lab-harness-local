import { spawn } from "node:child_process";
import type { HookConfig, HookEntry, HookEvent } from "../policy/settings.js";
import type { Sandbox } from "../policy/sandbox/index.js";

export interface HookRunnerOptions {
  cwd: string;
  writablePaths: string[];
  hiddenPaths: string[];
  network: "none" | "host";
  sandbox: Sandbox;
  /** Variables que no llegan al hook (mismo criterio que Bash). */
  scrubEnv?: RegExp;
}

export interface HookPayload {
  tool: string;
  input: unknown;
  /** Solo en PostToolUse. */
  result?: { content: string; isError: boolean };
}

export interface HookOutcome {
  /** Solo PreToolUse: el hook ha bloqueado la llamada. */
  block: boolean;
  /** Motivo del bloqueo, para el modelo. */
  message: string;
  /** Avisos que se añaden al tool_result para el modelo. */
  notes: string[];
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_CHARS = 8_000;

/**
 * Un matcher sin valor o "*" casa con todas las tools; si no, nombres separados por "|", donde `*` es comodín
 * (`mcp__github__*`).
 */
export function matchesTool(matcher: string | undefined, tool: string): boolean {
  if (!matcher || matcher === "*") return true;
  return matcher.split("|").some((m) => {
    const p = m.trim();
    if (!p.includes("*")) return p === tool;
    return new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(tool);
  });
}

/**
 * Ejecuta los hooks de PreToolUse y PostToolUse. Código 2 bloquea (en Pre) o avisa al modelo (en Post);
 * cualquier otro fallo o timeout se registra como aviso sin bloquear, para que un hook roto no pare el trabajo.
 */
export class HookRunner {
  private readonly scrub: RegExp;

  constructor(
    private readonly config: HookConfig,
    private readonly opts: HookRunnerOptions,
  ) {
    this.scrub = opts.scrubEnv ?? /(API_KEY|_TOKEN|_SECRET|PASSWORD|PASSWD)$/i;
  }

  get empty(): boolean {
    return !this.config.PreToolUse?.length && !this.config.PostToolUse?.length;
  }

  async run(event: HookEvent, payload: HookPayload, signal: AbortSignal): Promise<HookOutcome> {
    const outcome: HookOutcome = { block: false, message: "", notes: [] };
    for (const entry of this.config[event] ?? []) {
      if (signal.aborted) break;
      if (!matchesTool(entry.matcher, payload.tool)) continue;
      const r = await this.runOne(event, entry, payload, signal);
      if (r.code === 2 && event === "PreToolUse") {
        outcome.block = true;
        outcome.message = `Blocked by PreToolUse hook (${entry.command}): ${r.stderr || "no reason given"}`;
        return outcome;
      }
      if (r.note) outcome.notes.push(r.note);
    }
    return outcome;
  }

  private runOne(
    event: HookEvent,
    entry: HookEntry,
    payload: HookPayload,
    signal: AbortSignal,
  ): Promise<{ code: number | null; stderr: string; note?: string }> {
    const argv = this.opts.sandbox.wrap(["sh", "-c", entry.command], {
      cwd: this.opts.cwd,
      writablePaths: this.opts.writablePaths,
      hiddenPaths: this.opts.hiddenPaths,
      network: this.opts.network,
    });
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!this.scrub.test(k)) env[k] = v;
    env.HARNESS_EVENT = event;
    env.HARNESS_TOOL = payload.tool;
    const input = (payload.input ?? {}) as Record<string, unknown>;
    const file = input.file_path ?? input.path;
    if (typeof file === "string") env.HARNESS_FILE_PATH = file;

    const [bin, ...args] = argv;
    return new Promise((resolve) => {
      const child = spawn(bin!, args, { cwd: this.opts.cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const cap = (s: string, chunk: Buffer) => (s.length >= MAX_OUTPUT_CHARS ? s : (s + chunk.toString("utf8")).slice(0, MAX_OUTPUT_CHARS));
      child.stdout.on("data", (c: Buffer) => (stdout = cap(stdout, c)));
      child.stderr.on("data", (c: Buffer) => (stderr = cap(stderr, c)));
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ event, tool: payload.tool, input: payload.input, result: payload.result }));

      const kill = () => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          // ya terminado
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, entry.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const onAbort = () => kill();
      signal.addEventListener("abort", onAbort, { once: true });

      const done = (code: number | null) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        const label = `Hook ${event} (${entry.command})`;
        if (timedOut) return resolve({ code, stderr, note: `${label} timed out and was ignored.` });
        if (code === 0) return resolve({ code, stderr, note: noteFrom(stdout) });
        if (code === 2) return resolve({ code, stderr, note: stderr ? `${label}: ${stderr.trim()}` : undefined });
        resolve({ code, stderr, note: `${label} failed (exit ${code ?? "signal"}) and was ignored.` });
      };
      child.on("error", () => done(null));
      child.on("close", (code) => done(code));
    });
  }
}

/** Un hook puede avisar al modelo imprimiendo {"message": "..."} en stdout. Lo demás se ignora. */
function noteFrom(stdout: string): string | undefined {
  try {
    const msg = (JSON.parse(stdout) as { message?: unknown }).message;
    return typeof msg === "string" && msg.trim() ? msg.trim() : undefined;
  } catch {
    return undefined;
  }
}
