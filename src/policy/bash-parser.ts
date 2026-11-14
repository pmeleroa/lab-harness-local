import { createRequire } from "node:module";
import os from "node:os";
import { Language, type Node, Parser } from "web-tree-sitter";

/**
 * Descompone un script bash en comandos simples con tree-sitter.
 *
 * Por qué no regex ni prefijos de string: `git status && curl x | sh` empieza por
 * "git" pero ejecuta tres programas. La policy debe evaluar cada uno.
 */

export interface Token {
  value: string;
  /** Contiene expansiones ($VAR, $(…), ${…}): su valor real solo se conoce en runtime. */
  dynamic: boolean;
}

export interface SimpleCommand {
  argv: Token[];
  /** Texto original del comando (sin redirecciones). */
  text: string;
  /** Asignaciones prefijo: `FOO=1 cmd`. */
  assignments: string[];
}

export interface ParsedScript {
  commands: SimpleCommand[];
  /** Destinos de redirecciones de escritura (> >> &> >|). */
  writes: Token[];
  /** Motivos por los que el script no se puede evaluar estáticamente => ask. */
  problems: string[];
}

/** Variables que alteran qué se ejecuta o cómo: asignarlas nunca es inocuo. */
const DANGEROUS_ASSIGNMENTS = new Set([
  "PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "BASH_ENV",
  "ENV",
  "PROMPT_COMMAND",
  "IFS",
  "PS4",
  "GIT_SSH_COMMAND",
  "GIT_EXTERNAL_DIFF",
  "PAGER",
  "EDITOR",
]);

const EXPANSION_NODES = new Set([
  "simple_expansion",
  "expansion",
  "command_substitution",
  "process_substitution",
  "arithmetic_expansion",
  "ansi_c_string",
  "translated_string",
  "brace_expression",
]);

export class BashParser {
  private constructor(private parser: Parser) {}

  static async create(): Promise<BashParser> {
    const require = createRequire(import.meta.url);
    await Parser.init();
    const lang = await Language.load(require.resolve("tree-sitter-bash/tree-sitter-bash.wasm"));
    const parser = new Parser();
    parser.setLanguage(lang);
    return new BashParser(parser);
  }

  parse(script: string): ParsedScript {
    const out: ParsedScript = { commands: [], writes: [], problems: [] };
    const tree = this.parser.parse(script);
    if (!tree) {
      out.problems.push("command could not be parsed");
      return out;
    }
    try {
      if (tree.rootNode.hasError) out.problems.push("command has syntax errors or unsupported constructs");
      this.walk(tree.rootNode, out);
    } finally {
      tree.delete();
    }
    return out;
  }

  private walk(node: Node, out: ParsedScript): void {
    switch (node.type) {
      case "command":
        out.commands.push(this.command(node, out));
        break;
      case "file_redirect":
        this.redirect(node, out);
        break;
      case "function_definition":
        out.problems.push("defines a shell function");
        break;
      case "variable_assignment":
        if (node.parent?.type !== "command") this.assignment(node, out);
        break;
    }
    // Se recorre todo, incluido el interior de $(…), <(…), subshells, if/for/while...
    for (const c of node.namedChildren) if (c) this.walk(c, out);
  }

  private command(node: Node, out: ParsedScript): SimpleCommand {
    const argv: Token[] = [];
    const assignments: string[] = [];
    for (const c of node.namedChildren) {
      if (!c) continue;
      if (c.type === "variable_assignment") {
        assignments.push(c.text);
        this.assignment(c, out);
      } else if (c.type === "command_name") {
        const inner = c.namedChild(0);
        const t = inner ? word(inner) : { value: c.text, dynamic: false };
        if (t.dynamic) out.problems.push(`dynamic command name: ${c.text}`);
        argv.push(t);
      } else if (c.type === "file_redirect" || c.type === "heredoc_redirect" || c.type === "herestring_redirect") {
        // Se procesan en walk().
      } else {
        argv.push(word(c));
      }
    }
    return { argv, text: node.text, assignments };
  }

  private redirect(node: Node, out: ParsedScript): void {
    const op = node.children.find((c) => c && !c.isNamed)?.text ?? "";
    if (!op.includes(">")) return; // lectura: <, <<, <<<
    const dest = node.childForFieldName("destination");
    if (!dest) return;
    if (op.includes("&") && /^\d+$|^-$/.test(dest.text)) return; // 2>&1, >&-
    const t = word(dest);
    if (t.value === "/dev/null" || t.value === "/dev/stdout" || t.value === "/dev/stderr") return;
    out.writes.push(t);
  }

  private assignment(node: Node, out: ParsedScript): void {
    const name = node.childForFieldName("name")?.text ?? node.text.split("=")[0] ?? "";
    if (DANGEROUS_ASSIGNMENTS.has(name)) out.problems.push(`assigns ${name}`);
  }
}

/** Valor literal de una palabra bash con comillas resueltas, o marcado como dinámico. */
export function word(n: Node): Token {
  switch (n.type) {
    case "word": {
      // Expansión de tilde: `~` y `~/x` son el home; `~user` no se resuelve estáticamente.
      if (n.text === "~" || n.text.startsWith("~/")) return { value: os.homedir() + n.text.slice(1), dynamic: false };
      if (n.text.startsWith("~")) return { value: n.text, dynamic: true };
      return { value: n.text.replace(/\\(.)/g, "$1"), dynamic: false };
    }
    case "number":
      return { value: n.text, dynamic: false };
    case "raw_string":
      return { value: n.text.slice(1, -1), dynamic: false };
    case "string": {
      const dynamic = hasExpansion(n);
      const inner = n.text.slice(1, -1).replace(/\\([\\"$`])/g, "$1");
      return { value: inner, dynamic };
    }
    case "concatenation": {
      const parts = n.namedChildren.filter((c): c is Node => !!c).map(word);
      // Partes no nombradas (p.ej. '=' en --flag=valor) se pierden en namedChildren: usar el texto.
      const literal = parts.every((p) => !p.dynamic) && !n.text.startsWith("~");
      return { value: literal ? unquote(n.text) : n.text, dynamic: !literal };
    }
    default:
      if (EXPANSION_NODES.has(n.type)) return { value: n.text, dynamic: true };
      return { value: n.text, dynamic: hasExpansion(n) };
  }
}

function hasExpansion(n: Node): boolean {
  if (EXPANSION_NODES.has(n.type)) return true;
  for (const c of n.namedChildren) if (c && hasExpansion(c)) return true;
  return false;
}

/** Quita comillas de un texto bash sin expansiones. */
function unquote(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "'") {
      const end = s.indexOf("'", i + 1);
      out += s.slice(i + 1, end === -1 ? undefined : end);
      i = end === -1 ? s.length : end + 1;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') {
        if (s[j] === "\\" && j + 1 < s.length) {
          out += s[j + 1];
          j += 2;
        } else out += s[j++];
      }
      i = j + 1;
    } else if (ch === "\\" && i + 1 < s.length) {
      out += s[i + 1];
      i += 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}
