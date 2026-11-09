import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools/registry.js";
import { readTool } from "../src/tools/read.js";
import { globTool } from "../src/tools/search.js";
import { FileStateCache } from "../src/tools/file-state.js";
import { editTool } from "../src/tools/edit.js";
import { writeTool } from "../src/tools/write.js";

let workspace: string;
let outside: string;
const ctx = (fileState = new FileStateCache()) => ({ workspace, signal: new AbortController().signal, fileState });

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

describe("Edit y Write: read-before-edit", () => {
  const file = (name: string, content: string) => {
    writeFileSync(path.join(workspace, name), content);
    return name;
  };

  it("Edit sin haber leído el fichero falla y no lo toca", async () => {
    const f = file("e1.txt", "uno\ndos\n");
    const r = await editTool.run({ file_path: f, old_string: "uno", new_string: "UNO" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("has not been read yet");
    expect(readFileSync(path.join(workspace, f), "utf8")).toBe("uno\ndos\n");
  });

  it("Edit tras leer cambia el fichero", async () => {
    const f = file("e2.txt", "uno\ndos\n");
    const c = ctx();
    await readTool.run({ file_path: f }, c);
    const r = await editTool.run({ file_path: f, old_string: "dos", new_string: "DOS" }, c);
    expect(r.isError).toBeUndefined();
    expect(readFileSync(path.join(workspace, f), "utf8")).toBe("uno\nDOS\n");
  });

  it("Edit falla si el fichero cambió de tamaño tras la lectura", async () => {
    const f = file("e3.txt", "uno\n");
    const c = ctx();
    await readTool.run({ file_path: f }, c);
    writeFileSync(path.join(workspace, f), "uno\ncambio externo\n");
    const r = await editTool.run({ file_path: f, old_string: "uno", new_string: "UNO" }, c);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("modified since it was last read");
  });

  it("Edit falla si cambió el mtime con el mismo tamaño", async () => {
    const f = file("e4.txt", "abc\n");
    const c = ctx();
    await readTool.run({ file_path: f }, c);
    const t = new Date(Date.now() + 60_000);
    utimesSync(path.join(workspace, f), t, t);
    const r = await editTool.run({ file_path: f, old_string: "abc", new_string: "xyz" }, c);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("modified since it was last read");
  });

  it("old_string ausente, repetido y con prefijos de línea", async () => {
    const f = file("e5.txt", "x = 1\nx = 1\ny = 2\n");
    const c = ctx();
    await readTool.run({ file_path: f }, c);
    const absent = await editTool.run({ file_path: f, old_string: "zzz", new_string: "q" }, c);
    expect(absent.isError).toBe(true);
    expect(absent.content).toContain("not found");
    const dup = await editTool.run({ file_path: f, old_string: "x = 1", new_string: "x = 9" }, c);
    expect(dup.isError).toBe(true);
    expect(dup.content).toContain("matches 2 times");
    const prefixed = await editTool.run({ file_path: f, old_string: "3\ty = 2", new_string: "y = 3" }, c);
    expect(prefixed.isError).toBe(true);
    expect(prefixed.content).toContain("line-number prefixes");
    expect(readFileSync(path.join(workspace, f), "utf8")).toBe("x = 1\nx = 1\ny = 2\n");
  });

  it("replace_all cambia todas las apariciones", async () => {
    const f = file("e6.txt", "x = 1\nx = 1\ny = 2\n");
    const c = ctx();
    await readTool.run({ file_path: f }, c);
    const r = await editTool.run({ file_path: f, old_string: "x = 1", new_string: "x = 9", replace_all: true }, c);
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("2 replacements");
    expect(readFileSync(path.join(workspace, f), "utf8")).toBe("x = 9\nx = 9\ny = 2\n");
  });

  it("Edit permite encadenar ediciones: la propia escritura actualiza el estado", async () => {
    const f = file("e7.txt", "a\nb\n");
    const c = ctx();
    await readTool.run({ file_path: f }, c);
    expect((await editTool.run({ file_path: f, old_string: "a", new_string: "A" }, c)).isError).toBeUndefined();
    expect((await editTool.run({ file_path: f, old_string: "b", new_string: "B" }, c)).isError).toBeUndefined();
  });

  it("Write crea un fichero nuevo con sus directorios sin exigir lectura", async () => {
    const r = await writeTool.run({ file_path: "nuevo/dir/f.txt", content: "hola\n" }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("Created");
    expect(readFileSync(path.join(workspace, "nuevo/dir/f.txt"), "utf8")).toBe("hola\n");
  });

  it("Write exige haber leído un fichero existente para sobrescribirlo", async () => {
    const f = file("w1.txt", "original\n");
    const blind = await writeTool.run({ file_path: f, content: "pisado\n" }, ctx());
    expect(blind.isError).toBe(true);
    expect(readFileSync(path.join(workspace, f), "utf8")).toBe("original\n");
    const c = ctx();
    await readTool.run({ file_path: f }, c);
    const ok = await writeTool.run({ file_path: f, content: "pisado\n" }, c);
    expect(ok.isError).toBeUndefined();
    expect(ok.content).toContain("Overwrote");
  });

  it("sin motor de permisos, Write y Edit no salen del workspace", async () => {
    const w = await writeTool.run({ file_path: "../fuera.txt", content: "x" }, ctx());
    expect(w.isError).toBe(true);
    expect(existsSync(path.join(path.dirname(workspace), "fuera.txt"))).toBe(false);
  });
});
