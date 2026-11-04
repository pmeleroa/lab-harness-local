import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { type ToolOutput, defineTool, isInside, resolveInWorkspace } from "./types.js";

const MAX_GLOB_RESULTS = 100;
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
  const resolved = await resolveInWorkspace(workspace, p ?? ".");
  if (!resolved.ok) return resolved.error;
  const abs = resolved.path;
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

function rgFailure(r: RgResult, signal: AbortSignal): ToolOutput | null {
  if (signal.aborted) return { content: "[search interrupted by user]", isError: true };
  if (r.missing)
    return {
      content: "ripgrep (rg) is not installed or not in PATH. Glob needs it; tell the user to install it.",
      isError: true,
    };
  if (r.code === 2 && !r.stdout) return { content: r.stderr || "ripgrep failed", isError: true };
  return null;
}

export const globTool = defineTool({
  name: "Glob",
  description: [
    "Finds files by name with a glob pattern (e.g. `**/*.ts`, `src/**/*.test.ts`, `*.md`).",
    "- The pattern is relative to `path` (default: the workspace root). A pattern without `/` matches at any depth. Paths outside the workspace are rejected.",
    "- Respects .gitignore and skips .git; other hidden files are included.",
    `- Returns up to ${MAX_GLOB_RESULTS} paths, most recently modified first.`,
    "- Use it instead of `find` or `ls -R`.",
  ].join("\n"),
  schema: z.object({
    pattern: z.string().min(1).describe("Glob pattern, relative to path"),
    path: z.string().optional().describe("Directory to search in (default: workspace root)"),
  }),
  readOnly: true,

  async run(input, ctx) {
    const root = await searchRoot(ctx.workspace, input.path);
    if ("content" in root) return root;
    if (root.arg) return { content: `${input.path} is a file, not a directory.`, isError: true };

    const filter = nameFilter(input.pattern, false);
    const r = await runRg([...BASE_ARGS, ...filter.args, "--files", "--sortr=modified"], root.cwd, ctx.signal);
    const failed = rgFailure(r, ctx.signal);
    if (failed) return failed;

    const named = r.stdout.split("\n").filter((f) => f && filter.matches(f));
    const files = named;
    const notes: string[] = [];
    if (files.length > MAX_GLOB_RESULTS)
      notes.push(`[Showing ${MAX_GLOB_RESULTS} of ${files.length} files. Use a more specific pattern or path.]`);
    if (r.capped) notes.push("[Too many files under this path: only the most recently modified were checked. Narrow path.]");
    if (!files.length) return { content: ["No files found", ...notes].join("\n\n") };
    const shown = files.slice(0, MAX_GLOB_RESULTS).map((f) => displayPath(ctx.workspace, root.cwd, f));
    return { content: [shown.join("\n"), ...notes].join("\n\n") };
  },
});
