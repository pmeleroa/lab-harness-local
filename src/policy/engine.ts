import path from "node:path";
import type { ToolUseBlock } from "../providers/canonical.js";
import type { PermissionTarget } from "../tools/types.js";
import { isInside, resolveReal } from "../tools/types.js";
import type { BashParser, SimpleCommand, Token } from "./bash-parser.js";
import type { RuleSource } from "../session/jsonl-store.js";
import { type Rule, matchCommand, matchMcpRule, matchPath, parseRule } from "./rules.js";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypass";

/** De más a menos restrictivo. Un subagente nunca puede tener un modo más permisivo que quien lo lanza. */
const MODE_ORDER: PermissionMode[] = ["plan", "default", "acceptEdits", "bypass"];

/** El más restrictivo de los dos. */
export function narrowMode(current: PermissionMode, requested?: PermissionMode): PermissionMode {
  if (!requested) return current;
  return MODE_ORDER.indexOf(requested) < MODE_ORDER.indexOf(current) ? requested : current;
}

/**
 * Quién decide, sin tener que leer `reason`: una regla (con la regla y de dónde viene), el modo de permisos o la
 * política del motor (el perímetro del workspace, lo que solo lee, el target `agent`, la tarea propia).
 */
export type DecisionOrigin = "rule" | "mode" | "policy";

export interface Decision {
  kind: "allow" | "deny" | "ask";
  reason: string;
  origin: DecisionOrigin;
  rule?: string;
  ruleSource?: RuleSource;
}

/** Una regla y de dónde viene: `.harness/settings.json`, `--allow`/`--deny`, un «siempre» o el propio harness. */
type SourcedRule = Rule & { source: RuleSource };

const policy = (kind: Decision["kind"], reason: string): Decision => ({ kind, reason, origin: "policy" });
const byMode = (kind: Decision["kind"], reason: string): Decision => ({ kind, reason, origin: "mode" });
const byRule = (kind: Decision["kind"], r: SourcedRule, reason = `rule ${r.raw}`): Decision => ({
  kind,
  reason,
  origin: "rule",
  rule: r.raw,
  ruleSource: r.source,
});

