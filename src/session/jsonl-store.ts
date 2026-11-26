import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { summaryMessage } from "../context/manager.js";
import type { TaskKind, TaskStatus } from "../core/background.js";
import type { Block, Message, ToolSpec, Usage } from "../providers/canonical.js";

/** Quién decidió una llamada: una regla, el modo de permisos, la política del motor, el usuario o un hook. */
export type ApprovalOrigin = "rule" | "mode" | "policy" | "user" | "hook";
/** De dónde viene una regla: `.harness/settings.json`, `--allow`/`--deny`, un «siempre» o el propio harness. */
export type RuleSource = "settings" | "flag" | "session" | "builtin";

export type SessionRecord =
  | {
      type: "meta";
      ts: string;
      sessionId: string;
      workspace: string;
      model: string;
      /** La ventana de contexto con la que arrancó esta invocación. */
      contextWindow?: number;
      /** Solo en el transcript de un subagente: la sesión que lo lanzó y su tipo. */
      parentSessionId?: string;
      agentType?: string;
      /** Solo en un fork: la sesión de la que se copió y cuántos registros se copiaron. */
      forkedFrom?: { sessionId: string; records: number };
      /** Servidores MCP de la sesión y las tools que vio el modelo: el replay las reconstruye sin conectar. */
      mcp?: { servers: { name: string; status: string; transport: string; tools: number }[]; tools: ToolSpec[] };
    }
  /** En el transcript del principal: un subagente terminó. Su conversación está en `file`. */
  | {
      type: "subagent";
      ts: string;
      id: string;
      agentType: string;
      description: string;
      reason: string;
      turns: number;
      usage: Usage;
      file?: string;
    }
  /**
   * Una tarea en segundo plano empezó (`running`) o terminó. Con el estado final van el resumen que vio (o habría
   * visto) el modelo y, en un shell, el exit code.
   */
  | {
      type: "task";
      ts: string;
      id: string;
      kind: TaskKind;
      description: string;
      status: TaskStatus;
      summary?: string;
      exitCode?: number | null;
    }
  /**
   * La decisión de permisos de una llamada, entre el tool_use y su tool_result. `reason` es el del motor tal cual (o
   * el mensaje del hook); `rule` y `ruleSource`, la regla que decidió. Con `origin: "user"`, `answer` y, si dijo que no
   * con texto, `feedback`. Una llamada que no llegó a decidirse (input inválido, tool desconocida, un corte) no tiene.
   */
  | {
      type: "approval";
      ts: string;
      toolUseId: string;
      tool: string;
      decision: "allow" | "deny";
      origin: ApprovalOrigin;
      reason: string;
      rule?: string;
      ruleSource?: RuleSource;
      answer?: "once" | "always" | "no";
      feedback?: string;
    }
  /**
   * `notice`: avisos de tareas que el loop añadió a mitad de un run (detrás del prompt o de los tool_result). No es
   * un prompt: el replay los vuelve a entregar en el mismo punto.
   */
  | { type: "message"; ts: string; message: Message; notice?: true }
  | { type: "usage"; ts: string; turn: number; usage: Usage }
  /** La conversación se compactó: desde aquí, empieza por el resumen (y el prompt conservado, si lo hay). */
  | { type: "compact"; ts: string; summary: string; kept?: Message };

export interface SessionStore {
  readonly id: string;
  append(r: SessionRecord): void;
}

/**
 * Las sesiones viven fuera de cualquier workspace, en `~/.harness/sessions`: dentro, el agente podría leerlas sin
 * preguntar, encontrarlas con Grep y reescribirlas. El motor deniega escribir aquí y el sandbox lo oculta.
 */
export const sessionsRoot = (): string => path.join(os.homedir(), ".harness", "sessions");

/**
 * Carpeta de un workspace: su nombre y 8 caracteres del hash de su ruta real (`tienda-demo-3f2a9c1b`). Se lee con
 * `ls`, no choca entre dos rutas con el mismo nombre y no cambia con cómo se escriba la ruta.
 */
export function workspaceKey(workspace: string): string {
  let real = path.resolve(workspace);
  try {
    real = realpathSync(real);
  } catch {
    // aún no existe: la ruta tal cual
  }
  const hash = createHash("sha256").update(real).digest("hex").slice(0, 8);
  return `${path.basename(real) || "root"}-${hash}`;
}

/** Transcripts de un workspace. */
export const sessionsDirOf = (workspace: string): string => path.join(sessionsRoot(), workspaceKey(workspace));

