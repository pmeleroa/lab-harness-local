import { z } from "zod";
import { AGENT_TOOL, type AgentDefinition } from "../agents/loader.js";
import type { BackgroundTasks } from "../core/background.js";
import type { RunResult } from "../core/loop.js";
import { defineTool, truncateMiddle } from "./types.js";

export interface SubagentRequest {
  def: AgentDefinition;
  description: string;
  prompt: string;
  /** Id del tool_use que lo lanza: enlaza los eventos del subagente con la llamada. */
  callId: string;
  signal: AbortSignal;
  /** Con run_in_background: el id de la tarea, que el subagente usa como suyo. */
  background?: { id: string };
}

export type SpawnSubagent = (req: SubagentRequest) => Promise<RunResult>;

export interface AgentToolOptions {
  spawn: SpawnSubagent;
  /** true si el subagente no puede escribir (modo plan efectivo): entonces corre en paralelo con otras lecturas. */
  isReadOnly: (def: AgentDefinition) => boolean;
  maxResultChars?: number;
  /** Con el registro de tareas, el modelo puede lanzar subagentes de solo lectura en segundo plano (solo el principal). */
  tasks?: BackgroundTasks;
}

/** Límite de catálogo por descripción, como el de las skills. */
const MAX_DESCRIPTION = 300;

/**
 * Lanza un subagente con su propio contexto. Al modelo solo vuelve el informe final del subagente:
 * lo que lea o ejecute por el camino se queda en su conversación (y en su transcript).
 */
export function createAgentTool(defs: AgentDefinition[], o: AgentToolOptions) {
  const byName = new Map(defs.map((d) => [d.name, d]));
  const clip = (d: string) => (d.length > MAX_DESCRIPTION ? `${d.slice(0, MAX_DESCRIPTION - 1)}…` : d);
  const names = defs.map((d) => d.name) as [string, ...string[]];
  const base = z.object({
    description: z.string().min(1).describe("Short (3-5 words) description of the task, shown to the user"),
    prompt: z.string().min(1).describe("The full task for the subagent, self-contained"),
    subagent_type: z.enum(names).describe("Which agent type to use"),
  });
  const full = base.extend({
    run_in_background: z
      .boolean()
      .optional()
      .describe("Return at once and get the report later as a notification. Only for read-only agent types"),
  });
  const maxChars = o.maxResultChars ?? 40_000;
  /** Lo que vuelve al modelo: el informe, con una nota si no terminó bien. */
  const result = (r: RunResult) => {
    const report = truncateMiddle(r.text.trim() || "(the subagent finished without a final message)", maxChars);
    if (r.reason === "end_turn") return { content: report };
    if (r.reason === "aborted") return { content: `[subagent interrupted by the user]\n\n${report}`, isError: true };
    const why = r.error ? `${r.reason}: ${r.error}` : r.reason;
    // Un límite no es un fallo: lo hecho hasta ahí puede servir. Error solo si no llegó a responder.
    return { content: `[subagent stopped early (${why}); its report may be incomplete]\n\n${report}`, isError: r.reason === "error" };
  };
  const readOnlyTypes = defs.filter((d) => o.isReadOnly(d)).map((d) => d.name);
  /** Subagentes en segundo plano por tipo + prompt: uno idéntico en marcha no se vuelve a lanzar. */
  const launched = new Map<string, string>();
  return defineTool({
    name: AGENT_TOOL,
    description: [
      "Launches a subagent that works autonomously on a task in its own context window and returns a final report.",
      "Use it for work that would fill this conversation with intermediate output (broad searches, reading many files,",
      "a self-contained change), or to run independent investigations in parallel.",
      "- The subagent does not see this conversation. Write a self-contained prompt: the goal, relevant paths and",
      "  what the report must contain.",
      "- Only its final message comes back to you, and the user does not see it: relay what matters.",
      "- Launch several read-only agents in a single response to run them in parallel.",
      "- Do not delegate what a couple of direct tool calls can do: a single Read or grep is faster.",
      ...(o.tasks
        ? [
            "- Set run_in_background to keep working while a read-only agent runs: you get an id at once and its report",
            "  arrives later as a <background-notification>. Do not wait for it, poll or ask for it again; do other work or",
            `  end your turn. Read-only types now: ${readOnlyTypes.join(", ") || "none"}.`,
          ]
        : []),
      "",
      "Available agent types:",
      ...defs.map((d) => `- ${d.name}: ${clip(d.description)}`),
    ].join("\n"),
    // Sin registro de tareas (subagentes, replay sin él), el campo ni aparece: zod descarta las claves desconocidas.
    schema: (o.tasks ? full : base) as typeof full,
    // En segundo plano vuelve al momento sin escribir nada: se puede lanzar junto a otras lecturas.
    readOnly: (input) => o.isReadOnly(byName.get(input.subagent_type)!),
    permissionTarget: (input) => ({ kind: "agent", type: input.subagent_type }),

    async run(input, ctx) {
      const def = byName.get(input.subagent_type)!;
      const req = { def, description: input.description, prompt: input.prompt, callId: ctx.callId ?? "" };
      if (input.run_in_background && o.tasks) {
        // Solo lectura: un subagente que escribe chocaría con el principal y pediría permisos con el REPL libre.
        if (!o.isReadOnly(def))
          return {
            content: `run_in_background is only available for read-only agent types (${readOnlyTypes.join(", ") || "none"}); "${def.name}" can write. Run it in the foreground instead.`,
            isError: true,
          };
        // Los modelos pequeños entran en bucle relanzando el mismo subagente mientras esperan su informe.
        const key = `${def.name}\n${input.prompt}`;
        const same = launched.get(key);
        if (same && o.tasks.get(same)?.status === "running")
          return {
            content: `agent·${same} is already running this same task in the background. Its report will arrive as a notification; do not launch it again. Continue with other work, or end your turn if there is nothing else to do.`,
          };
        const t = o.tasks.start({
          kind: "agent",
          description: `${def.name} · ${input.description}`,
          run: async (signal, id) => {
            const r = await o.spawn({ ...req, signal, background: { id } });
            const out = result(r);
            return { status: r.reason === "error" ? "failed" : "completed", summary: `Report from the ${def.name} subagent:\n${out.content}` };
          },
        });
        launched.set(key, t.id);
        return {
          content: `Started agent·${t.id} (${def.name}) in the background. You do not have its report yet: do not guess what it will find or act on its results until its notification arrives. Do not wait or poll for it. Continue with other work, or end your turn if there is nothing else to do.`,
        };
      }
      return result(await o.spawn({ ...req, signal: ctx.signal }));
    },
  });
}
