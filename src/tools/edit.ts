import { readFile, stat, writeFile } from "node:fs/promises";
import { z } from "zod";
import { hashContent } from "./file-state.js";
import { defineTool, resolveInWorkspace } from "./types.js";

const CONTEXT_LINES = 4;

export const editTool = defineTool({
  name: "Edit",
  description: [
    "Performs an exact string replacement in a file.",
    "- You must Read the file first in this session.",
    "- old_string must match the file exactly, including whitespace and indentation.",
    "- old_string must be unique in the file; include more surrounding context to disambiguate,",
    "  or set replace_all to change every occurrence.",
    "- Do not include line-number prefixes from Read output in old_string.",
  ].join("\n"),
  schema: z.object({
    file_path: z.string().describe("Path to the file"),
    old_string: z.string().min(1).describe("Exact text to replace"),
    new_string: z.string().describe("Replacement text"),
    replace_all: z.boolean().optional().describe("Replace every occurrence (default false)"),
  }),
  readOnly: false,

  async run(input, ctx) {
    const resolved = await resolveInWorkspace(ctx.workspace, input.file_path);
    if (!resolved.ok) return resolved.error;
    const p = resolved.path;
    if (input.old_string === input.new_string)
      return { content: "old_string and new_string are identical; nothing to change.", isError: true };

    const err = await ctx.fileState.checkWritable(p);
    if (err) return { content: err, isError: true };

    const original = await readFile(p, "utf8").catch(() => null);
    if (original === null) return { content: `File does not exist: ${p}`, isError: true };

    const count = countOccurrences(original, input.old_string);
    if (count === 0) {
      const hint = /^\s*\d+\t/m.test(input.old_string)
        ? " It looks like old_string contains line-number prefixes from Read; remove them."
        : "";
      return { content: `old_string not found in ${p}.${hint}`, isError: true };
    }
    if (count > 1 && !input.replace_all)
      return {
        content: `old_string matches ${count} times in ${p}. Add surrounding context to make it unique, or set replace_all.`,
        isError: true,
      };

    const firstIdx = original.indexOf(input.old_string);
    const updated = input.replace_all
      ? original.split(input.old_string).join(input.new_string)
      : original.slice(0, firstIdx) + input.new_string + original.slice(firstIdx + input.old_string.length);

    await writeFile(p, updated, "utf8");
    const st = await stat(p);
    ctx.fileState.record(p, { mtimeMs: st.mtimeMs, size: st.size, hash: hashContent(updated) });

    const n = input.replace_all ? count : 1;
    return {
      content: `Edited ${p} (${n} replacement${n > 1 ? "s" : ""}).\n${snippet(updated, firstIdx, input.new_string)}`,
    };
  },
});

export function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Devuelve el fragmento editado con contexto, numerado como Read. */
function snippet(text: string, idx: number, inserted: string): string {
  const lines = text.split("\n");
  const startLine = text.slice(0, idx).split("\n").length - 1;
  const endLine = startLine + inserted.split("\n").length - 1;
  const from = Math.max(0, startLine - CONTEXT_LINES);
  const to = Math.min(lines.length, endLine + CONTEXT_LINES + 1);
  const width = String(to).length;
  return lines
    .slice(from, to)
    .map((l, i) => `${String(from + i + 1).padStart(width)}\t${l}`)
    .join("\n");
}
