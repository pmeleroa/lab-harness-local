import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { hashContent } from "./file-state.js";
import { defineTool, resolveReal } from "./types.js";

const DEFAULT_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export const readTool = defineTool({
  name: "Read",
  description: [
    "Reads a text file from the filesystem.",
    "- file_path can be absolute or relative to the workspace root.",
    `- Returns up to ${DEFAULT_LIMIT} lines by default; use offset/limit (1-based) to page through large files.`,
    "- Output uses `cat -n` format: line number, a tab, then the line.",
    "- You must Read a file before you Edit or overwrite it.",
    `- Lines longer than ${MAX_LINE_CHARS} characters are truncated.`,
  ].join("\n"),
  schema: z.object({
    file_path: z.string().describe("Path to the file"),
    offset: z.number().int().min(1).optional().describe("1-based line to start from"),
    limit: z.number().int().min(1).optional().describe("Number of lines to read"),
  }),
  readOnly: true,
  permissionTarget: (input, ctx) => ({ kind: "path", path: resolveReal(ctx.workspace, input.file_path), access: "read" }),

  async run(input, ctx) {
    const p = resolveReal(ctx.workspace, input.file_path);
    const st = await stat(p).catch(() => null);
    if (!st) return { content: `File does not exist: ${p}`, isError: true };
    if (st.isDirectory()) return { content: `${p} is a directory, not a file.`, isError: true };
    if (st.size > MAX_FILE_BYTES)
      return { content: `File is too large (${st.size} bytes). Use offset and limit on a smaller range, or Glob to find a smaller file.`, isError: true };

    const buf = await readFile(p);
    if (buf.subarray(0, 8192).includes(0)) return { content: `${p} appears to be a binary file.`, isError: true };

    ctx.fileState.record(p, { mtimeMs: st.mtimeMs, size: st.size, hash: hashContent(buf) });
    const text = buf.toString("utf8");
    if (text.length === 0) return { content: "(file is empty)" };

    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const start = (input.offset ?? 1) - 1;
    const end = Math.min(lines.length, start + (input.limit ?? DEFAULT_LIMIT));
    if (start >= lines.length)
      return { content: `offset ${input.offset} is beyond end of file (${lines.length} lines).`, isError: true };

    const width = String(end).length;
    const body = lines
      .slice(start, end)
      .map((l, i) => {
        const line = l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}… [line truncated]` : l;
        return `${String(start + i + 1).padStart(width)}\t${line}`;
      })
      .join("\n");

    const footer = end < lines.length ? `\n\n[Showing lines ${start + 1}-${end} of ${lines.length}. Use offset to read more.]` : "";
    return { content: body + footer };
  },
});
