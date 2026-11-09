import type { ToolUseBlock } from "../providers/canonical.js";
import type { PermissionTarget } from "../tools/types.js";
import { isInside } from "../tools/types.js";
import { type Rule, matchPath, parseRule } from "./rules.js";

export type PermissionMode = "default" | "acceptEdits" | "bypass";

export type Decision =
  | { kind: "allow"; reason: string }
  | { kind: "deny"; reason: string }
  | { kind: "ask"; reason: string };

export interface RuleSet {
  allow: string[];
  ask: string[];
  deny: string[];
}

export type RuleList = keyof RuleSet;

export interface PolicyConfig {
  /** Ruta real del workspace: el motor compara rutas ya resueltas con `realpath`. */
  workspace: string;
  mode: PermissionMode;
  rules: RuleSet;
}

export const emptyRules = (): RuleSet => ({ allow: [], ask: [], deny: [] });

export class PolicyEngine {
  private rules: Record<RuleList, Rule[]>;
  private sessionRules: Record<RuleList, Rule[]> = { allow: [], ask: [], deny: [] };

  constructor(private cfg: PolicyConfig) {
    this.rules = {
      allow: cfg.rules.allow.map(parseRule),
      ask: cfg.rules.ask.map(parseRule),
      deny: cfg.rules.deny.map(parseRule),
    };
  }

  get mode(): PermissionMode {
    return this.cfg.mode;
  }

  /** Reglas añadidas en caliente ("siempre" en el prompt). Viven solo en esta sesión. */
  addSessionRule(list: RuleList, raw: string): void {
    this.sessionRules[list].push(parseRule(raw));
  }

  evaluate(_call: ToolUseBlock, target: PermissionTarget): Decision {
    const d = this.evaluatePath(_call.name, target.path, target.access);
    // `bypass` convierte cualquier `ask` en `allow`; un `deny` no se toca.
    if (this.cfg.mode === "bypass" && d.kind === "ask") return { kind: "allow", reason: `bypass mode (${d.reason})` };
    return d;
  }

  /**
   * Regla para "siempre". Las rutas se gestionan con modos (`acceptEdits`), no con reglas ad hoc, así que solo se
   * sugiere para las lecturas fuera del workspace y las escrituras con ruta.
   */
  suggestRule(call: ToolUseBlock, target: PermissionTarget): string | null {
    return target.access === "read" ? `${call.name}(${target.path})` : null;
  }

  /**
   * Si una búsqueda (Glob, Grep) autorizada sobre `root` debe omitir este fichero: lo deniega una regla de lectura,
   * o lo marca una regla `ask` que no es la que ya se preguntó para la raíz. Solo cuentan las reglas con ruta.
   */
  hidesFromSearch(toolName: string, absPath: string, root: string): boolean {
    const tools = new Set([toolName, "Read"]);
    const hit = (list: RuleList, p: string) =>
      [...this.sessionRules[list], ...this.rules[list]].some(
        (r) => tools.has(r.tool) && !!r.specifier && matchPath(r.specifier, p, this.cfg.workspace),
      );
    if (hit("deny", absPath)) return true;
    return hit("ask", absPath) && !hit("ask", root);
  }

  private evaluatePath(toolName: string, absPath: string, access: "read" | "write"): Decision {
    // `Edit(...)` cubre también `Write`; `Read(...)` cubre Glob y Grep.
    const ruleTools = access === "write" ? new Set([toolName, "Edit"]) : new Set([toolName, "Read"]);
    const ruled = this.byRules((r) => ruleTools.has(r.tool) && (!r.specifier || matchPath(r.specifier, absPath, this.cfg.workspace)));
    if (ruled) return ruled;

    const inside = isInside(this.cfg.workspace, absPath);
    if (access === "read")
      return inside ? { kind: "allow", reason: "read inside workspace" } : { kind: "ask", reason: `read outside workspace: ${absPath}` };
    if (!inside) return { kind: "ask", reason: `write outside workspace: ${absPath}` };
    if (this.cfg.mode === "acceptEdits" || this.cfg.mode === "bypass")
      return { kind: "allow", reason: `${this.cfg.mode}: write inside workspace` };
    return { kind: "ask", reason: `write ${absPath}` };
  }

  /** deny > ask > allow, primero reglas de sesión y luego configuradas. */
  private byRules(pred: (r: Rule) => boolean): Decision | null {
    for (const list of ["deny", "ask", "allow"] as const) {
      const r = [...this.sessionRules[list], ...this.rules[list]].find(pred);
      if (r) return { kind: list, reason: `rule ${r.raw}` };
    }
    return null;
  }
}
