import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createHarness } from "../src/index.js";
import { BashParser } from "../src/policy/bash-parser.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { type Skill, loadSkills, loadedSkills, parseSkillFile, renderSkill, renderSkillReference, skillCatalog } from "../src/skills/loader.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createSkillTool } from "../src/tools/skill.js";
import { FakeProvider, text, use } from "./fake-provider.js";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "lab-skills-"));

function writeSkill(root: string, dir: string, frontmatter: string, body = "Haz cosas.") {
  mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(path.join(root, dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
}

describe("parseSkillFile", () => {
  it("lee claves de una línea, comillas y bloques plegados", () => {
    const { meta, body } = parseSkillFile(
      `---\nname: pdf\ndescription: >\n  Rellena formularios\n  y extrae datos.\nallowed-tools: "Read, Bash"\n---\n\n# PDF\nInstrucciones`,
    );
    expect(meta).toEqual({ name: "pdf", description: "Rellena formularios y extrae datos.", "allowed-tools": "Read, Bash" });
    expect(body).toBe("# PDF\nInstrucciones");
  });

  it("sin frontmatter, todo es cuerpo", () => {
    expect(parseSkillFile("solo texto")).toEqual({ meta: {}, body: "solo texto" });
  });
});

describe("loadSkills", () => {
  it("lee <workspace>/.harness/skills, toma el nombre de la carpeta si falta y descarta las inválidas con aviso", () => {
    const ws = tmp();
    const root = path.join(ws, ".harness", "skills");
    writeSkill(root, "notas", "description: sin name, toma el de la carpeta\ndisable-model-invocation: true");
    writeSkill(root, "pdf", "name: pdf\ndescription: PDFs");
    writeSkill(root, "rota", "name: rota");
    writeSkill(root, "mal", "name: Mal Nombre\ndescription: x");
    mkdirSync(path.join(root, "vacia"));

    const { skills, warnings } = loadSkills(ws);
    expect(skills.map((s) => [s.name, s.source, s.description, s.modelInvocable])).toEqual([
      ["notas", "proyecto", "sin name, toma el de la carpeta", false],
      ["pdf", "proyecto", "PDFs", true],
    ]);
    expect(warnings).toEqual([expect.stringMatching(/nombre no válido "Mal Nombre"/), expect.stringMatching(/sin description/)]);
  });

  it("sin carpeta de skills no hay skills ni avisos", () => {
    expect(loadSkills(tmp())).toEqual({ skills: [], warnings: [] });
  });
});

describe("renderSkill y catálogo", () => {
  const ws = tmp();
  const root = path.join(ws, ".harness", "skills");
  writeSkill(root, "pdf", "name: pdf\ndescription: PDFs", "Usa scripts/fill.py con $ARGUMENTS.");
  writeSkill(root, "plain", "name: plain\ndescription: d", "Sin marcador.");
  const [pdf, plain] = loadSkills(ws).skills as [Skill, Skill];

  it("envuelve las instrucciones con su directorio base y sustituye $ARGUMENTS", () => {
    const r = renderSkill(pdf, "form.pdf");
    expect(r).toMatch(/^<skill name="pdf">\nBase directory for this skill: .*pdf\n/);
    expect(r).toContain("Usa scripts/fill.py con form.pdf.");
    expect(r.endsWith("</skill>")).toBe(true);
  });

  it("sin $ARGUMENTS, los argumentos van al final", () => {
    expect(renderSkill(plain, "hola")).toContain("Sin marcador.\n\nARGUMENTS: hola");
    expect(renderSkill(plain)).not.toContain("ARGUMENTS");
  });

  it("el catálogo solo lista las invocables por el modelo y recorta la descripción a 250 caracteres", () => {
    const long = { ...plain, name: "larga", description: "x".repeat(400) };
    const manual = { ...plain, name: "manual", modelInvocable: false };
    const cat = skillCatalog([pdf, long, manual]);
    expect(cat).toContain("<available_skills>\n- pdf: PDFs");
    expect(cat).not.toContain("manual");
    expect(cat.split("\n").find((l) => l.startsWith("- larga"))).toBe(`- larga: ${"x".repeat(249)}…`);
    expect(skillCatalog([manual])).toBe("");
  });
});

describe("loadedSkills", () => {
  it("detecta las skills cargadas por la tool, pero no las referencias ni lo que escribe el modelo", () => {
    const ws = tmp();
    writeSkill(path.join(ws, ".harness", "skills"), "pdf", "name: pdf\ndescription: PDFs");
    const [pdf] = loadSkills(ws).skills as [Skill];
    expect(loadedSkills([])).toEqual(new Set());
    expect(
      loadedSkills([
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: renderSkillReference(pdf, "x") }] },
        { role: "assistant", content: [{ type: "text", text: '<skill name="fake">' }] },
      ]),
    ).toEqual(new Set());
    expect(loadedSkills([{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: '<skill name="b">\n…' }] }])).toEqual(
      new Set(["b"]),
    );
  });
});

