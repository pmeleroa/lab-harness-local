import type { ToolUseBlock } from "../providers/canonical.js";
import type { PermissionTarget } from "../tools/types.js";
import { isInside, resolveReal } from "../tools/types.js";
import type { BashParser, SimpleCommand, Token } from "./bash-parser.js";
import { type Rule, matchCommand, matchPath, parseRule } from "./rules.js";

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

/** Comandos que solo leen. Se permiten sin regla salvo que sus flags escriban o ejecuten. */
const READ_ONLY_COMMANDS = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "echo", "printf", "which", "type", "file", "stat",
  "du", "df", "date", "whoami", "uname", "rg", "grep", "egrep", "fgrep", "tree", "uniq", "cut",
  "diff", "true", "false", "test", "[", "basename", "dirname", "realpath", "readlink", "jq",
  "sort", "find", "hostname", "id", "nproc", "seq", "tr", "column", "cmp", "md5sum", "sha256sum",
]);

const READ_ONLY_GIT = new Set([
  "status", "diff", "log", "show", "blame", "rev-parse", "ls-files", "ls-tree", "describe", "shortlog", "grep",
]);

/** Comandos que ejecutan otros comandos o código arbitrario: nunca se evalúan estáticamente. */
const OPAQUE_COMMANDS = new Set([
  "eval", "exec", "source", ".", "bash", "sh", "zsh", "dash", "ksh", "fish", "csh", "tcsh",
  "xargs", "env", "sudo", "doas", "su", "nohup", "timeout", "nice", "ionice", "time", "watch",
  "parallel", "command", "builtin", "ssh", "script", "chroot", "unshare", "nsenter", "strace",
]);

/** CLIs cuyo segundo token es un subcomando: la regla sugerida lo incluye. */
const SUBCOMMAND_TOOLS = new Set([
  "git", "npm", "pnpm", "yarn", "bun", "npx", "docker", "kubectl", "cargo", "go", "gh", "uv", "pip",
  "poetry", "terraform", "helm", "make", "dotnet", "mvn", "gradle", "./gradlew", "deno", "az", "aws", "gcloud",
]);

const INTERPRETERS = new Set(["python", "python3", "node", "deno", "bun", "perl", "ruby", "php", "lua", "osascript"]);
const INLINE_CODE_FLAGS = new Set(["-c", "-e", "--eval", "-p", "--print", "-r", "-E"]);
const FIND_EXEC_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);

export class PolicyEngine {
  private rules: Record<RuleList, Rule[]>;
  private sessionRules: Record<RuleList, Rule[]> = { allow: [], ask: [], deny: [] };

