import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { type ToolOutput, defineTool, isInside, resolveReal, truncateMiddle } from "./types.js";

const MAX_GLOB_RESULTS = 100;
const DEFAULT_HEAD_LIMIT = 100;
const MAX_OUTPUT_CHARS = 30_000;
const MAX_LINE_COLUMNS = 500;
/** Lo que se lee de rg como mucho; más allá se mata el proceso y se avisa de que hay más. */
const STDOUT_CAP = 2 * 1024 * 1024;

/** `.git` nunca interesa; el resto de ocultos sí (`.github`, `.harness`, `.env.example`). */
const BASE_ARGS = ["--hidden", "--glob=!.git", "--color=never", "--no-config"];

interface RgResult {
  stdout: string;
  stderr: string;
  /** 0 = hay resultados, 1 = ninguno, 2 = error (puede venir con resultados parciales). */
  code: number | null;
  capped: boolean;
  missing: boolean;
}

function runRg(args: string[], cwd: string, signal: AbortSignal): Promise<RgResult> {
  return new Promise((resolve) => {
    const child = spawn(process.env.HARNESS_RG ?? "rg", args, { cwd, stdio: ["ignore", "pipe", "pipe"], signal });
    let stdout = "";
    let stderr = "";
    let capped = false;
    let missing = false;
    child.stdout.on("data", (d: Buffer) => {
      if (capped) return;
      stdout += d.toString("utf8");
      if (stdout.length > STDOUT_CAP) {
        capped = true;
        stdout = stdout.slice(0, stdout.lastIndexOf("\n", STDOUT_CAP));
        child.kill();
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") missing = true;
      else if (e.name !== "AbortError") stderr += e.message;
    });
    child.on("close", (code) => resolve({ stdout, stderr: stderr.trim(), code, capped, missing }));
  });
}

/**
 * Dónde lanzar rg. Los globs de rg son relativos al cwd, no a la ruta que se le pasa, así que se lanza
 * desde el directorio buscado. Si es un fichero, desde su directorio y con el fichero como argumento.
 */
async function searchRoot(workspace: string, p: string | undefined): Promise<{ cwd: string; arg?: string } | ToolOutput> {
  const abs = resolveReal(workspace, p ?? ".");
  const st = await stat(abs).catch(() => null);
  if (!st) return { content: `Path does not exist: ${abs}`, isError: true };
  return st.isDirectory() ? { cwd: abs } : { cwd: path.dirname(abs), arg: path.basename(abs) };
}

/** Rutas relativas al workspace cuando están dentro (menos tokens), absolutas si no. */
function displayPath(workspace: string, cwd: string, rel: string): string {
  const abs = path.resolve(cwd, rel);
  return isInside(workspace, abs) ? path.relative(workspace, abs) || "." : abs;
}

/**
 * Filtro por nombre que no pasa por encima de .gitignore: un --glob de rg que casa con un directorio (`src/**`,
 * `*`) vuelve a incluirlo entero, y con él node_modules. El filtro se aplica siempre sobre las rutas que devuelve
 * rg; sin `/`, contra el nombre del fichero (casa a cualquier profundidad). Además, si se puede, va a rg como tipo
 * propio para que no lea de más: los tipos solo miran el nombre del fichero y nunca ganan a .gitignore. Con otro
 * `type` no, porque varios tipos en rg se suman en lugar de intersecarse.
 */
function nameFilter(glob: string | undefined, otherType: boolean): { args: string[]; matches: (rel: string) => boolean } {
  if (!glob) return { args: [], matches: () => true };
  const anyDepth = !glob.includes("/");
  const args = anyDepth && !otherType && !glob.includes(":") ? [`--type-add=harness:${glob}`, "--type=harness"] : [];
  return { args, matches: (rel) => path.matchesGlob(anyDepth ? path.basename(rel) : rel.replace(/^\.\//, ""), glob) };
}

const excludedNote = (n: number) => (n ? [`[${n} file${n === 1 ? "" : "s"} excluded by permission rules]`] : []);

function rgFailure(r: RgResult, signal: AbortSignal): ToolOutput | null {
  if (signal.aborted) return { content: "[search interrupted by user]", isError: true };
  if (r.missing)
    return {
      content: "ripgrep (rg) is not installed or not in PATH. Glob and Grep need it; tell the user to install it.",
      isError: true,
    };
  if (r.code === 2 && !r.stdout) return { content: r.stderr || "ripgrep failed", isError: true };
  return null;
}

export const globTool = defineTool({
  name: "Glob",
  description: [
    "Finds files by name with a glob pattern (e.g. `**/*.ts`, `src/**/*.test.ts`, `*.md`).",
    "- The pattern is relative to `path` (default: the workspace root). A pattern without `/` matches at any depth.",
    "- Respects .gitignore and skips .git; other hidden files are included.",
    `- Returns up to ${MAX_GLOB_RESULTS} paths, most recently modified first.`,
    "- Use it instead of `find` or `ls -R`. To search file contents, use Grep.",
  ].join("\n"),
  schema: z.object({
    pattern: z.string().min(1).describe("Glob pattern, relative to path"),
    path: z.string().optional().describe("Directory to search in (default: workspace root)"),
  }),
  readOnly: true,
  permissionTarget: (input, ctx) => ({ kind: "path", path: resolveReal(ctx.workspace, input.path ?? "."), access: "read" }),

  async run(input, ctx) {
    const root = await searchRoot(ctx.workspace, input.path);
    if ("content" in root) return root;
    if (root.arg) return { content: `${input.path} is a file, not a directory.`, isError: true };

    const filter = nameFilter(input.pattern, false);
    const r = await runRg([...BASE_ARGS, ...filter.args, "--files", "--sortr=modified"], root.cwd, ctx.signal);
    const failed = rgFailure(r, ctx.signal);
    if (failed) return failed;

    const named = r.stdout.split("\n").filter((f) => f && filter.matches(f));
    const files = named.filter((f) => ctx.searchable?.(path.resolve(root.cwd, f)) ?? true);
    const notes = excludedNote(named.length - files.length);
    if (files.length > MAX_GLOB_RESULTS)
      notes.push(`[Showing ${MAX_GLOB_RESULTS} of ${files.length} files. Use a more specific pattern or path.]`);
    if (r.capped) notes.push("[Too many files under this path: only the most recently modified were checked. Narrow path.]");
    if (!files.length) return { content: ["No files found", ...notes].join("\n\n") };
    const shown = files.slice(0, MAX_GLOB_RESULTS).map((f) => displayPath(ctx.workspace, root.cwd, f));
    return { content: [shown.join("\n"), ...notes].join("\n\n") };
  },
});

export const grepTool = defineTool({
  name: "Grep",
  description: [
    "Searches file contents with a regular expression (ripgrep, Rust regex syntax: escape literal braces as `\\{`).",
    "- Respects .gitignore and skips .git; other hidden files are included.",
    "- Narrow with `glob` (e.g. `*.ts`, `src/**/*.tsx`) or `type` (ripgrep file type: ts, js, py, rust, go, java…).",
    "- output_mode: `files_with_matches` (default; paths, most recently modified first), `content` (matching lines",
    "  as path:line:text, with optional context lines) or `count` (matches per file).",
    `- Returns the first ${DEFAULT_HEAD_LIMIT} entries by default; change it with head_limit.`,
    "- Use it instead of grep/rg in Bash. To find files by name, use Glob.",
  ].join("\n"),
  schema: z.object({
    pattern: z.string().min(1).describe("Regular expression to search for"),
    path: z.string().optional().describe("File or directory to search in (default: workspace root)"),
    glob: z.string().optional().describe("Only search files matching this glob"),
    type: z.string().optional().describe("Only search files of this ripgrep type (ts, py, rust…)"),
    output_mode: z.enum(["files_with_matches", "content", "count"]).optional().describe("Default: files_with_matches"),
    case_insensitive: z.boolean().optional(),
    context: z.number().int().min(0).max(20).optional().describe("Lines of context around each match (content mode)"),
    multiline: z.boolean().optional().describe("Let the pattern span lines (`.` matches newlines)"),
    head_limit: z.number().int().min(1).optional().describe(`Max entries to return (default ${DEFAULT_HEAD_LIMIT})`),
  }),
  readOnly: true,
  permissionTarget: (input, ctx) => ({ kind: "path", path: resolveReal(ctx.workspace, input.path ?? "."), access: "read" }),

  async run(input, ctx) {
    const root = await searchRoot(ctx.workspace, input.path);
    if ("content" in root) return root;

    const mode = input.output_mode ?? "files_with_matches";
    const args = [...BASE_ARGS];
    if (mode === "files_with_matches") args.push("--files-with-matches", "--sortr=modified");
    else if (mode === "count") args.push("--count", "--with-filename", "--sort=path");
    else {
      args.push("--line-number", "--with-filename", "--no-heading", "--sort=path");
      args.push(`--max-columns=${MAX_LINE_COLUMNS}`, "--max-columns-preview");
      if (input.context) args.push(`--context=${input.context}`);
    }
    if (input.case_insensitive) args.push("--ignore-case");
    if (input.multiline) args.push("--multiline", "--multiline-dotall");
    const filter = nameFilter(input.glob, !!input.type);
    args.push(...filter.args);
    if (input.type) args.push(`--type=${input.type}`);
    // --null: la ruta termina en NUL en lugar de `:`, así que rutas con `:` o `-` no se confunden con el número de línea.
    args.push("--null", "--regexp", input.pattern, "--", root.arg ?? ".");

    const r = await runRg(args, root.cwd, ctx.signal);
    const failed = rgFailure(r, ctx.signal);
    if (failed) return failed;

    // En files_with_matches cada ruta acaba en NUL y no hay saltos de línea; en el resto, la ruta va hasta el NUL.
    const all = r.stdout.split(mode === "files_with_matches" ? "\0" : "\n").filter(Boolean);
    const pathOf = (l: string): string | null => (mode === "files_with_matches" ? l : l.includes("\0") ? l.slice(0, l.indexOf("\0")) : null);
    const excluded = new Set<string>();
    const kept = all.filter((l) => {
      const p = pathOf(l);
      if (p === null) return true; // separador `--` entre bloques de contexto
      if (!filter.matches(p)) return false;
      if (ctx.searchable && !ctx.searchable(path.resolve(root.cwd, p))) {
        excluded.add(p);
        return false;
      }
      return true;
    });
    // Sin separadores sueltos: al principio, al final o seguidos.
    const lines = kept.filter((l, i) => l !== "--" || (i > 0 && i < kept.length - 1 && kept[i - 1] !== "--"));
    if (!lines.some((l) => l !== "--")) return { content: ["No matches found", ...excludedNote(excluded.size)].join("\n\n") };

    const rewrite = (l: string): string => {
      if (mode === "files_with_matches") return displayPath(ctx.workspace, root.cwd, l);
      const i = l.indexOf("\0");
      if (i < 0) return l; // separador `--` entre bloques de contexto
      const rest = l.slice(i + 1);
      // count: path:N; content: path:N:texto (match) o path-N-texto (contexto).
      const sep = mode === "count" || /^\d+:/.test(rest) ? ":" : "-";
      return displayPath(ctx.workspace, root.cwd, l.slice(0, i)) + sep + rest;
    };

    const limit = input.head_limit ?? DEFAULT_HEAD_LIMIT;
    const shown = lines.slice(0, limit).map(rewrite);
    const notes = excludedNote(excluded.size);
    if (lines.length > limit || r.capped) {
      const total = r.capped ? `more than ${lines.length}` : String(lines.length);
      notes.push(`[Showing ${limit} of ${total} ${mode === "content" ? "lines" : "files"}. Narrow the search or raise head_limit.]`);
    }
    if (r.code === 2 && r.stderr) notes.push(`[some files could not be searched: ${r.stderr.split("\n")[0]}]`);
    return { content: truncateMiddle([shown.join("\n"), ...notes].join("\n\n"), MAX_OUTPUT_CHARS) };
  },
});