/** Directorio de los transcripts de los subagentes de una sesión (fuera de listSessions: no acaba en .jsonl). */
export const subagentsDir = (sessionsDir: string, sessionId: string) => path.join(sessionsDir, sessionId, "agents");

/**
 * Append-only: cada línea es un registro autocontenido. Un crash a mitad de
 * escritura pierde como mucho la última línea.
 *
 * El fichero no se crea hasta el primer mensaje: arrancar y salir sin escribir nada no deja sesión.
 * Con un `id` existente, se sigue escribiendo en el mismo fichero (resume).
 */
export class JsonlSessionStore implements SessionStore {
  readonly id: string;
  readonly file: string;
  private held: SessionRecord[] = [];

  constructor(
    private dir: string,
    id: string = randomUUID(),
  ) {
    this.id = id;
    this.file = path.join(dir, `${id}.jsonl`);
  }

  append(r: SessionRecord): void {
    if (r.type === "meta" && !this.exists()) {
      this.held.push(r);
      return;
    }
    const pending = this.held.splice(0);
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.file, [...pending, r].map((x) => `${JSON.stringify(x)}\n`).join(""));
  }

  private exists(): boolean {
    try {
      statSync(this.file);
      return true;
    } catch {
      return false;
    }
  }

  /** Registros del fichero en orden. Las líneas ilegibles (truncadas por un crash) se saltan. */
  static readRecords(file: string): SessionRecord[] {
    const out: SessionRecord[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as SessionRecord);
      } catch {
        // línea truncada por crash
      }
    }
    return out;
  }

  /**
   * Reconstruye la conversación fusionando mensajes consecutivos del mismo rol, como hace el loop. Desde el último
   * `compact`, y solo los `message`: `approval`, `task`, `subagent` y `usage` se guardan, pero no se restauran.
   */
  static readMessages(file: string): Message[] {
    const out: Message[] = [];
    for (const r of JsonlSessionStore.readRecords(file)) {
      if (r.type === "compact") {
        const m = summaryMessage(r.summary);
        if (r.kept) m.content.push(...r.kept.content);
        out.splice(0, out.length, m);
        continue;
      }
      if (r.type !== "message") continue;
      const last = out.at(-1);
      if (last && last.role === r.message.role) last.content.push(...r.message.content);
      else out.push({ role: r.message.role, content: [...r.message.content] });
    }
    return out;
  }
}

/** Lo que `--continue`, `--resume` y el resumen al retomar necesitan saber de una sesión. */
export interface SessionSummary {
  id: string;
  file: string;
  updatedAt: string;
  /** Si es un fork, la sesión de origen. */
  forkedFrom?: string;
  /** Prompts del usuario (no cuenta los mensajes de tool_result ni los avisos). */
  prompts: number;
  messages: number;
}

/** Resumen de un fichero de sesión. null si no tiene mensajes (o no se puede leer). */
function summarize(file: string): SessionSummary | null {
  let records: SessionRecord[];
  try {
    records = JsonlSessionStore.readRecords(file);
  } catch {
    return null;
  }
  const s: SessionSummary = { id: path.basename(file, ".jsonl"), file, updatedAt: statSync(file).mtime.toISOString(), prompts: 0, messages: 0 };
  for (const r of records) {
    if (r.type === "meta" && r.forkedFrom) s.forkedFrom ??= r.forkedFrom.sessionId;
    if (r.type !== "message") continue;
    s.messages++;
    if (isUserPrompt(r)) s.prompts++;
  }
  return s.messages ? s : null;
}

