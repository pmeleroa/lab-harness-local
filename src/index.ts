import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { type AgentDefinition, loadAgents, mcpToolAllowed, toolsFor } from "./agents/loader.js";
import { Semaphore, type SubagentRun } from "./agents/runs.js";
import { Agent, type AgentConfig, ApprovalLock, type Approver, type RunResult, defaultAgentConfig, denyAllApprover } from "./core/loop.js";
import { BackgroundTasks, type TaskInfo, type TaskNotification, notificationBlocks } from "./core/background.js";
import { BashParser } from "./policy/bash-parser.js";
import { type PermissionMode, PolicyEngine, type RuleSet, emptyRules, narrowMode } from "./policy/engine.js";
import { type SandboxChoice, defaultHiddenPaths, detectSandbox } from "./policy/sandbox/index.js";
import { type AgentRef, EventBus } from "./core/events.js";
import { loadInstructions } from "./context/instructions.js";
import { DEFAULT_CONTEXT_WINDOW, OpenAIProvider } from "./providers/openai.js";
import type { Block, Message, Provider } from "./providers/canonical.js";
import { ToolRegistry } from "./tools/registry.js";
import { type SubagentRequest, createAgentTool } from "./tools/agent.js";
import type { Tool } from "./tools/types.js";
import { BackgroundShells, BashSession, createBashOutputTool, createBashTool, createKillShellTool } from "./tools/bash.js";
import { editTool } from "./tools/edit.js";
import { readTool } from "./tools/read.js";
import { globTool, grepTool } from "./tools/search.js";
import { writeTool } from "./tools/write.js";
import { type Skill, loadSkills, loadedSkills, skillCatalog } from "./skills/loader.js";
import { createSkillTool } from "./tools/skill.js";
import { HookRunner } from "./hooks/runner.js";
import { loadMcpConfig } from "./mcp/config.js";
import { McpManager } from "./mcp/manager.js";
import { createMcpTools, mcpServerOf } from "./tools/mcp.js";
import type { HookConfig } from "./policy/settings.js";
import {
  JsonlSessionStore,
  MemorySessionStore,
  type SessionStore,
  type SessionSummary,
  forkSession,
  listSessions,
  repairTranscript,
  resolveSession,
  sessionsDirOf,
  sessionsRoot,
  subagentsDir,
} from "./session/jsonl-store.js";

export const DEFAULT_MODEL = "qwen2.5:7b";
export const DEFAULT_BASE_URL = "http://localhost:11434/v1";
/** Subagentes corriendo a la vez como mucho; los demás esperan turno. */
export const MAX_CONCURRENT_SUBAGENTS = 4;
/** Turnos por defecto de un subagente cuyo tipo no fija maxTurns. */
const SUBAGENT_MAX_TURNS = 50;
/** Rondas de followUp por defecto: cada una es un run más con los avisos que hayan llegado. */
export const MAX_FOLLOW_UP_ROUNDS = 5;
/** Lo que followUp espera, como mucho, a que llegue el siguiente aviso. */
export const FOLLOW_UP_WAIT_MS = 10 * 60_000;

