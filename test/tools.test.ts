import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { PolicyEngine, type PermissionMode, type RuleSet } from "../src/policy/engine.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { readTool } from "../src/tools/read.js";
import { globTool, grepTool } from "../src/tools/search.js";
import { FileStateCache } from "../src/tools/file-state.js";
import { editTool } from "../src/tools/edit.js";
import { writeTool } from "../src/tools/write.js";

let workspace: string;
let outside: string;

/** Lo que decide el motor para una llamada: las herramientas ya no rechazan, declaran qué ruta real tocan. */
function decide(tool: { name: string; permissionTarget: (i: never, c: { workspace: string }) => import("../src/tools/types.js").PermissionTarget }, input: unknown, o: { mode?: PermissionMode; rules?: Partial<RuleSet> } = {}) {
  const engine = new PolicyEngine({ workspace, mode: o.mode ?? "default", rules: { allow: [], ask: [], deny: [], ...o.rules } });
  const target = tool.permissionTarget(input as never, { workspace });
  return { target, decision: engine.evaluate({ type: "tool_use", id: "x", name: tool.name, input }, target) };
}
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

  it("../ sale del workspace: el motor pregunta", () => {
    const { decision } = decide(readTool, { file_path: "../secret/token.txt" });
    expect(decision.kind).toBe("ask");
    expect(decision.reason).toContain("read outside workspace");
  });

  it("una ruta absoluta externa: el motor pregunta", () => {
    expect(decide(readTool, { file_path: path.join(outside, "token.txt") }).decision.kind).toBe("ask");
  });

  it("~ queda fuera del workspace: el motor pregunta", () => {
    expect(decide(readTool, { file_path: "~/.ssh/id_rsa" }).decision.kind).toBe("ask");
  });

  it("un enlace simbólico que sale del workspace se evalúa por su ruta real", () => {
    const file = decide(readTool, { file_path: "token-link.txt" });
    expect(file.target.path).toBe(path.join(outside, "token.txt"));
    expect(file.decision.kind).toBe("ask");
    const viaDir = decide(readTool, { file_path: "link-out/token.txt" });
    expect(viaDir.target.path).toBe(path.join(outside, "token.txt"));
    expect(viaDir.decision.kind).toBe("ask");
  });

  it("un deny sobre la ruta real gana aunque se llegue por un enlace dentro del workspace", () => {
    const rules = { deny: [`Read(${outside}/**)`] };
    expect(decide(readTool, { file_path: "token-link.txt" }, { rules }).decision.kind).toBe("deny");
    expect(decide(readTool, { file_path: "link-out/token.txt" }, { rules, mode: "bypass" }).decision.kind).toBe("deny");
  });

  it("una lectura dentro del workspace se permite", () => {
    expect(decide(readTool, { file_path: "src/a.ts" }).decision.kind).toBe("allow");
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

  it("un path fuera del workspace: el motor pregunta", () => {
    expect(decide(globTool, { pattern: "*", path: outside }).decision.kind).toBe("ask");
  });

  it("fuera del workspace, por ../, ruta absoluta o enlace, el motor pregunta", () => {
    for (const p of ["..", outside, "link-out"]) expect(decide(globTool, { pattern: "*", path: p }).decision.kind, p).toBe("ask");
  });
});