/** Lo que el agente nunca escribe, en ningún modo: sus propios transcripts. */
export const SESSIONS_RULE = "Edit(~/.harness/sessions/**)";
export const SESSIONS_DENY_REASON = "session transcripts are read-only for the agent";

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
  /** Reglas de `.harness/settings.json`. */
  rules: RuleSet;
  /** Reglas de `--allow` y `--deny`: van detrás de las de settings. */
  flagRules?: Partial<RuleSet>;
  /** Ruta real de `~/.harness/sessions`: ninguna escritura del agente pasa ahí, ni en `bypass`. */
  sessionsRoot?: string;
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
  private rules: Record<RuleList, SourcedRule[]>;
  private sessionRules: Record<RuleList, SourcedRule[]> = { allow: [], ask: [], deny: [] };

  constructor(
    private cfg: PolicyConfig,
    private bash: BashParser,
  ) {
    const load = (list: RuleList): SourcedRule[] => [
      ...cfg.rules[list].map((raw) => ({ ...parseRule(raw), source: "settings" as const })),
      ...(cfg.flagRules?.[list] ?? []).map((raw) => ({ ...parseRule(raw), source: "flag" as const })),
    ];
    this.rules = { allow: load("allow"), ask: load("ask"), deny: load("deny") };
  }

  get mode(): PermissionMode {
    return this.cfg.mode;
  }

  /**
   * Política para un subagente: las mismas reglas, las de sesión copiadas hasta ahora y un modo que solo
   * puede ser igual o más restrictivo. Lo que el hijo acepte con "siempre" se queda en el hijo.
   */
  derive(mode?: PermissionMode): PolicyEngine {
    const child = new PolicyEngine({ ...this.cfg, mode: narrowMode(this.cfg.mode, mode) }, this.bash);
    child.rules = this.rules;
    child.sessionRules = { allow: [...this.sessionRules.allow], ask: [...this.sessionRules.ask], deny: [...this.sessionRules.deny] };
    return child;
  }

  /** Reglas añadidas en caliente ("siempre" en el prompt). Viven solo en esta sesión. */
  addSessionRule(list: RuleList, raw: string): void {
    this.sessionRules[list].push({ ...parseRule(raw), source: "session" });
  }

  evaluate(call: ToolUseBlock, target: PermissionTarget): Decision {
    const d = this.evaluateRaw(call, target);
    if (this.cfg.mode === "plan" && d.kind !== "deny") {
      // En `plan` solo se lee: lo que puede escribir se deniega aunque una regla allow lo permita, y lo que
      // requiere confirmación, también. Las reglas no amplían `plan`, y paralelo y segundo plano cuentan con ello.
      const write = this.planWrite(target);
      if (write) return byMode("deny", `plan mode: ${write}`);
      if (d.kind === "ask") return byMode("deny", `plan mode: ${d.reason}`);
    }
    // `bypass` convierte cualquier `ask` en `allow`; un `deny` no se toca.
    if (this.cfg.mode === "bypass" && d.kind === "ask") return byMode("allow", `bypass mode (${d.reason})`);
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

  /**
   * Por qué un objetivo puede escribir, o null si solo lee: escribir una ruta, un comando que no es de solo lectura
   * (o que ejecuta otros) y cualquier redirección a fichero. No mira reglas: es lo que `plan` deniega siempre.
   */
  private planWrite(target: PermissionTarget): string | null {
    if (target.kind === "path") return target.access === "write" ? `write ${target.path}` : null;
    if (target.kind !== "command") return null;
    const parsed = this.bash.parse(target.command);
    if (parsed.problems[0]) return parsed.problems[0];
    for (const c of parsed.commands) {
      const opaque = opaqueReason(c.argv);
      if (opaque) return `${opaque}: ${c.text}`;
      if (!isReadOnly(c.argv)) return `run: ${c.text}`;
    }
    const w = parsed.writes[0];
    return w ? `redirect writes ${w.value}` : null;
  }

  private evaluateRaw(call: ToolUseBlock, target: PermissionTarget): Decision {
    switch (target.kind) {
      case "path":
        return this.evaluatePath(call.name, target.path, target.access);
      case "command":
        return this.evaluateCommand(call.name, target.command, target.cwd ?? this.cfg.workspace);
      case "agent":
        // Lanzar no pregunta: cada cosa que haga el subagente pasa por su propia política. `Agent` o
        // `Agent(<tipo>)` en una regla sí cuentan.
        return (
          this.byRules((r) => r.tool === call.name && (!r.specifier || r.specifier === target.type)) ??
          policy("allow", `subagent ${target.type}: its tools go through its own policy`)
        );
      case "task":
        return this.byRules((r) => r.tool === call.name && !r.specifier) ?? policy("allow", "own background task");
      case "mcp":
        return this.evaluateMcp(call.name, target.server);
    }
  }

  /**
   * Por defecto preguntan. Lo que declare el servidor (readOnlyHint) no cuenta. Un deny gana siempre. En `plan` no
   * pasa ninguna, y ni una regla allow las abre: el lab no tiene la lista de tools de solo lectura de `harness`
   * (`mcp.readOnly`, de los settings de usuario), así que se comporta como `harness` con esa lista vacía.
   */
  private evaluateMcp(toolName: string, server: string): Decision {
    const hit = (r: Rule) => !r.specifier && matchMcpRule(r.tool, toolName, server);
    const all = (list: RuleList) => [...this.sessionRules[list], ...this.rules[list]];
    const deny = all("deny").find(hit);
    if (deny) return byRule("deny", deny);
    if (this.cfg.mode === "plan") return byMode("deny", `plan mode: ${toolName} is not marked read-only`);
    const ask = all("ask").find(hit);
    if (ask) return byRule("ask", ask);
    const allow = all("allow").find(hit);
    if (allow) return byRule("allow", allow);
    return policy("ask", `${toolName} (MCP server "${server}") requires approval`);
  }

  private evaluatePath(toolName: string, absPath: string, access: "read" | "write"): Decision {
    // Los transcripts: antes que cualquier regla allow, y un deny que ni `bypass` toca. Leerlos no se prohíbe: están
    // fuera del workspace, así que preguntan (y en `plan`, se deniegan).
    const root = this.cfg.sessionsRoot;
    if (access === "write" && root && isInside(root, absPath))
      return byRule("deny", { raw: SESSIONS_RULE, tool: "Edit", source: "builtin" }, SESSIONS_DENY_REASON);
    // `Edit(...)` cubre también `Write`; `Read(...)` cubre Glob y Grep.
    const ruleTools = access === "write" ? new Set([toolName, "Edit"]) : new Set([toolName, "Read"]);
    const ruled = this.byRules((r) => ruleTools.has(r.tool) && (!r.specifier || matchPath(r.specifier, absPath, this.cfg.workspace)));
    if (ruled) return ruled;

    const inside = isInside(this.cfg.workspace, absPath);
    if (access === "read") return inside ? policy("allow", "read inside workspace") : policy("ask", `read outside workspace: ${absPath}`);
    if (!inside) return policy("ask", `write outside workspace: ${absPath}`);
    if (this.cfg.mode === "acceptEdits" || this.cfg.mode === "bypass") return byMode("allow", `${this.cfg.mode}: write inside workspace`);
    return policy("ask", `write ${absPath}`);
  }

  private evaluateCommand(toolName: string, command: string, cwd: string): Decision {
    const parsed = this.bash.parse(command);
    let ask: string | null = parsed.problems[0] ?? null;
    /** La regla `ask` que hizo preguntar, si fue una. */
    let askRule: SourcedRule | null = null;
    /** La primera regla `allow` que dejó pasar un subcomando: si todo pasa, decidió una regla y no la política. */
    let allowedBy: SourcedRule | null = null;

    // 1. Deny gana siempre, sobre cualquier subcomando, incluso en bypass.
    for (const c of parsed.commands) {
      const d = this.findRule("deny", toolName, c);
      if (d) return byRule("deny", d, `denied by rule ${d.raw}: ${c.text}`);
    }

    // 2. Cada subcomando necesita su propio permiso.
    for (const c of parsed.commands) {
      const askHit = this.findRule("ask", toolName, c);
      if (askHit) {
        if (ask === null) askRule = askHit;
        ask ??= `matches ask rule: ${c.text}`;
        continue;
      }
      const opaque = opaqueReason(c.argv);
      if (opaque) {
        ask ??= `${opaque}: ${c.text}`;
        continue;
      }
      const allowHit = this.findRule("allow", toolName, c);
      if (allowHit) {
        allowedBy ??= allowHit;
        continue;
      }
      if (isReadOnly(c.argv)) continue;
      ask ??= `run: ${c.text}`;
    }

    // 3. Las redirecciones son escrituras de fichero: se evalúan como Edit, sobre la ruta real, desde el directorio
    // del shell. Si el script cambia de directorio, una ruta relativa puede escribir desde cualquiera de ellos: se
    // evalúa desde todos los que se conocen, y siempre se pregunta.
    const dirs = scriptDirs(parsed.commands, cwd);
    for (const w of parsed.writes) {
      if (w.dynamic) {
        ask ??= `redirect to dynamic path: ${w.value}`;
        continue;
      }
      const relative = !path.isAbsolute(w.value);
      if (relative && dirs.unknown) {
        // No se puede saber qué fichero es, así que ningún deny se puede comprobar: en bypass no basta con preguntar.
        const reason = `redirect ${w.value} after a directory change to an unknown path`;
        if (this.cfg.mode === "bypass") return byMode("deny", reason);
        ask ??= reason;
      }
      for (const dir of relative ? dirs.known : [cwd]) {
        const d = this.evaluatePath("Edit", resolveReal(dir, w.value), "write");
        if (d.kind === "deny") return d;
        if (d.kind === "ask") ask ??= `redirect writes ${w.value}`;
      }
      if (relative && dirs.known.length > 1) ask ??= `redirect ${w.value} after a directory change`;
    }

    if (parsed.commands.length === 0 && !ask) return policy("allow", "no commands");
    if (ask) return askRule ? byRule("ask", askRule, ask) : policy("ask", ask);
    return allowedBy ? byRule("allow", allowedBy, "all subcommands allowed") : policy("allow", "all subcommands allowed");
  }

  private findRule(list: RuleList, toolName: string, c: SimpleCommand): SourcedRule | undefined {
    const match = (r: Rule) => r.tool === toolName && (!r.specifier || matchCommand(r.specifier, c.argv));
    return this.sessionRules[list].find(match) ?? this.rules[list].find(match);
  }

  /** deny > ask > allow, primero reglas de sesión y luego configuradas. */
  private byRules(pred: (r: Rule) => boolean): Decision | null {
    for (const list of ["deny", "ask", "allow"] as const) {
      const r = [...this.sessionRules[list], ...this.rules[list]].find(pred);
      if (r) return byRule(list, r);
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
  // rg --pre ejecuta un programa por cada fichero que busca; sort --compress-program, uno para sus temporales.
  if (base === "rg" && args.some((a) => a === "--pre" || a.startsWith("--pre="))) return "rg with --pre runs a command";
  if (base === "sort" && args.some((a) => a.startsWith("--compress-program"))) return "sort with --compress-program runs a command";
  // git grep -O abre los ficheros encontrados con el programa que se le pase (o el paginador).
  if (base === "git" && args.includes("grep") && args.some((a) => a.startsWith("-O") || a.startsWith("--open-files-in-pager")))
    return "git grep with --open-files-in-pager runs a command";
  return null;
}

/** Comandos que cambian el directorio del shell. */
const DIR_CHANGE_COMMANDS = new Set(["cd", "pushd", "popd"]);

/**
 * Directorios desde los que puede escribir una ruta relativa del script: el cwd del shell y, en orden, el destino de
 * cada `cd`/`pushd` con un argumento literal. Uno sin argumento (el home), `cd -`, `popd` o un destino dinámico dejan
 * el directorio sin determinar (`unknown`). Es conservador: no distingue subshells ni ramas de un `if`.
 */
export function scriptDirs(commands: SimpleCommand[], cwd: string): { known: string[]; unknown: boolean } {
  const known = [cwd];
  let unknown = false;
  for (const c of commands) {
    const name = c.argv[0];
    if (!name || name.dynamic || !DIR_CHANGE_COMMANDS.has(name.value)) continue;
    const arg = c.argv.slice(1).find((t) => t.dynamic || !t.value.startsWith("-") || t.value === "-");
    if (name.value === "popd" || !arg || arg.dynamic || arg.value === "-") {
      unknown = true;
      continue;
    }
    known.push(path.resolve(known.at(-1)!, arg.value));
  }
  return { known, unknown };
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
  // `uniq entrada salida` escribe en su segundo fichero; `tree -o fichero`, en ese fichero. Se cuentan como argumentos
  // todos los que no empiezan por `-`, también el valor de una opción: mejor preguntar de más.
  if (name === "uniq" && args.filter((a) => !a.startsWith("-")).length >= 2) return false;
  if (name === "tree" && args.some((a) => /^-[^-]*o/.test(a))) return false;
  return true;
}