export interface HarnessOptions {
  /** Directorio sobre el que trabaja el harness. Fuera de él, el motor de permisos pregunta. */
  workspace?: string;
  /** `default` pregunta antes de escribir; `acceptEdits` escribe dentro del workspace; `bypass` no pregunta. */
  permissionMode?: PermissionMode;
  // Reglas `allow`, `ask` y `deny`, por ejemplo `Edit(src/**)` o `Bash(npm run *)`. `deny` gana siempre.
  /** Las de `.harness/settings.json`. */
  rules?: Partial<RuleSet>;
  /** Las de `--allow` y `--deny`: el registro `approval` las distingue de las de settings. */
  flagRules?: Partial<RuleSet>;
  /** Sandbox de los comandos: `auto` (bwrap en Linux, sandbox-exec en macOS), uno concreto o `none`. */
  sandbox?: SandboxChoice;
  /** Red dentro del sandbox: `host` (la del usuario) o `none` (sin red). */
  network?: "none" | "host";
  /** Hooks PreToolUse y PostToolUse (el bloque `hooks` de `.harness/settings.json`). Corren dentro del sandbox. */
  hooks?: HookConfig;
  /** false: no carga `<workspace>/.mcp.json`. */
  mcp?: boolean;
  /** false quita la tool Agent: sin subagentes (`--no-agents`). */
  agents?: boolean;
  /** Quién responde cuando el motor pregunta. Sin él, se deniega: fallar cerrado. */
  approver?: Approver;
  /** Sobrescribe $HARNESS_MODEL. */
  model?: string;
  /** Sobrescribe $OPENAI_BASE_URL. Debe incluir `/v1`. */
  baseURL?: string;
  /** Sustituye al modelo real: los tests inyectan un proveedor simulado. */
  provider?: Provider;
  config?: Partial<AgentConfig>;
  /** Transcript. Sin él, uno nuevo en `~/.harness/sessions/<clave del workspace>/` (o el que se retoma). */
  session?: SessionStore;
  /** Id (o prefijo) de una sesión de este workspace a continuar (`--resume`). Se ignora si se pasa `session`. */
  resume?: string;
  /** Continúa la sesión más reciente de este workspace (`--continue`). */
  continueLatest?: boolean;
  /** Con `resume` o `continueLatest`: continúa en una copia de la sesión (fork) en lugar de en su fichero. */
  forkSession?: boolean;
}

export interface Harness {
  agent: Agent;
  bus: EventBus;
  registry: ToolRegistry;
  policy: PolicyEngine;
  bash: BashSession;
  /** Comandos en segundo plano (Bash con run_in_background). */
  tasks: BackgroundTasks;
  /** Skills de `<workspace>/.harness/skills`. */
  skills: Skill[];
  /** Servidores MCP de `<workspace>/.mcp.json`, ya conectados (o fallidos). */
  mcp: McpManager;
  /** Tipos de subagente (integrados y de `<workspace>/.harness/agents`). Vacío si están desactivados. */
  agents: AgentDefinition[];
  /** Subagentes que han terminado en esta sesión, en orden: lo que consumieron aparte y lo que devolvieron. */
  subagentRuns: SubagentRun[];
  /** Transcript de esta invocación. */
  session: SessionStore;
  /** La sesión continuada al arrancar (`--resume` / `--continue`), si la hay. */
  resumed: SessionSummary | null;
  /** Directorio de los transcripts de este workspace. */
  sessionsDir: string;
  workspace: string;
  model: string;
  /** Avisos de arranque (por ejemplo, que se asume la ventana por defecto o que no hay sandbox). */
  warnings: string[];
  /** Fin del run: mata los comandos en segundo plano que sigan corriendo y avisa por el bus. Devuelve los que mató. */
  endRun(): Promise<TaskInfo[]>;
  /**
   * Headless, después del run: mientras queden subagentes en segundo plano (o sus avisos sin entregar), espera al
   * siguiente aviso y hace otro run con los avisos como prompt, hasta `maxRounds`. Lo que siga pendiente al agotar las
   * rondas, o tras `waitMs` sin que llegue ningún aviso, se mata con un aviso. Devuelve el último run de estas rondas,
   * o null si no hizo falta ninguno.
   */
  followUp(
    run: (prompt: Block[]) => Promise<RunResult>,
    o?: { maxRounds?: number; waitMs?: number; onWait?: (pending: TaskInfo[]) => void; onRound?: (notifications: TaskNotification[]) => void },
  ): Promise<RunResult | null>;
  dispose(): void;
}

export const SYSTEM_PROMPT = [
  "You are a coding assistant that works on the repository in the workspace.",
  "Grep searches file contents with a regular expression; Glob finds files by name. Use them to find where",
  "something is implemented, then Read the file. To change a file, Read it first and then use Edit with an exact",
  "old_string; use Write only to create a file. Use Bash to run commands such as tests or builds. If an action is",
  "denied, do not retry it: say so and ask the user how to proceed. Do not guess file contents. When you are done,",
  "answer concisely.",
].join("\n");

