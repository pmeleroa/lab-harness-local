import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalAnswer, Approver } from "../src/core/loop.js";
import { type Harness, type HarnessOptions, createHarness } from "../src/index.js";
import type { Block, ToolUseBlock } from "../src/providers/canonical.js";
import { JsonlSessionStore, type SessionRecord } from "../src/session/jsonl-store.js";
import { FakeProvider, type Script, text, use } from "./fake-provider.js";

let harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses) h.dispose();
  harnesses = [];
});

type Approval = Extract<SessionRecord, { type: "approval" }>;
const tmp = (prefix: string) => realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
const fileOf = (h: Harness) => (h.session as JsonlSessionStore).file;
const approvalsIn = (file: string) => JsonlSessionStore.readRecords(file).filter((r): r is Approval => r.type === "approval");

function workspace() {
  const ws = tmp("lab-approval-ws-");
  writeFileSync(path.join(ws, "a.txt"), "uno\n");
  const outside = tmp("lab-approval-fuera-");
  writeFileSync(path.join(outside, "secreto.txt"), "fuera\n");
  return { ws, outside };
}

/** Un run con estas llamadas en el primer turno (o con un guion), y sus registros `approval`. */
async function approvals(calls: Block[] | Script, o: Partial<HarnessOptions> = {}) {
  const script: Script = typeof calls === "function" ? calls : (_r, turn) => (turn === 1 ? { content: calls } : { content: [text("listo")] });
  const provider = new FakeProvider(script);
  const h = await createHarness({ workspace: o.workspace ?? workspace().ws, sandbox: "none", mcp: false, ...o, provider });
  harnesses.push(h);
  await h.agent.run("haz");
  return { list: approvalsIn(fileOf(h)), h, provider };
}

const answers = (...as: ApprovalAnswer[]): Approver => {
  let i = 0;
  return async () => as[Math.min(i++, as.length - 1)]!;
};

