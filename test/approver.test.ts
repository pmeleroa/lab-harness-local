import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/core/events.js";
import type { ApprovalAnswer, ApprovalRequest, Approver } from "../src/core/loop.js";
import { type HarnessOptions, createHarness } from "../src/index.js";
import { parseAnswer } from "../src/policy/approver.js";
import { loadSettings } from "../src/policy/settings.js";
import type { Block, Message } from "../src/providers/canonical.js";
import { FakeProvider, text, use } from "./fake-provider.js";

function workspace(files: Record<string, string> = {}) {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "lab-appr-")));
  const ws = path.join(base, "ws");
  const outside = path.join(base, "fuera");
  mkdirSync(path.join(ws, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(ws, "src", "a.ts"), "export const a = 1;\n");
  for (const [f, c] of Object.entries(files)) writeFileSync(path.join(ws, f), c);
  return { ws, outside };
}

function run(ws: string, turn1: Block[], o: Partial<HarnessOptions> = {}) {
  const provider = new FakeProvider((_r, turn) => (turn === 1 ? { content: turn1 } : { content: [text("hecho")] }));
  const h = createHarness({ workspace: ws, provider, ...o });
  const events: AgentEvent[] = [];
  h.bus.on((e) => events.push(e));
  return { ...h, events };
}

const answers = (...a: ApprovalAnswer[]) => {
  const asked: ApprovalRequest[] = [];
  const approver: Approver = async (req) => {
    asked.push(req);
    return a.shift() ?? { kind: "deny" };
  };
  return { approver, asked };
};

const toolResults = (ms: Message[]) => JSON.stringify(ms.at(2));

describe("approver", () => {
  it("sin terminal, `ask` se convierte en `deny` y el fichero queda intacto", async () => {
    const { ws } = workspace();
    const { agent, events } = run(ws, [use("r", "Read", { file_path: "src/a.ts" }), use("e", "Edit", { file_path: "src/a.ts", old_string: "1", new_string: "2" })]);
    await agent.run("cambia");
    expect(readFileSync(path.join(ws, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(events.some((e) => e.t === "permission_request")).toBe(true);
    expect(toolResults(agent.messages)).toContain("No interactive user available");
  });

  it("un «sí» ejecuta la herramienta", async () => {
    const { ws } = workspace();
    const { approver, asked } = answers({ kind: "allow_once" });
    const { agent } = run(ws, [use("r", "Read", { file_path: "src/a.ts" }), use("e", "Edit", { file_path: "src/a.ts", old_string: "= 1", new_string: "= 2" })], { approver });
    await agent.run("cambia");
    expect(readFileSync(path.join(ws, "src/a.ts"), "utf8")).toBe("export const a = 2;\n");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.reason).toContain("write");
  });

  it("el motivo escrito llega al modelo en el tool_result y no se ejecuta nada", async () => {
    const { ws } = workspace();
    const { approver } = answers({ kind: "deny", feedback: "usa la constante DESCUENTO, no un literal" });
    const { agent } = run(ws, [use("r", "Read", { file_path: "src/a.ts" }), use("e", "Edit", { file_path: "src/a.ts", old_string: "= 1", new_string: "= 2" })], { approver });
    await agent.run("cambia");
    expect(readFileSync(path.join(ws, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    const results = (agent.messages[2]!.content as Block[]).filter((b) => b.type === "tool_result");
    expect(JSON.stringify(results[1])).toContain("The user denied this action: usa la constante DESCUENTO, no un literal");
    expect(results[1]).toMatchObject({ is_error: true });
  });

  it("«siempre» añade una regla de sesión y la segunda llamada no pregunta", async () => {
    const { ws, outside } = workspace();
    writeFileSync(path.join(outside, "uno.txt"), "uno\n");
    writeFileSync(path.join(outside, "dos.txt"), "dos\n");
    const { approver, asked } = answers({ kind: "allow_always", rule: `Read(${outside}/**)` });
    const { agent } = run(
      ws,
      [use("a", "Read", { file_path: path.join(outside, "uno.txt") }), use("b", "Read", { file_path: path.join(outside, "dos.txt") })],
      { approver },
    );
    await agent.run("lee fuera");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.suggestedRule).toBe(`Read(${path.join(outside, "uno.txt")})`);
    expect(toolResults(agent.messages)).toContain("dos");
  });

  it("un deny no pregunta nunca, ni en bypass", async () => {
    const { ws } = workspace({ ".env": "TOKEN=1\n" });
    const { approver, asked } = answers({ kind: "allow_once" });
    const { agent } = run(ws, [use("r", "Read", { file_path: ".env" })], { approver, permissionMode: "bypass", rules: { deny: ["Read(**/.env*)"] } });
    await agent.run("lee");
    expect(asked).toHaveLength(0);
  });

  it("parseAnswer: y, a, n y texto libre", () => {
    expect(parseAnswer("y", null)).toEqual({ kind: "allow_once" });
    expect(parseAnswer(" Sí ", null)).toEqual({ kind: "allow_once" });
    expect(parseAnswer("a", "Read(x)")).toEqual({ kind: "allow_always", rule: "Read(x)" });
    expect(parseAnswer("a", null)).toEqual({ kind: "deny", feedback: "a" });
    expect(parseAnswer("n", null)).toEqual({ kind: "deny" });
    expect(parseAnswer("", null)).toEqual({ kind: "deny" });
    expect(parseAnswer("mejor en otro fichero", null)).toEqual({ kind: "deny", feedback: "mejor en otro fichero" });
  });
});

describe("settings", () => {
  const withSettings = (json: unknown) => {
    const { ws } = workspace();
    mkdirSync(path.join(ws, ".harness"));
    writeFileSync(path.join(ws, ".harness", "settings.json"), JSON.stringify(json));
    return ws;
  };

  it("sin fichero no hay ninguna regla: tampoco un deny implícito", () => {
    const { ws } = workspace();
    expect(loadSettings(ws).rules).toEqual({ allow: [], ask: [], deny: [] });
  });

  it("lee el bloque permissions", () => {
    const s = loadSettings(withSettings({ permissions: { deny: ["Edit(**/.env*)"], allow: ["Edit(src/**)"], defaultMode: "acceptEdits" } }));
    expect(s.rules.deny).toEqual(["Edit(**/.env*)"]);
    expect(s.rules.allow).toEqual(["Edit(src/**)"]);
    expect(s.mode).toBe("acceptEdits");
  });

  it("un repositorio no puede ponerse en bypass", () => {
    const s = loadSettings(withSettings({ permissions: { defaultMode: "bypass" } }));
    expect(s.mode).toBeUndefined();
    expect(s.warnings[0]).toContain("bypass");
  });

  it("una regla mal escrita o un fichero inválido fallan al arrancar", () => {
    expect(() => loadSettings(withSettings({ permissions: { deny: ["not a rule("] } }))).toThrow(/Invalid permission rule/);
    expect(() => loadSettings(withSettings({ permissions: { defaultMode: "plan" } }))).toThrow(/Invalid settings/);
  });
});