export async function createHarness(o: HarnessOptions = {}): Promise<Harness> {
  const resolved = path.resolve(o.workspace ?? process.cwd());
  // El motor compara rutas ya resueltas con `realpath`, así que el workspace también lo está.
  const workspace = realpathSync(resolved);
  const model = o.model ?? process.env.HARNESS_MODEL ?? DEFAULT_MODEL;
  const provider =
    o.provider ?? new OpenAIProvider({ baseURL: o.baseURL ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL });
  const warnings: string[] = [];
  if (!o.provider && !o.config?.contextWindow) {
    warnings.push(
      `La ventana de contexto no está fijada: se asumen ${DEFAULT_CONTEXT_WINDOW} tokens. Indícala con --context-window; ` +
        "un servidor con menos ventana recorta la conversación sin avisar.",
    );
  }

  // La raíz de las sesiones existe antes que cualquier sandbox: bwrap solo tapa las rutas ocultas que ya existen, y
  // Bash puede arrancar antes del primer mensaje. El fichero de la sesión, en cambio, no se crea hasta entonces.
  mkdirSync(sessionsRoot(), { recursive: true });

  // El sandbox se elige y se comprueba al arrancar: si no funciona, se avisa y los comandos corren sin él.
  const { sandbox, warning } = detectSandbox(o.sandbox ?? "auto");
  if (warning) warnings.push(warning);
  const bash = new BashSession({ workspace, sandbox, network: o.network ?? "host", hiddenPaths: defaultHiddenPaths() });

  // Skills: el catálogo (nombre y descripción) va al system prompt; el cuerpo, solo cuando el modelo la invoca.
  const loaded = loadSkills(workspace);
  const skills = loaded.skills;
  warnings.push(...loaded.warnings);

  const bus = new EventBus();
  const tasks = new BackgroundTasks({ bus });
  const network = o.network ?? "host";
  /**
   * Las tools de un agente. Cada agente (principal o subagente) tiene su propia BashSession, porque el cwd y el
   * entorno persisten entre llamadas, y su propia tool Skill, que mira si la skill ya está en *su* conversación.
   * Solo el principal lanza comandos en segundo plano (`shells`): la BashSession de un subagente muere con él.
   */
  const hasSkillTool = skills.some((s) => s.modelInvocable);
  const toolsOf = (sh: BashSession, visible: () => Message[], only?: string[], shells?: BackgroundShells): Tool[] =>
    [
      readTool,
      globTool,
      grepTool,
      writeTool,
      editTool,
      createBashTool(sh, shells),
      ...(shells ? [createBashOutputTool(shells), createKillShellTool(shells)] : []),
      // «Cargada» es lo que el modelo aún ve: si la limpieza quitó el cuerpo, se vuelve a dar entero.
      ...(hasSkillTool ? [createSkillTool(skills, (n) => loadedSkills(visible()).has(n))] : []),
    ].filter((t) => !only || only.includes(t.name)) as Tool[];
  // `agent` se crea más abajo: el callback solo se usa al ejecutar la tool.
  const registry = new ToolRegistry().register(...toolsOf(bash, () => agent.visibleMessages, undefined, new BackgroundShells(bash, tasks)));
  // Lo que un subagente puede recibir: las tools propias del principal (sin las MCP, que se filtran aparte).
  const baseTools = registry.names();

  // MCP: los servidores de .mcp.json son código del repositorio que se ejecuta al arrancar, dentro del mismo sandbox
  // que Bash (la CLI dice cuáles y con qué sandbox). Sus tools van detrás de las propias.
  const mcpConfig = o.mcp === false ? { servers: [], warnings: [] } : loadMcpConfig(workspace);
  warnings.push(...mcpConfig.warnings);
  const mcp = new McpManager(mcpConfig.servers, { workspace, sandbox, hiddenPaths: defaultHiddenPaths(), network: o.network ?? "host" });
  await mcp.connectAll();
  for (const s of mcp.servers()) if (s.status === "failed") warnings.push(`MCP server "${s.name}" failed to connect: ${s.error}`);
  registry.register(...createMcpTools(mcp, warnings));

  const policy = new PolicyEngine(
    {
      workspace,
      mode: o.permissionMode ?? "default",
      rules: { ...emptyRules(), ...o.rules },
      ...(o.flagRules ? { flagRules: o.flagRules } : {}),
      sessionsRoot: realpathSync(sessionsRoot()),
    },
    await BashParser.create(),
  );
  // Los hooks corren dentro del mismo sandbox que Bash: escritura solo en el workspace, sin credenciales y con la misma red.
  const hooks = new HookRunner(o.hooks ?? {}, {
    cwd: workspace,
    writablePaths: [workspace],
    hiddenPaths: defaultHiddenPaths(),
    network: o.network ?? "host",
    sandbox,
  });
  const instructions = loadInstructions(workspace);
  const catalog = skillCatalog(skills);
  /** System prompt de un agente; un subagente solo ve el catálogo de skills si tiene la tool Skill. */
  const systemFor = (withCatalog: boolean, extra?: string) => [
    { text: `${SYSTEM_PROMPT}\nWorkspace: ${workspace}` },
    ...(instructions ? [{ text: instructions }] : []),
    ...(withCatalog && catalog ? [{ text: catalog }] : []),
    ...(extra ? [{ text: extra }] : []),
  ];
  const approver = o.approver ?? denyAllApprover;
  const approvalLock = new ApprovalLock();
  const config = { ...defaultAgentConfig(model), ...o.config };
  const contextWindow = config.contextWindow ?? provider.capabilities.contextWindow;

  // Sesión: una nueva, la más reciente (--continue) o una concreta (--resume), y con --fork-session, una copia.
  const sessionsDir = sessionsDirOf(workspace);
  let resumed: SessionSummary | null = null;
  if (!o.session && o.resume) resumed = resolveSession(sessionsDir, o.resume);
  else if (!o.session && o.continueLatest) {
    resumed = listSessions(sessionsDir)[0] ?? null;
    if (!resumed) warnings.push("No previous session in this workspace: starting a new one.");
  }
  if (resumed && o.forkSession) resumed = forkSession(sessionsDir, resumed.file, { workspace, model, contextWindow });
  else if (o.forkSession && !o.session && !o.resume && !o.continueLatest) warnings.push("--fork-session needs --continue or --resume: ignored.");
  const session = o.session ?? new JsonlSessionStore(sessionsDir, resumed?.id);
  // Un `meta` en cada arranque, con el modelo y la ventana de ahora: retomar no los hereda de la sesión. Un fork ya
  // lleva el suyo, con forkedFrom. Lo de MCP va para que el replay pueda reconstruir las tools sin conectar.
  if (!(resumed && o.forkSession)) {
    const servers = mcp.servers();
    const mcpTools = registry.specs().filter((t) => t.name.startsWith("mcp__"));
    session.append({
      type: "meta",
      ts: new Date().toISOString(),
      sessionId: session.id,
      workspace,
      model,
      contextWindow,
      ...(servers.length || mcpTools.length
        ? { mcp: { servers: servers.map((x) => ({ name: x.name, status: x.status, transport: x.config.type, tools: x.tools.length })), tools: mcpTools } }
        : {}),
    });
  }
  // Retomar una sesión que usó tools MCP que ya no están: el modelo las verá en la conversación pero no podrá llamarlas.
  if (resumed) {
    const missing = new Set<string>();
    for (const r of JsonlSessionStore.readRecords(resumed.file))
      if (r.type === "message")
        for (const b of r.message.content) if (b.type === "tool_use" && b.name.startsWith("mcp__") && !registry.get(b.name)) missing.add(b.name);
    if (missing.size) warnings.push(`This session used MCP tools that are not available now: ${[...missing].join(", ")}.`);
  }

  // Subagentes: tipos integrados + .harness/agents. La tool Agent solo la tiene el agente principal.
  const agentsLoaded = o.agents === false ? { agents: [], warnings: [] } : loadAgents(workspace, baseTools);
  const agents = agentsLoaded.agents;
  warnings.push(...agentsLoaded.warnings);
  const subagentRuns: SubagentRun[] = [];
  const slots = new Semaphore(MAX_CONCURRENT_SUBAGENTS);

  /**
   * Un subagente es otro Agent con el mismo bucle: su conversación, sus tools, su política (más restrictiva o igual)
   * y su BashSession. Al principal solo vuelve lo que devuelva `run`, y de eso la tool Agent solo pasa el informe.
   */
  const spawn = async (req: SubagentRequest): Promise<RunResult> => {
    const { def } = req;
    const release = await slots.acquire();
    const uuid = randomUUID();
    const ref: AgentRef = req.background ? { id: req.background.id, type: def.name, background: true } : { id: uuid.slice(0, 8), type: def.name };
    const childModel = def.model ?? model;
    // Cada subagente, su transcript: en `<sesión>/agents/`, con la sesión que lo lanzó. Sus decisiones van ahí.
    const store: SessionStore =
      session instanceof JsonlSessionStore ? new JsonlSessionStore(subagentsDir(sessionsDir, session.id), uuid) : new MemorySessionStore();
    store.append({ type: "meta", ts: new Date().toISOString(), sessionId: uuid, workspace, model: childModel, parentSessionId: session.id, agentType: def.name });
    const childBash = new BashSession({ workspace, sandbox, network, hiddenPaths: defaultHiddenPaths() });
    const toolNames = toolsFor(def, baseTools);
    const childPolicy = policy.derive(def.mode);
    // Las MCP comparten las conexiones del principal. En plan no pasa ninguna (el lab no tiene `mcp.readOnly`), así
    // que ni se le dan: se denegarían igual.
    const childMcp = createMcpTools(mcp, []).filter((t) => mcpToolAllowed(def, t.name, mcpServerOf(t.name)) && childPolicy.mode !== "plan");
    const childRegistry = new ToolRegistry().register(...toolsOf(childBash, () => child.visibleMessages, toolNames), ...childMcp);
    const child: Agent = new Agent(
      {
        provider,
        registry: childRegistry,
        bus: bus.child(ref),
        workspace,
        system: systemFor(toolNames.includes("Skill"), subagentInstructions(def)),
        policy: childPolicy,
        approver,
        approvalLock,
        ref,
        hooks,
        session: store,
      },
      {
        ...config,
        model: childModel,
        maxTurns: Math.min(def.maxTurns ?? SUBAGENT_MAX_TURNS, config.maxTurns),
        maxToolCalls: Math.min(200, config.maxToolCalls),
      },
    );

    const t0 = Date.now();
    const bg = req.background ? { background: true as const } : {};
    bus.emit({ t: "subagent_start", id: ref.id, type: def.name, description: req.description, toolUseId: req.callId, ...bg });
    let r: RunResult;
    try {
      r = await child.run(req.prompt, req.signal);
    } finally {
      childBash.dispose();
      release();
    }
    const durationMs = Date.now() - t0;
    subagentRuns.push({
      id: ref.id,
      type: def.name,
      description: req.description,
      reason: r.reason,
      turns: r.turns,
      toolCalls: r.toolCalls,
      usage: r.usage,
      durationMs,
      peakContext: r.peakContext,
      reportTokens: Math.ceil(r.text.length / 4),
    });
    const file = store instanceof JsonlSessionStore ? store.file : undefined;
    session.append({
      type: "subagent",
      ts: new Date().toISOString(),
      id: uuid,
      agentType: def.name,
      description: req.description,
      reason: r.reason,
      turns: r.turns,
      usage: r.usage,
      ...(file ? { file } : {}),
    });
    bus.emit({
      t: "subagent_end",
      id: ref.id,
      type: def.name,
      toolUseId: req.callId,
      reason: r.reason,
      usage: r.usage,
      turns: r.turns,
      toolCalls: r.toolCalls,
      durationMs,
      peakContext: r.peakContext,
      ...bg,
    });
    return r;
  };

  if (agents.length)
    registry.register(createAgentTool(agents, { spawn, isReadOnly: (def) => narrowMode(policy.mode, def.mode) === "plan", tasks }));

  const agent = new Agent(
    {
      provider,
      registry,
      bus,
      workspace,
      system: systemFor(true),
      policy,
      approver,
      approvalLock,
      notifications: { drain: () => notificationBlocks(tasks.drain()) },
      hooks,
      session,
    },
    config,
  );

  // Retomar: solo la conversación, desde el último `compact`, y con los tool_use cortados reparados. El modo, los
  // «siempre», lo leído y el modelo y la ventana no vienen de la sesión: vienen de esta invocación.
  if (resumed) {
    const read = JsonlSessionStore.readMessages(resumed.file);
    const repaired = repairTranscript(read);
    // La reparación se escribe: si solo estuviera en memoria, la siguiente retomada (o un fork) leería otra vez el
    // tool_use sin su tool_result, ya en mitad de la conversación, donde repairTranscript no mira.
    if (repaired.length > read.length) session.append({ type: "message", ts: new Date().toISOString(), message: repaired.at(-1)! });
    agent.restore(repaired, session);
  }

  // Inicio y fin de cada tarea en segundo plano, en el transcript.
  bus.on((e) => {
    if (e.t === "task_start")
      session.append({ type: "task", ts: new Date().toISOString(), id: e.id, kind: e.kind, description: e.description, status: "running" });
    else if (e.t === "task_end")
      session.append({
        type: "task",
        ts: new Date().toISOString(),
        id: e.id,
        kind: e.kind,
        description: tasks.get(e.id)?.description ?? "",
        status: e.status,
        summary: e.summary,
        ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
      });
  });

  return {
    agent,
    bus,
    registry,
    policy,
    bash,
    tasks,
    skills,
    mcp,
    agents,
    subagentRuns,
    session,
    resumed,
    sessionsDir,
    workspace,
    model,
    warnings,
    endRun: async () => {
      const killed = await tasks.runEnd();
      for (const t of killed) bus.emit({ t: "warning", message: `Killed background ${t.kind}·${t.id} at the end of the run: ${t.description}` });
      return killed;
    },
    followUp: async (run, fo = {}) => {
      const max = fo.maxRounds ?? MAX_FOLLOW_UP_ROUNDS;
      const waitMs = fo.waitMs ?? FOLLOW_UP_WAIT_MS;
      const giveUp = async (why: string) => {
        for (const t of tasks.awaited()) {
          await tasks.kill(t.id, { notify: false, reason: `Killed ${why}.` });
          bus.emit({ t: "warning", message: `Killed background ${t.kind}·${t.id} ${why}: ${t.description}` });
        }
      };
      let last: RunResult | null = null;
      for (let round = 0; tasks.needsFollowUp(); round++) {
        if (round >= max) {
          await giveUp(`after ${max} follow-up rounds`);
          break;
        }
        if (!tasks.wakeups) {
          fo.onWait?.(tasks.awaited());
          const timeout = new AbortController();
          const timer = setTimeout(() => timeout.abort(), waitMs);
          await tasks.nextNotification(timeout.signal);
          clearTimeout(timer);
          if (!tasks.wakeups) {
            await giveUp(`after waiting ${Math.round(waitMs / 1000)}s for a notification`);
            break;
          }
        }
        const ns = tasks.drain();
        fo.onRound?.(ns);
        last = await run(notificationBlocks(ns));
        if (last.reason === "aborted" || last.reason === "error") break;
      }
      return last;
    },
    dispose: () => {
      tasks.disposeAll();
      bash.dispose();
      void mcp.dispose();
    },
  };
}