describe("approval: quién decidió cada llamada", () => {
  it("una regla de settings, una de --allow/--deny y una de sesión (un «siempre»)", async () => {
    const settings = await approvals([use("t1", "Bash", { command: "touch x" })], { rules: { allow: ["Bash(touch *)"] } });
    expect(settings.list).toEqual([
      expect.objectContaining({ toolUseId: "t1", tool: "Bash", decision: "allow", origin: "rule", rule: "Bash(touch *)", ruleSource: "settings", reason: "all subcommands allowed" }),
    ]);
    const flag = await approvals([use("t1", "Bash", { command: "touch x" })], { flagRules: { deny: ["Bash(touch *)"] } });
    expect(flag.list).toEqual([
      expect.objectContaining({ decision: "deny", origin: "rule", rule: "Bash(touch *)", ruleSource: "flag", reason: "denied by rule Bash(touch *): touch x" }),
    ]);
    const session = await approvals(
      (_r, turn) =>
        turn === 1
          ? { content: [use("t1", "Bash", { command: "touch x" })] }
          : turn === 2
            ? { content: [use("t2", "Bash", { command: "touch y" })] }
            : { content: [text("listo")] },
      { approver: answers({ kind: "allow_always", rule: "Bash(touch *)" }) },
    );
    expect(session.list).toEqual([
      expect.objectContaining({ toolUseId: "t1", decision: "allow", origin: "user", answer: "always", rule: "Bash(touch *)", reason: "run: touch x" }),
      expect.objectContaining({ toolUseId: "t2", decision: "allow", origin: "rule", rule: "Bash(touch *)", ruleSource: "session" }),
    ]);
  });

  it("el modo: bypass, acceptEdits y plan", async () => {
    const write = use("w1", "Write", { file_path: "b.txt", content: "x" });
    const bypass = await approvals([write, use("t1", "Bash", { command: "touch x" })], { permissionMode: "bypass" });
    expect(bypass.list).toEqual([
      expect.objectContaining({ tool: "Write", decision: "allow", origin: "mode", reason: "bypass: write inside workspace" }),
      expect.objectContaining({ tool: "Bash", decision: "allow", origin: "mode", reason: "bypass mode (run: touch x)" }),
    ]);
    const accept = await approvals([write], { permissionMode: "acceptEdits" });
    expect(accept.list).toEqual([expect.objectContaining({ decision: "allow", origin: "mode", reason: "acceptEdits: write inside workspace" })]);
    const plan = await approvals([write], { permissionMode: "plan" });
    expect(plan.list).toEqual([expect.objectContaining({ decision: "deny", origin: "mode", reason: expect.stringMatching(/^plan mode: write /) })]);
  });

  it("la política: leer dentro del workspace pasa sola; fuera, el perímetro pregunta y decide el usuario", async () => {
    const { ws, outside } = workspace();
    const { list } = await approvals([use("r1", "Read", { file_path: "a.txt" }), use("r2", "Read", { file_path: path.join(outside, "secreto.txt") })], {
      workspace: ws,
      approver: answers({ kind: "allow_once" }),
    });
    expect(list).toEqual([
      expect.objectContaining({ toolUseId: "r1", decision: "allow", origin: "policy", reason: "read inside workspace" }),
      expect.objectContaining({ toolUseId: "r2", decision: "allow", origin: "user", answer: "once", reason: `read outside workspace: ${path.join(outside, "secreto.txt")}` }),
    ]);
    // Sin regla ni ruleSource: no decidió una regla.
    expect(list[0]).not.toHaveProperty("rule");
  });

  it("el usuario: «una vez», «siempre» y «no» con motivo", async () => {
    const { list } = await approvals(
      [use("w1", "Write", { file_path: "b.txt", content: "x" }), use("t1", "Bash", { command: "touch x" }), use("w2", "Write", { file_path: "c.txt", content: "x" })],
      {
        approver: answers(
          { kind: "allow_once" },
          { kind: "allow_always", rule: "Bash(touch *)" },
          { kind: "deny", feedback: "c.txt no, usa b.txt" },
        ),
      },
    );
    expect(list).toEqual([
      expect.objectContaining({ toolUseId: "w1", decision: "allow", origin: "user", answer: "once" }),
      expect.objectContaining({ toolUseId: "t1", decision: "allow", origin: "user", answer: "always", rule: "Bash(touch *)" }),
      expect.objectContaining({ toolUseId: "w2", decision: "deny", origin: "user", answer: "no", feedback: "c.txt no, usa b.txt" }),
    ]);
  });

  it("un hook PreToolUse que bloquea: decide el hook, con su mensaje", async () => {
    const { list } = await approvals([use("w1", "Write", { file_path: "b.txt", content: "x" })], {
      permissionMode: "bypass",
      hooks: { PreToolUse: [{ matcher: "Write", command: "echo 'aquí no se escribe' >&2; exit 2" }] },
    });
    expect(list).toEqual([expect.objectContaining({ decision: "deny", origin: "hook", reason: expect.stringContaining("aquí no se escribe") })]);
  });

  it("el paralelo: la segunda lectura, cubierta por el «siempre» de la primera, la decide la regla de sesión", async () => {
    const { ws, outside } = workspace();
    writeFileSync(path.join(outside, "dos.txt"), "dos\n");
    let asked = 0;
    const { list } = await approvals(
      [use("a", "Read", { file_path: path.join(outside, "secreto.txt") }), use("b", "Read", { file_path: path.join(outside, "dos.txt") })],
      { workspace: ws, approver: async () => (asked++, { kind: "allow_always", rule: `Read(${outside}/**)` }) },
    );
    expect(asked).toBe(1);
    const byId = Object.fromEntries(list.map((a) => [a.toolUseId, a]));
    expect(byId.a).toMatchObject({ decision: "allow", origin: "user", answer: "always", rule: `Read(${outside}/**)` });
    expect(byId.b).toMatchObject({ decision: "allow", origin: "rule", rule: `Read(${outside}/**)`, ruleSource: "session" });
    expect(byId.b).not.toHaveProperty("answer");
  });

  it("todo tool_use que pasó por el motor tiene exactamente un approval, entre él y su tool_result; los que no, ninguno", async () => {
    const { ws, outside } = workspace();
    const { h } = await approvals(
      (_r, turn) =>
        turn === 1
          ? {
              content: [
                use("r1", "Read", { file_path: "a.txt" }),
                use("bad", "Read", {}), // input inválido: no llega al motor
                use("nope", "Inventada", {}), // tool desconocida
                use("r2", "Read", { file_path: path.join(outside, "secreto.txt") }),
              ],
            }
          : turn === 2
            ? { content: [use("w1", "Write", { file_path: "b.txt", content: "x" }), use("t1", "Bash", { command: "ls" })] }
            : { content: [text("listo")] },
      { workspace: ws },
    );
    const rs = JsonlSessionStore.readRecords(fileOf(h));
    const uses = rs.flatMap((r) => (r.type === "message" ? r.message.content.filter((b): b is ToolUseBlock => b.type === "tool_use") : []));
    const count = (id: string) => rs.filter((r) => r.type === "approval" && r.toolUseId === id).length;
    expect(uses.map((u) => [u.id, count(u.id)])).toEqual([
      ["r1", 1],
      ["bad", 0],
      ["nope", 0],
      ["r2", 1],
      ["w1", 1],
      ["t1", 1],
    ]);
    // Orden: el tool_use, sus approval y después el mensaje con los tool_result.
    for (const id of ["r1", "r2", "w1", "t1"]) {
      const at = (pred: (r: SessionRecord) => boolean) => rs.findIndex(pred);
      const call = at((r) => r.type === "message" && r.message.content.some((b) => b.type === "tool_use" && b.id === id));
      const approval = at((r) => r.type === "approval" && r.toolUseId === id);
      const result = at((r) => r.type === "message" && r.message.content.some((b) => b.type === "tool_result" && b.tool_use_id === id));
      expect(call).toBeLessThan(approval);
      expect(approval).toBeLessThan(result);
    }
  });
});
