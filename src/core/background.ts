import { randomUUID } from "node:crypto";
import type { Block } from "../providers/canonical.js";
import type { EventBus } from "./events.js";

/** Lo que puede correr en segundo plano: un comando de Bash o un subagente. */
export type TaskKind = "shell" | "agent";

export type TaskStatus = "running" | "completed" | "failed" | "killed";

/**
 * Qué hacer con las tareas que siguen corriendo cuando el agente principal termina un run sin nadie más que lo
 * continúe (headless): un dev server no acaba nunca y se mata; un subagente acaba con un informe y se espera.
 */
export type RunEndPolicy = "kill" | "wait";

export interface TaskInfo {
  /** Id corto (8 caracteres); se muestra como `<kind>·<id>`. */
  id: string;
  kind: TaskKind;
  description: string;
  status: TaskStatus;
  startedAt: number;
  endedAt?: number;
  /** Código de salida, solo para `shell`. */
  exitCode?: number | null;
}

/** Cómo termina por sí sola una tarea. El resumen es lo que verá el modelo en la notificación. */
export interface TaskResult {
  status: "completed" | "failed";
  summary: string;
  exitCode?: number | null;
}

/** Aviso para el agente principal: el loop lo entrega antes de su siguiente llamada al modelo. */
export interface TaskNotification {
  task: TaskInfo;
  summary: string;
}

export interface StartTask {
  kind: TaskKind;
  description: string;
  /**
   * El trabajo en sí. Debe terminar cuando se aborte `signal`; lo que devuelva después de un abort se descarta.
   * Si lanza una excepción, la tarea queda como `failed` con el mensaje como resumen. `id` es el de la tarea (un
   * subagente lo usa como el suyo, para que sus eventos y su aviso coincidan).
   */
  run(signal: AbortSignal, id: string): Promise<TaskResult>;
}

export interface BackgroundTasksOptions {
  bus?: EventBus;
  policies?: Partial<Record<TaskKind, RunEndPolicy>>;
}

interface Entry {
  info: TaskInfo;
  controller: AbortController;
  done: Promise<void>;
  /** Si el final de la tarea genera notificación. Un kill pedido por el modelo (KillShell) no la necesita. */
  notify: boolean;
  killSummary?: string;
}

/** Cómo llega un aviso al modelo: un bloque de texto en el mensaje de usuario, nunca como si lo dijera el usuario. */
export function formatNotification(n: TaskNotification): string {
  const { task } = n;
  return [
    `<background-notification task="${task.kind}·${task.id}" status="${task.status}">`,
    `A background task you started has finished (this is not a message from the user): ${task.description}`,
    n.summary,
    "</background-notification>",
  ].join("\n");
}

/** Los avisos como bloques de texto para el siguiente mensaje de usuario. */
export function notificationBlocks(ns: TaskNotification[]): Block[] {
  return ns.map((n) => ({ type: "text", text: formatNotification(n) }));
}

const DEFAULT_POLICIES: Record<TaskKind, RunEndPolicy> = { shell: "kill", agent: "wait" };

/**
 * Tareas en segundo plano de una sesión. Cada una tiene su propio AbortController: nada las enlaza con el signal
 * del run que las lanzó, así que Ctrl+C sobre el run no las mata; solo kill(), runEnd() o disposeAll().
 * Al terminar dejan una notificación en la bandeja, que el loop vacía con drain().
 */
export class BackgroundTasks {
  private entries = new Map<string, Entry>();
  private inbox: TaskNotification[] = [];
  private waiters = new Set<() => void>();
  private policies: Record<TaskKind, RunEndPolicy>;

  constructor(private o: BackgroundTasksOptions = {}) {
    this.policies = { ...DEFAULT_POLICIES, ...o.policies };
  }

  start(t: StartTask): TaskInfo {
    let id: string;
    do id = randomUUID().slice(0, 8);
    while (this.entries.has(id));
    const info: TaskInfo = { id, kind: t.kind, description: t.description, status: "running", startedAt: Date.now() };
    const controller = new AbortController();
    const entry: Entry = { info, controller, notify: true, done: Promise.resolve() };
    this.entries.set(id, entry);
    this.o.bus?.emit({ t: "task_start", id, kind: t.kind, description: t.description });

    const run = (async () => t.run(controller.signal, id))();
    entry.done = run.then(
      (r) => this.finish(entry, r),
      (e: unknown) => this.finish(entry, { status: "failed", summary: e instanceof Error ? e.message : String(e) }),
    );
    return { ...info };
  }