describe("tool Skill", () => {
  const ws = tmp();
  writeSkill(path.join(ws, ".harness", "skills"), "pdf", "name: pdf\ndescription: PDFs");
  const { skills } = loadSkills(ws);
  const registry = new ToolRegistry().register(createSkillTool(skills));
  const ctx = { workspace: ws, signal: new AbortController().signal, fileState: undefined as never };

  it("rechaza una skill desconocida antes de pedir permisos", () => {
    const r = registry.parse("Skill", { skill: "excel" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Unknown skill: excel\. Available skills: pdf/);
  });

  it("leer el SKILL.md del proyecto se permite sin preguntar: es una lectura dentro del workspace", async () => {
    const policy = new PolicyEngine({ workspace: ws, mode: "default", rules: { allow: [], ask: [], deny: [] } }, await BashParser.create());
    const call = { type: "tool_use" as const, id: "1", name: "Skill", input: { skill: "pdf" } };
    const target = registry.get("Skill")!.permissionTarget({ skill: "pdf" }, { workspace: ws });
    expect(policy.evaluate(call, target).kind).toBe("allow");
  });

  it("devuelve las instrucciones y, si ya está cargada, una referencia en lugar del cuerpo", async () => {
    const r = registry.parse("Skill", { skill: "pdf" });
    if (!r.ok) throw new Error(r.error);
    expect((await r.tool.run(r.input, ctx)).content).toMatch(/^<skill name="pdf">/);
    const again = await createSkillTool(skills, (n) => n === "pdf").run({ skill: "pdf", args: "b.pdf" }, ctx);
    expect(again.content).toMatch(/already loaded earlier in this conversation.*b\.pdf/);
    expect(again.content).not.toContain("<skill");
  });
});

describe("harness", () => {
  it("con skills de proyecto: catálogo en el system prompt, tool Skill registrada y cuerpo solo al invocarla", async () => {
    const ws = tmp();
    writeSkill(path.join(ws, ".harness", "skills"), "deploy", "name: deploy\ndescription: Despliega el servicio", "Ejecuta make deploy.");
    const provider = new FakeProvider((_req, turn) =>
      turn === 1 ? { content: [use("s1", "Skill", { skill: "deploy" })] } : turn === 2 ? { content: [use("s2", "Skill", { skill: "deploy" })] } : { content: [text("hecho")] },
    );
    const h = await createHarness({ workspace: ws, sandbox: "none", provider });
    try {
      await h.agent.run("despliega");
      const first = provider.requests[0]!;
      expect(first.system.map((p) => p.text).join("\n")).toContain("- deploy: Despliega el servicio");
      expect(first.system.map((p) => p.text).join("\n")).not.toContain("make deploy");
      expect(first.tools.map((t) => t.name)).toContain("Skill");
      const results = h.agent.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result");
      expect(results[0]).toMatchObject({ content: expect.stringContaining("Ejecuta make deploy.") });
      // La segunda vez no se repite el cuerpo.
      expect(results[1]).toMatchObject({ content: expect.stringContaining("already loaded") });
      expect(h.skills.map((s) => s.name)).toEqual(["deploy"]);
    } finally {
      h.dispose();
    }
  });

  it("si la limpieza de contexto quitó el cuerpo de la skill, la siguiente invocación lo vuelve a dar entero", async () => {
    const ws = tmp();
    // Un cuerpo de tamaño real: la limpieza no toca resultados diminutos (MIN_CLEARABLE_TOKENS).
    writeSkill(path.join(ws, ".harness", "skills"), "deploy", "name: deploy\ndescription: Despliega el servicio", `Ejecuta make deploy.\n${"Paso del procedimiento.\n".repeat(100)}`);
    writeFileSync(path.join(ws, "a.txt"), "linea de relleno\n".repeat(2_000));
    const calls = [use("s1", "Skill", { skill: "deploy" }), use("r1", "Read", { file_path: "a.txt" }), use("r2", "Read", { file_path: "a.txt" }), use("s2", "Skill", { skill: "deploy" })];
    const provider = new FakeProvider((_req, turn) => (turn <= calls.length ? { content: [calls[turn - 1]!] } : { content: [text("hecho")] }));
    const h = await createHarness({
      workspace: ws,
      sandbox: "none",
      provider,
      config: { contextWindow: 20_000, maxTokens: 4_000, context: { maxToolResultTokens: 25_000, clearAt: 0.1, compactAt: 0.99, keepToolResults: 1 } },
    });
    try {
      await h.agent.run("despliega");
      // El primer resultado de Skill se limpió en la vista del modelo, aunque siga entero en la historia guardada.
      expect(h.agent.visibleMessages.flatMap((m) => m.content).find((b) => b.type === "tool_result" && b.tool_use_id === "s1")).toMatchObject({
        content: expect.not.stringContaining("make deploy"),
      });
      const again = h.agent.messages.flatMap((m) => m.content).find((b) => b.type === "tool_result" && b.tool_use_id === "s2");
      expect(again).toMatchObject({ content: expect.stringContaining("Ejecuta make deploy.") });
    } finally {
      h.dispose();
    }
  });

  it("sin skills no hay catálogo ni tool Skill", async () => {
    const provider = new FakeProvider(() => ({ content: [text("ok")] }));
    const h = await createHarness({ workspace: tmp(), sandbox: "none", provider });
    try {
      await h.agent.run("hola");
      expect(provider.requests[0]!.tools.map((t) => t.name)).not.toContain("Skill");
      expect(provider.requests[0]!.system.map((p) => p.text).join("\n")).not.toContain("available_skills");
    } finally {
      h.dispose();
    }
  });
});
