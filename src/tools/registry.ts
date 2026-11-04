import type { ToolSpec } from "../providers/canonical.js";
import { type Tool, toolSpec } from "./types.js";

export type ParsedCall =
  | { ok: true; tool: Tool; input: unknown }
  | { ok: false; error: string };

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private specCache: ToolSpec[] | null = null;

  register(...tools: Tool[]): this {
    for (const t of tools) {
      if (this.tools.has(t.name)) throw new Error(`Duplicate tool: ${t.name}`);
      this.tools.set(t.name, t);
    }
    this.specCache = null;
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Orden estable: cambiarlo invalida la caché de prompt. */
  specs(): ToolSpec[] {
    this.specCache ??= [...this.tools.values()].map(toolSpec);
    return this.specCache;
  }
  /** Si la llamada puede ir en paralelo con otras de solo lectura. Un input inválido falla sin efectos: también. */
  isReadOnly(name: string, rawInput: unknown): boolean {
    const parsed = this.parse(name, rawInput);
    if (!parsed.ok) return true;
    const ro = parsed.tool.readOnly;
    return typeof ro === "function" ? ro(parsed.input) : ro;
  }

  /** Valida el input del modelo. El error vuelve al modelo como tool_result para que se corrija. */
  parse(name: string, rawInput: unknown): ParsedCall {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: `Unknown tool: ${name}. Available tools: ${this.names().join(", ")}` };
    const r = tool.schema.safeParse(rawInput);
    if (!r.success) {
      const issues = r.error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
      return { ok: false, error: `Invalid input for ${name}:\n${issues}` };
    }
    return { ok: true, tool, input: r.data };
  }
}