  get(id: string): TaskInfo | undefined {
    const e = this.entries.get(id);
    return e && { ...e.info };
  }

  /** Todas las de la sesión, en orden de inicio. Con `running`, solo las que siguen en marcha. */
  list(o: { running?: boolean } = {}): TaskInfo[] {
    return [...this.entries.values()].map((e) => ({ ...e.info })).filter((t) => !o.running || t.status === "running");
  }

  /**
   * Aborta una tarea y espera a que su trabajo termine. Devuelve su estado final, o undefined si no existe.
   * Con `notify: false` no deja notificación (el que la mata ya lo sabe).
   */
  async kill(id: string, o: { notify?: boolean; reason?: string } = {}): Promise<TaskInfo | undefined> {
    const e = this.entries.get(id);
    if (!e) return undefined;
    if (e.info.status === "running") {
      e.notify = o.notify ?? true;
      e.killSummary = o.reason ?? "Killed.";
      e.controller.abort();
    }
    await e.done;
    return { ...e.info };
  }

  /**
   * Fin de un run sin turno siguiente: mata las tareas con política `kill` (sin notificación: no hay quien la lea)
   * y devuelve las que mató.
   */
  async runEnd(): Promise<TaskInfo[]> {
    const doomed = this.list({ running: true }).filter((t) => this.policies[t.kind] === "kill");
    return Promise.all(doomed.map((t) => this.kill(t.id, { notify: false, reason: "Killed at the end of the run." }))).then(
      (r) => r.filter((t): t is TaskInfo => !!t),
    );
  }

  /** Tareas en marcha que hay que esperar antes de dar la sesión por terminada (política `wait`). */
  awaited(): TaskInfo[] {
    return this.list({ running: true }).filter((t) => this.policies[t.kind] === "wait");
  }

  /**
   * Si hay algo que esperar o que entregar antes de dar por terminada una sesión headless: tareas `wait` en marcha, o
   * avisos suyos aún sin entregar (una que terminó justo cuando acababa el run).
   */
  needsFollowUp(): boolean {
    return this.awaited().length > 0 || this.inbox.some((n) => this.policies[n.task.kind] === "wait");
  }

  /** Se resuelve cuando hay alguna notificación pendiente (al momento, si ya la hay). */
  nextNotification(signal?: AbortSignal): Promise<void> {
    if (this.inbox.length > 0 || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.waiters.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      this.waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  get pending(): number {
    return this.inbox.length;
  }

  /** Cuántas de las pendientes justifican un turno por sí solas. */
  get wakeups(): number {
    return this.inbox.length;
  }

  /** Saca las notificaciones pendientes, en orden de llegada. */
  drain(): TaskNotification[] {
    return this.inbox.splice(0);
  }

  /** Cierre de la sesión: aborta todo sin esperar ni notificar. */
  disposeAll(): void {
    for (const e of this.entries.values()) {
      if (e.info.status !== "running") continue;
      e.notify = false;
      e.controller.abort();
    }
  }

  private finish(e: Entry, r: TaskResult): void {
    const killed = e.controller.signal.aborted;
    e.info.status = killed ? "killed" : r.status;
    e.info.endedAt = Date.now();
    if (e.info.kind === "shell") e.info.exitCode = killed ? null : (r.exitCode ?? null);
    const summary = killed ? (e.killSummary ?? "Killed.") : r.summary;
    this.o.bus?.emit({
      t: "task_end",
      id: e.info.id,
      kind: e.info.kind,
      status: e.info.status,
      durationMs: e.info.endedAt - e.info.startedAt,
      summary,
      ...(e.info.kind === "shell" ? { exitCode: e.info.exitCode ?? null } : {}),
    });
    if (!e.notify) return;
    this.inbox.push({ task: { ...e.info }, summary });
    for (const w of [...this.waiters]) w();
  }
}
