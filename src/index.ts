import { realpathSync } from "node:fs";
import path from "node:path";
import { Agent, type AgentConfig, type Approver, defaultAgentConfig, denyAllApprover } from "./core/loop.js";
import { BackgroundTasks, type TaskInfo, notificationBlocks } from "./core/background.js";
import { BashParser } from "./policy/bash-parser.js";
import { type PermissionMode, PolicyEngine, type RuleSet, emptyRules } from "./policy/engine.js";
import { type SandboxChoice, defaultHiddenPaths, detectSandbox } from "./policy/sandbox/index.js";
import { EventBus } from "./core/events.js";
import { loadInstructions } from "./context/instructions.js";
import { DEFAULT_CONTEXT_WINDOW, OpenAIProvider } from "./providers/openai.js";
import type { Provider } from "./providers/canonical.js";
import { ToolRegistry } from "./tools/registry.js";
import { BackgroundShells, BashSession, createBashOutputTool, createBashTool, createKillShellTool } from "./tools/bash.js";
import { editTool } from "./tools/edit.js";
import { readTool } from "./tools/read.js";
import { globTool, grepTool } from "./tools/search.js";
import { writeTool } from "./tools/write.js";

export const DEFAULT_MODEL = "qwen2.5:7b";
export const DEFAULT_BASE_URL = "http://localhost:11434/v1";

export interface HarnessOptions {
  /** Directorio sobre el que trabaja el harness. Fuera de él, el motor de permisos pregunta. */
  workspace?: string;
  /** `default` pregunta antes de escribir; `acceptEdits` escribe dentro del workspace; `bypass` no pregunta. */
  permissionMode?: PermissionMode;
  // Reglas `allow`, `ask` y `deny`, por ejemplo `Edit(src/**)` o `Bash(npm run *)`. `deny` gana siempre.
  rules?: Partial<RuleSet>;
  /** Sandbox de los comandos: `auto` (bwrap en Linux, sandbox-exec en macOS), uno concreto o `none`. */
  sandbox?: SandboxChoice;
  /** Red dentro del sandbox: `host` (la del usuario) o `none` (sin red). */
  network?: "none" | "host";
  /** Quién responde cuando el motor pregunta. Sin él, se deniega: fallar cerrado. */
  approver?: Approver;
  /** Sobrescribe $HARNESS_MODEL. */
  model?: string;
  /** Sobrescribe $OPENAI_BASE_URL. Debe incluir `/v1`. */
  baseURL?: string;
  /** Sustituye al modelo real: los tests inyectan un proveedor simulado. */
  provider?: Provider;
  config?: Partial<AgentConfig>;
}

export interface Harness {
  agent: Agent;
  bus: EventBus;
  registry: ToolRegistry;
  policy: PolicyEngine;
  bash: BashSession;
  /** Comandos en segundo plano (Bash con run_in_background). */
  tasks: BackgroundTasks;
  workspace: string;
  model: string;
  /** Avisos de arranque (por ejemplo, que se asume la ventana por defecto o que no hay sandbox). */
  warnings: string[];
  /** Fin del run: mata los comandos en segundo plano que sigan corriendo y avisa por el bus. Devuelve los que mató. */
  endRun(): Promise<TaskInfo[]>;
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

  // El sandbox se elige y se comprueba al arrancar: si no funciona, se avisa y los comandos corren sin él.
  const { sandbox, warning } = detectSandbox(o.sandbox ?? "auto");
  if (warning) warnings.push(warning);
  const bash = new BashSession({ workspace, sandbox, network: o.network ?? "host", hiddenPaths: defaultHiddenPaths() });

  const bus = new EventBus();
  const tasks = new BackgroundTasks({ bus });
  const shells = new BackgroundShells(bash, tasks);
  const registry = new ToolRegistry().register(
    readTool,
    globTool,
    grepTool,
    writeTool,
    editTool,
    createBashTool(bash, shells),
    createBashOutputTool(shells),
    createKillShellTool(shells),
  );
  const policy = new PolicyEngine(
    {
      workspace,
      mode: o.permissionMode ?? "default",
      rules: { ...emptyRules(), ...o.rules },
    },
    await BashParser.create(),
  );
  const instructions = loadInstructions(workspace);
  const system = [{ text: `${SYSTEM_PROMPT}\nWorkspace: ${workspace}` }, ...(instructions ? [{ text: instructions }] : [])];
  const agent = new Agent(
    {
      provider,
      registry,
      bus,
      workspace,
      system,
      policy,
      approver: o.approver ?? denyAllApprover,
      notifications: { drain: () => notificationBlocks(tasks.drain()) },
    },
    { ...defaultAgentConfig(model), ...o.config },
  );
  return {
    agent,
    bus,
    registry,
    policy,
    bash,
    tasks,
    workspace,
    model,
    warnings,
    endRun: async () => {
      const killed = await tasks.runEnd();
      for (const t of killed) bus.emit({ t: "warning", message: `Killed background ${t.kind}·${t.id} at the end of the run: ${t.description}` });
      return killed;
    },
    dispose: () => {
      tasks.disposeAll();
      bash.dispose();
    },
  };
}

export { Agent, BackgroundTasks, BashParser, EventBus, OpenAIProvider, ToolRegistry };
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
export { defineTool } from "./tools/types.js";