/** Sesiones con contenido, de la más reciente a la más antigua. */
export function listSessions(dir: string): SessionSummary[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }
  return names
    .map((n) => summarize(path.join(dir, n)))
    .filter((s): s is SessionSummary => s !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Resuelve un id completo o un prefijo único. Lanza si no existe o es ambiguo. */
export function resolveSession(dir: string, idOrPrefix: string): SessionSummary {
  const all = listSessions(dir);
  const hits = all.filter((s) => s.id === idOrPrefix || s.id.startsWith(idOrPrefix));
  if (hits.length === 0) throw new Error(`No hay ninguna sesión "${idOrPrefix}" en ${dir}.`);
  if (hits.length > 1 && !hits.some((s) => s.id === idOrPrefix))
    throw new Error(`"${idOrPrefix}" es ambiguo: ${hits.map((s) => s.id.slice(0, 8)).join(", ")}.`);
  return hits.find((s) => s.id === idOrPrefix) ?? hits[0]!;
}

/**
 * Un registro `message` de usuario que empieza un run: no lleva tool_result ni son avisos entregados a mitad de run.
 * Incluye los turnos automáticos (los avisos de tareas como prompt).
 */
export const isPrompt = (r: SessionRecord): boolean =>
  r.type === "message" && r.message.role === "user" && !r.notice && !r.message.content.some((b) => b.type === "tool_result");

/** Solo avisos de tareas en segundo plano, sin nada que haya escrito el usuario. */
const onlyNotifications = (m: Message): boolean =>
  m.content.length > 0 && m.content.every((b) => b.type === "text" && b.text.startsWith("<background-notification"));

/** Un prompt que escribió el usuario: los turnos automáticos no cuentan. */
export const isUserPrompt = (r: SessionRecord): boolean => isPrompt(r) && r.type === "message" && !onlyNotifications(r.message);

/**
 * Copia una sesión a otra nueva, que empieza con un `meta` que apunta al origen. El origen no se toca.
 * Los transcripts de los subagentes no se copian: los registros `subagent` siguen apuntando a los del origen.
 */
export function forkSession(dir: string, source: string, o: { workspace: string; model: string; contextWindow?: number }): SessionSummary {
  const sourceId = path.basename(source, ".jsonl");
  const records = JsonlSessionStore.readRecords(source).filter((r) => r.type !== "meta");
  if (!records.some((r) => r.type === "message")) throw new Error("No queda ninguna conversación que copiar.");
  const id = randomUUID();
  const file = path.join(dir, `${id}.jsonl`);
  const meta: SessionRecord = {
    type: "meta",
    ts: new Date().toISOString(),
    sessionId: id,
    workspace: o.workspace,
    model: o.model,
    ...(o.contextWindow ? { contextWindow: o.contextWindow } : {}),
    forkedFrom: { sessionId: sourceId, records: records.length },
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, [meta, ...records].map((x) => `${JSON.stringify(x)}\n`).join(""));
  const s = summarize(file);
  if (!s) throw new Error("El fork no tiene conversación.");
  return s;
}

export const RESUME_INTERRUPTED = "Session ended before this tool ran.";

/**
 * Deja la conversación lista para continuar: si la sesión se cortó con un tool_use sin
 * su tool_result (un Ctrl+C en una pregunta de permiso, un crash a mitad de tools), se añaden resultados
 * sintéticos. La API rechaza un tool_use sin resultado emparejado.
 */
export function repairTranscript(messages: Message[]): Message[] {
  const out = messages.map((m) => ({ role: m.role, content: [...m.content] }));
  const last = out.at(-1);
  if (last?.role !== "assistant") return out;
  const results: Block[] = last.content
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ type: "tool_result", tool_use_id: (b as { id: string }).id, content: RESUME_INTERRUPTED, is_error: true }));
  if (results.length) out.push({ role: "user", content: results });
  return out;
}

export class MemorySessionStore implements SessionStore {
  readonly id = "memory";
  readonly records: SessionRecord[] = [];
  append(r: SessionRecord): void {
    this.records.push(r);
  }
}

/** Los ids se muestran y se aceptan por prefijo: 8 caracteres bastan en la práctica. */
export const shortId = (id: string) => id.slice(0, 8);

export function relativeTime(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "ahora";
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86_400) return `hace ${Math.floor(s / 3600)} h`;
  if (s < 30 * 86_400) return `hace ${Math.floor(s / 86_400)} d`;
  return iso.slice(0, 10);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Recordatorio de dónde se quedó la conversación: último prompt y última respuesta. */
export function formatResumed(s: SessionSummary, messages: Message[], width = 100): string {
  const textOf = (m: Message | undefined) =>
    (m?.content.find((b) => b.type === "text") as { text: string } | undefined)?.text.replace(/\s+/g, " ").trim() ?? "";
  const lastUser = [...messages].reverse().find((m) => m.role === "user" && textOf(m));
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && textOf(m));
  const how = s.forkedFrom ? `fork de ${shortId(s.forkedFrom)}` : "retomada";
  const out = [`↻ sesión ${shortId(s.id)} ${how} · ${s.prompts} prompts · ${relativeTime(s.updatedAt)}`];
  if (lastUser) out.push(`  tú:     ${clip(textOf(lastUser), width - 12)}`);
  if (lastAssistant) out.push(`  agente: ${clip(textOf(lastAssistant), width - 12)}`);
  return `${out.join("\n")}\n`;
}
