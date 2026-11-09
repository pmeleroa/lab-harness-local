import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { hashContent } from "./file-state.js";
import { defineTool, resolveInWorkspace } from "./types.js";

export const writeTool = defineTool({
  name: "Write",
  description: [
    "Creates a new file or fully overwrites an existing one.",
    "- Overwriting an existing file requires having Read it first.",
    "- Prefer Edit for partial changes to existing files: it is cheaper and safer.",
    "- Parent directories are created as needed.",
  ].join("\n"),
  schema: z.object({
    file_path: z.string().describe("Path to the file"),
    content: z.string().describe("Full file content"),
  }),
  readOnly: false,

  async run(input, ctx) {
    const resolved = await resolveInWorkspace(ctx.workspace, input.file_path);
    if (!resolved.ok) return resolved.error;
    const p = resolved.path;
    const existing = await stat(p).catch(() => null);
    if (existing?.isDirectory()) return { content: `${p} is a directory.`, isError: true };
    if (existing) {
      const err = await ctx.fileState.checkWritable(p);
      if (err) return { content: err, isError: true };
    }

    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, input.content, "utf8");
    const st = await stat(p);
    ctx.fileState.record(p, { mtimeMs: st.mtimeMs, size: st.size, hash: hashContent(input.content) });

    const lines = input.content.split("\n").length;
    return { content: `${existing ? "Overwrote" : "Created"} ${p} (${lines} lines).` };
  },
});
