import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools/registry.js";
import { readTool } from "../src/tools/read.js";
import { globTool } from "../src/tools/search.js";

let workspace: string;
let outside: string;
const ctx = () => ({ workspace, signal: new AbortController().signal });

beforeAll(() => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "lab-tools-")));
  workspace = path.join(base, "ws");
  outside = path.join(base, "secret");
  mkdirSync(path.join(workspace, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(workspace, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  writeFileSync(path.join(workspace, "notes.md"), "# notas\n");
  writeFileSync(path.join(outside, "token.txt"), "TOP-SECRET");
  symlinkSync(outside, path.join(workspace, "link-out"));
  symlinkSync(path.join(outside, "token.txt"), path.join(workspace, "token-link.txt"));
});

describe("Read", () => {
  it("lee un fichero del workspace con números de línea", async () => {
    const r = await readTool.run({ file_path: "src/a.ts" }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("1\texport const a = 1;");
  });

  it("rechaza ../", async () => {
    const r = await readTool.run({ file_path: "../secret/token.txt" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("outside the workspace");
    expect(r.content).not.toContain("TOP-SECRET");
  });

  it("rechaza una ruta absoluta externa", async () => {
    const r = await readTool.run({ file_path: path.join(outside, "token.txt") }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).not.toContain("TOP-SECRET");
  });

  it("rechaza ~ (fuera del workspace)", async () => {
    const r = await readTool.run({ file_path: "~/.ssh/id_rsa" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("outside the workspace");
  });

  it("rechaza un enlace simbólico que sale del workspace", async () => {
    const r = await readTool.run({ file_path: "token-link.txt" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).not.toContain("TOP-SECRET");
    const viaDir = await readTool.run({ file_path: "link-out/token.txt" }, ctx());
    expect(viaDir.isError).toBe(true);
    expect(viaDir.content).not.toContain("TOP-SECRET");
  });

  it("un fichero inexistente dentro del workspace es un error normal", async () => {
    const r = await readTool.run({ file_path: "nada.txt" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("does not exist");
  });
});

describe("Glob", () => {
  it("encuentra ficheros por patrón", async () => {
    const r = await globTool.run({ pattern: "*.ts" }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("src/a.ts");
  });

  it("rechaza un path fuera del workspace", async () => {
    for (const p of ["..", outside, "link-out"]) {
      const r = await globTool.run({ pattern: "*", path: p }, ctx());
      expect(r.isError, p).toBe(true);
      expect(r.content).not.toContain("token.txt");
    }
  });
});

describe("ToolRegistry", () => {
  const registry = new ToolRegistry().register(readTool, globTool);

  it("un input inválido vuelve como error, no como excepción", () => {
    const r = registry.parse("Read", { file_path: 42 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Invalid input for Read");
  });

  it("una herramienta desconocida lista las disponibles", () => {
    const r = registry.parse("Bash", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Available tools: Read, Glob");
  });

  it("genera JSON Schema para el modelo", () => {
    const spec = registry.specs().find((s) => s.name === "Read");
    expect(spec?.inputSchema).toMatchObject({ type: "object", required: ["file_path"] });
  });
});