  constructor(
    private cfg: PolicyConfig,
    private bash: BashParser,
  ) {
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

  evaluate(call: ToolUseBlock, target: PermissionTarget): Decision {
    const d = this.evaluateRaw(call, target);
    // `bypass` convierte cualquier `ask` en `allow`; un `deny` no se toca.
    if (this.cfg.mode === "bypass" && d.kind === "ask") return { kind: "allow", reason: `bypass mode (${d.reason})` };
    return d;
  }

  /**
   * Regla para "siempre". Para un comando, el comando y su subcomando con `*`. Escribir se gestiona con modos
   * (`acceptEdits`), no con reglas ad hoc, así que en rutas solo se sugiere para una lectura, que es lo único que
   * pregunta fuera del workspace sin ser una escritura.
   */
  suggestRule(call: ToolUseBlock, target: PermissionTarget): string | null {
    if (target.kind === "command") {
      const parsed = this.bash.parse(target.command);
      const first = parsed.commands[0];
      if (parsed.commands.length !== 1 || parsed.problems.length || !first) return null;
      const lits = first.argv.filter((t) => !t.dynamic).map((t) => t.value);
      if (!lits.length) return null;
      // `git commit -m …` -> Bash(git commit *); `touch a.txt` -> Bash(touch *)
      const sub = lits[1];
      const head = SUBCOMMAND_TOOLS.has(lits[0]!) && sub && /^[a-z][\w:-]*$/i.test(sub) ? lits.slice(0, 2) : lits.slice(0, 1);
      return `${call.name}(${head.join(" ")} *)`;
    }
    if (target.kind === "path") return target.access === "read" ? `${call.name}(${target.path})` : null;
    return call.name;
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

  private evaluateRaw(call: ToolUseBlock, target: PermissionTarget): Decision {
    switch (target.kind) {
      case "path":
        return this.evaluatePath(call.name, target.path, target.access);
      case "command":
        return this.evaluateCommand(call.name, target.command);
      case "task":
        return this.byRules((r) => r.tool === call.name && !r.specifier) ?? { kind: "allow", reason: "own background task" };
    }
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

  private evaluateCommand(toolName: string, command: string): Decision {
    const parsed = this.bash.parse(command);
    let ask: string | null = parsed.problems[0] ?? null;

    // 1. Deny gana siempre, sobre cualquier subcomando, incluso en bypass.
    for (const c of parsed.commands) {
      const d = this.findRule("deny", toolName, c);
      if (d) return { kind: "deny", reason: `denied by rule ${d.raw}: ${c.text}` };
    }

    // 2. Cada subcomando necesita su propio permiso.
    for (const c of parsed.commands) {
      if (this.findRule("ask", toolName, c)) {
        ask ??= `matches ask rule: ${c.text}`;
        continue;
      }
      const opaque = opaqueReason(c.argv);
      if (opaque) {
        ask ??= `${opaque}: ${c.text}`;
        continue;
      }
      if (this.findRule("allow", toolName, c)) continue;
      if (isReadOnly(c.argv)) continue;
      ask ??= `run: ${c.text}`;
    }

    // 3. Las redirecciones son escrituras de fichero: se evalúan como Edit, sobre la ruta real.
    for (const w of parsed.writes) {
      if (w.dynamic) {
        ask ??= `redirect to dynamic path: ${w.value}`;
        continue;
      }
      const d = this.evaluatePath("Edit", resolveReal(this.cfg.workspace, w.value), "write");
      if (d.kind === "deny") return d;
      if (d.kind === "ask") ask ??= `redirect writes ${w.value}`;
    }

    if (parsed.commands.length === 0 && !ask) return { kind: "allow", reason: "no commands" };
    return ask ? { kind: "ask", reason: ask } : { kind: "allow", reason: "all subcommands allowed" };
  }

  private findRule(list: RuleList, toolName: string, c: SimpleCommand): Rule | undefined {
    const match = (r: Rule) => r.tool === toolName && (!r.specifier || matchCommand(r.specifier, c.argv));
    return this.sessionRules[list].find(match) ?? this.rules[list].find(match);
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

export function opaqueReason(argv: Token[]): string | null {
  const name = argv[0]?.value;
  if (!name) return null;
  const base = name.split("/").pop()!;
  if (OPAQUE_COMMANDS.has(base)) return `${base} executes arbitrary commands`;
  const args = argv.slice(1).map((t) => t.value);
  if (INTERPRETERS.has(base) && args.some((a) => INLINE_CODE_FLAGS.has(a))) return `${base} runs inline code`;
  if (base === "find" && args.some((a) => FIND_EXEC_FLAGS.has(a))) return "find with -exec/-delete";
  if (base === "git" && args.some((a) => a === "-c" || a.startsWith("--config-env"))) return "git with inline config";
  return null;
}

export function isReadOnly(argv: Token[]): boolean {
  const name = argv[0]?.value;
  if (!name || argv[0]!.dynamic) return false;
  const args = argv.slice(1).map((t) => t.value);
  if (name === "git") {
    const sub = args.find((a) => !a.startsWith("-"));
    return !!sub && READ_ONLY_GIT.has(sub) && !args.some((a) => a.startsWith("--output") || a === "--ext-diff");
  }
  if (!READ_ONLY_COMMANDS.has(name)) return false;
  if (name === "sort" && args.some((a) => a === "-o" || a.startsWith("--output"))) return false;
  return true;
}