describe("Grep", () => {
  it("encuentra el patrón y devuelve la ruta relativa", async () => {
    const r = await grepTool.run({ pattern: "export const b" }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content.trim()).toBe(path.join("src", "a.ts"));
  });

  it("en modo content devuelve ruta:línea:texto", async () => {
    const r = await grepTool.run({ pattern: "const b", output_mode: "content" }, ctx());
    expect(r.content).toContain("src/a.ts:2:export const b = 2;");
  });

  it("el glob de ficheros limita dónde se busca", async () => {
    const md = await grepTool.run({ pattern: "notas", glob: "*.md" }, ctx());
    expect(md.content.trim()).toBe("notes.md");
    const ts = await grepTool.run({ pattern: "notas", glob: "*.ts" }, ctx());
    expect(ts.content).toContain("No matches found");
  });

  it("sin coincidencias no es un error", async () => {
    const r = await grepTool.run({ pattern: "no-existe-en-ningun-sitio" }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("No matches found");
  });

  it("una ruta fuera del workspace: el motor pregunta", () => {
    expect(decide(grepTool, { pattern: "TOP-SECRET", path: outside }).decision.kind).toBe("ask");
    expect(decide(grepTool, { pattern: "TOP-SECRET", path: "link-out" }).decision.kind).toBe("ask");
  });

  it("una búsqueda sobre el workspace no entra en un enlace que sale de él", async () => {
    const all = await grepTool.run({ pattern: "TOP-SECRET", output_mode: "content" }, ctx());
    expect(all.content).not.toContain("TOP-SECRET");
  });

  it("`searchable` quita de los resultados lo que una regla de lectura deniega", async () => {
    const engine = new PolicyEngine({ workspace, mode: "default", rules: { allow: [], ask: [], deny: ["Read(**/a.ts)"] } });
    const searchable = (p: string) => !engine.hidesFromSearch("Grep", p, workspace);
    const r = await grepTool.run({ pattern: "export const" }, { ...ctx(), searchable });
    expect(r.content).toContain("No matches found");
    expect(r.content).toContain("1 file excluded by permission rules");
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

  it("Edit falla si el contenido cambió con el mismo tamaño y la misma fecha", async () => {
    const f = file("e8.txt", "abc\n");
    const c = ctx();
    await readTool.run({ file_path: f }, c);
    const abs = path.join(workspace, f);
    const snap = c.fileState.get(abs)!;
    writeFileSync(abs, "xyz\n");
    // Un reemplazo que conserva tamaño y fecha: se iguala la metadata del snapshot y solo queda distinto el hash.
    c.fileState.record(abs, { ...snap, mtimeMs: statSync(abs).mtimeMs });
    const r = await editTool.run({ file_path: f, old_string: "xyz", new_string: "q" }, c);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("modified since it was last read");
    const w = await writeTool.run({ file_path: f, content: "pisado\n" }, c);
    expect(w.isError).toBe(true);
    expect(readFileSync(abs, "utf8")).toBe("xyz\n");
  });

  it("un enlace colgante hacia fuera se evalúa por su destino, también en cadena", () => {
    const target = path.join(outside, "no-existe.txt");
    symlinkSync(target, path.join(workspace, "colgante.txt"));
    symlinkSync("colgante.txt", path.join(workspace, "cadena.txt"));
    for (const name of ["colgante.txt", "cadena.txt"]) {
      const w = decide(writeTool, { file_path: name, content: "x" }, { mode: "acceptEdits" });
      expect(w.target.path, name).toBe(target);
      expect(w.decision.kind, name).toBe("ask");
      expect(decide(writeTool, { file_path: name, content: "x" }, { mode: "acceptEdits", rules: { deny: [`Edit(${outside}/**)`] } }).decision.kind, name).toBe("deny");
    }
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

  it("escribir fuera del workspace pregunta, también por un enlace simbólico", () => {
    expect(decide(writeTool, { file_path: "../fuera.txt", content: "x" }).decision.reason).toContain("write outside workspace");
    expect(decide(writeTool, { file_path: "link-out/nuevo.txt", content: "x" }).target.path).toBe(path.join(outside, "nuevo.txt"));
    expect(decide(editTool, { file_path: "token-link.txt", old_string: "a", new_string: "b" }).decision.kind).toBe("ask");
  });

  it("escribir dentro del workspace: pregunta en default y se permite en acceptEdits y bypass", () => {
    const input = { file_path: "src/a.ts", old_string: "a", new_string: "b" };
    expect(decide(editTool, input).decision.kind).toBe("ask");
    expect(decide(editTool, input, { mode: "acceptEdits" }).decision.kind).toBe("allow");
    expect(decide(editTool, input, { mode: "bypass" }).decision.kind).toBe("allow");
  });

  it("bypass: escribir fuera del workspace se permite sin preguntar, salvo que un deny lo cubra", () => {
    const outsideFile = path.join(outside, "nuevo.txt");
    const w = decide(writeTool, { file_path: outsideFile, content: "x" }, { mode: "bypass" });
    expect(w.decision.kind).toBe("allow");
    expect(w.decision.reason).toContain("bypass mode");
    const denied = decide(writeTool, { file_path: outsideFile, content: "x" }, { mode: "bypass", rules: { deny: [`Edit(${outside}/**)`] } });
    expect(denied.decision.kind).toBe("deny");
  });

  it("un deny gana en cualquier modo y Edit(...) cubre también a Write", () => {
    const rules = { deny: ["Edit(**/.env*)"] };
    for (const mode of ["default", "acceptEdits", "bypass"] as const) {
      expect(decide(editTool, { file_path: ".env", old_string: "a", new_string: "b" }, { mode, rules }).decision.kind, mode).toBe("deny");
      expect(decide(writeTool, { file_path: "sub/.env.local", content: "x" }, { mode, rules }).decision.kind, mode).toBe("deny");
    }
  });

  it("deny > ask > allow, y una regla allow no levanta un deny", () => {
    const rules = { allow: ["Edit(src/**)"], ask: ["Edit(src/**)"], deny: ["Edit(src/a.ts)"] };
    expect(decide(editTool, { file_path: "src/a.ts", old_string: "a", new_string: "b" }, { rules }).decision.kind).toBe("deny");
    expect(decide(editTool, { file_path: "src/b.ts", old_string: "a", new_string: "b" }, { rules, mode: "acceptEdits" }).decision.kind).toBe("ask");
  });

  it("una regla de sesión («siempre») evita volver a preguntar", () => {
    const engine = new PolicyEngine({ workspace, mode: "default", rules: { allow: [], ask: [], deny: [] } });
    const target = editTool.permissionTarget({ file_path: "src/a.ts", old_string: "a", new_string: "b" }, { workspace });
    const call = { type: "tool_use" as const, id: "x", name: "Edit", input: {} };
    expect(engine.evaluate(call, target).kind).toBe("ask");
    engine.addSessionRule("allow", "Edit(src/**)");
    expect(engine.evaluate(call, target).kind).toBe("allow");
  });
});