/** Lo que el subagente sabe de su papel, además de las instrucciones de su tipo. */
function subagentInstructions(def: AgentDefinition): string {
  return [
    "# Subagent",
    `You were launched by another agent as a "${def.name}" subagent. You do not see its conversation: the task you`,
    "received is all the context you have. You cannot ask questions; if something is ambiguous, make a reasonable",
    "choice and say so in your report. When you finish, your final message is returned to the caller as your report.",
    "",
    def.prompt,
  ].join("\n");
}

export { Agent, BackgroundTasks, BashParser, EventBus, McpManager, OpenAIProvider, ToolRegistry };
export type * from "./providers/canonical.js";
export type * from "./core/events.js";
export type { Approver, ApprovalAnswer, ApprovalRequest } from "./core/loop.js";
export { denyAllApprover } from "./core/loop.js";
export { PolicyEngine } from "./policy/engine.js";
export type { Decision, PermissionMode, RuleSet } from "./policy/engine.js";
export type { SandboxChoice } from "./policy/sandbox/index.js";
export type { AgentConfig, RunResult } from "./core/loop.js";
export type { ContextPolicy } from "./context/manager.js";
export type { Tool, ToolCtx, ToolOutput } from "./tools/types.js";
export type { AgentDefinition } from "./agents/loader.js";
export type { SubagentRun } from "./agents/runs.js";
export type { TaskInfo, TaskNotification } from "./core/background.js";
export type { SessionRecord, SessionStore, SessionSummary } from "./session/jsonl-store.js";
export { JsonlSessionStore, MemorySessionStore, sessionsDirOf, sessionsRoot, workspaceKey } from "./session/jsonl-store.js";
export { defineTool } from "./tools/types.js";
