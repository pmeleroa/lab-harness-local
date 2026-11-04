import path from "node:path";
import { Agent, type AgentConfig, defaultAgentConfig } from "./core/loop.js";
import { EventBus } from "./core/events.js";
import { OpenAIProvider } from "./providers/openai.js";
import type { Provider } from "./providers/canonical.js";
import { ToolRegistry } from "./tools/registry.js";
import { readTool } from "./tools/read.js";
import { globTool } from "./tools/search.js";

export const DEFAULT_MODEL = "qwen2.5:7b";
export const DEFAULT_BASE_URL = "http://localhost:11434/v1";

export interface HarnessOptions {
  /** Directorio sobre el que trabaja el agente. Las herramientas no salen de él. */
  workspace?: string;
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
  workspace: string;
  model: string;
}

export const SYSTEM_PROMPT = [
  "You are a coding assistant that answers questions about the repository in the workspace.",
  "You can only read: use Glob to find files by name and Read to read them. Do not guess file contents.",
  "When you have enough information, answer concisely.",
].join("\n");

export function createHarness(o: HarnessOptions = {}): Harness {
  const workspace = path.resolve(o.workspace ?? process.cwd());
  const model = o.model ?? process.env.HARNESS_MODEL ?? DEFAULT_MODEL;
  const provider =
    o.provider ?? new OpenAIProvider({ baseURL: o.baseURL ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL });
  const registry = new ToolRegistry().register(readTool, globTool);
  const bus = new EventBus();
  const agent = new Agent(
    { provider, registry, bus, workspace, system: [{ text: `${SYSTEM_PROMPT}\nWorkspace: ${workspace}` }] },
    { ...defaultAgentConfig(model), ...o.config },
  );
  return { agent, bus, registry, workspace, model };
}

export { Agent, EventBus, OpenAIProvider, ToolRegistry };
export type * from "./providers/canonical.js";
export type * from "./core/events.js";
export type { AgentConfig, RunResult } from "./core/loop.js";
export type { Tool, ToolCtx, ToolOutput } from "./tools/types.js";
export { defineTool } from "./tools/types.js";
