import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { summaryMessage } from "../src/context/manager.js";
import type { AgentEvent } from "../src/core/events.js";
import type { Approver } from "../src/core/loop.js";
import { type Harness, type HarnessOptions, createHarness } from "../src/index.js";
import { BashParser } from "../src/policy/bash-parser.js";
import { PolicyEngine, SESSIONS_DENY_REASON, SESSIONS_RULE, emptyRules } from "../src/policy/engine.js";
import { bwrapSandbox, defaultHiddenPaths } from "../src/policy/sandbox/index.js";
import type { CanonicalRequest, Message, ToolUseBlock } from "../src/providers/canonical.js";
import {
  JsonlSessionStore,
  RESUME_INTERRUPTED,
  type SessionRecord,
  missingResults,
  repairTranscript,
  sessionsDirOf,
  sessionsRoot,
  workspaceKey,
} from "../src/session/jsonl-store.js";
import { FakeProvider, type Script, text, use } from "./fake-provider.js";

let harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses) h.dispose();
  harnesses = [];
});

const tmp = (prefix: string) => realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
const records = (file: string) => JsonlSessionStore.readRecords(file);
const lineCount = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean).length;
const fileOf = (h: Harness) => (h.session as JsonlSessionStore).file;
const answer = (t: string): Script => () => ({ content: [text(t)] });
const once = (...calls: ReturnType<typeof use>[]): Script => (_r, turn) => (turn === 1 ? { content: calls } : { content: [text("listo")] });

async function start(script: Script, o: Partial<HarnessOptions> = {}) {
  const provider = new FakeProvider(script);
  const h = await createHarness({ workspace: o.workspace ?? tmp("lab-sessions-ws-"), sandbox: "none", mcp: false, ...o, provider });
  harnesses.push(h);
  const events: AgentEvent[] = [];
  h.bus.on((e) => events.push(e));
  return { h, provider, events };
}

/** Una sesión con un prompt ya respondido. */
async function session(workspace: string, prompt: string, o: Partial<HarnessOptions> = {}) {
  const { h } = await start(answer(`respuesta a ${prompt}`), { workspace, ...o });
  await h.agent.run(prompt);
  return h;
}

describe("el transcript", () => {
  it("vive en ~/.harness/sessions/<clave>/, que es el HOME de los tests y no el real", () => {
    const ws = tmp("lab-sessions-ws-");
    expect(sessionsDirOf(ws)).toBe(path.join(os.homedir(), ".harness", "sessions", workspaceKey(ws)));
    expect(os.homedir()).toContain(".lab-harness-test-homes-");
  });

  it("no hay fichero hasta el primer mensaje: el meta espera, pero la raíz existe desde el arranque", async () => {
    const { h } = await start(answer("hola"));
    expect(existsSync(sessionsRoot())).toBe(true);
    expect(existsSync(fileOf(h))).toBe(false);
    await h.agent.run("hola");
    expect(records(fileOf(h)).map((r) => r.type)).toEqual(["meta", "message", "usage", "message"]);
    expect(records(fileOf(h))[0]).toMatchObject({ type: "meta", sessionId: h.session.id, workspace: h.workspace, model: h.model, contextWindow: 100_000 });
  });

  it("una línea truncada por un corte se salta", () => {
    const dir = tmp("lab-store-");
    const s = new JsonlSessionStore(dir);
    s.append({ type: "message", ts: "t", message: { role: "user", content: [text("uno")] } });
    s.append({ type: "message", ts: "t", message: { role: "assistant", content: [text("dos")] } });
    appendFileSync(s.file, '{"type":"message","ts":"t","message":{"role":"us');
    expect(records(s.file)).toHaveLength(2);
    expect(JsonlSessionStore.readMessages(s.file).map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("readMessages empieza en el último compact y solo lee los message: approval, task, subagent y usage no se restauran", () => {
    const s = new JsonlSessionStore(tmp("lab-store-"));
    const kept: Message = { role: "user", content: [text("sigue con los tests")] };
    const rs: SessionRecord[] = [
      { type: "meta", ts: "t", sessionId: s.id, workspace: "/w", model: "m" },
      { type: "message", ts: "t", message: { role: "user", content: [text("antes")] } },
      { type: "message", ts: "t", message: { role: "assistant", content: [use("c1", "Read", { file_path: "a.ts" })] } },
      { type: "approval", ts: "t", toolUseId: "c1", tool: "Read", decision: "allow", origin: "policy", reason: "read inside workspace" },
      { type: "message", ts: "t", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "x" }] } },
      { type: "compact", ts: "t", summary: "RESUMEN", kept },
      { type: "message", ts: "t", message: { role: "assistant", content: [use("c2", "Bash", { command: "npm test" })] } },
      { type: "approval", ts: "t", toolUseId: "c2", tool: "Bash", decision: "allow", origin: "user", reason: "run: npm test", answer: "once" },
      { type: "task", ts: "t", id: "abc", kind: "shell", description: "tests", status: "running" },
      { type: "usage", ts: "t", turn: 1, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      { type: "message", ts: "t", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c2", content: "ok" }] } },
    ];
    for (const r of rs) s.append(r);
    const expected = summaryMessage("RESUMEN");
    expected.content.push(...kept.content);
    expect(JsonlSessionStore.readMessages(s.file)).toEqual([
      expected,
      { role: "assistant", content: [use("c2", "Bash", { command: "npm test" })] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c2", content: "ok" }] },
    ]);
    // La historia anterior al compact sigue en el fichero.
    expect(records(s.file).filter((r) => r.type === "message")).toHaveLength(5);
  });

  it("repairTranscript: solo reciben un tool_result sintético los tool_use del último turno que no lo tienen", () => {
    const cut: Message[] = [
      { role: "user", content: [text("edita")] },
      { role: "assistant", content: [text("voy"), use("e1", "Edit", {}), use("b1", "Bash", {})] },
    ];
    const synthetic = (id: string) => ({ type: "tool_result", tool_use_id: id, content: RESUME_INTERRUPTED, is_error: true });
    // Cortado antes de que acabara ninguna: todas.
    expect(repairTranscript(cut).at(-1)).toEqual({ role: "user", content: [synthetic("e1"), synthetic("b1")] });
    // Cortado a mitad: el Edit acabó y su resultado está; solo falta el del Bash, detrás.
    const half: Message[] = [...cut, { role: "user", content: [{ type: "tool_result", tool_use_id: "e1", content: "ok" }] }];
    expect(missingResults(half)).toEqual([synthetic("b1")]);
    expect(repairTranscript(half).at(-1)).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "e1", content: "ok" }, synthetic("b1")] });
    // Completo: nada que reparar.
    const whole: Message[] = [
      ...cut,
      { role: "user", content: [{ type: "tool_result", tool_use_id: "e1", content: "ok" }, { type: "tool_result", tool_use_id: "b1", content: "ok" }] },
    ];
    expect(repairTranscript(whole)).toEqual(whole);
    expect(repairTranscript([...whole, { role: "assistant", content: [text("hecho")] }])).toHaveLength(4);
  });

  it("la clave: estable con la misma ruta, distinta con dos rutas del mismo nombre e igual a través de un enlace", () => {
    const base = tmp("lab-key-");
    const a = path.join(base, "uno", "tienda");
    const b = path.join(base, "dos", "tienda");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    symlinkSync(a, path.join(base, "enlace"));
    expect(workspaceKey(a)).toMatch(/^tienda-[0-9a-f]{8}$/);
    expect(workspaceKey(a)).toBe(workspaceKey(`${a}/`));
    expect(workspaceKey(a)).toBe(workspaceKey(path.join(base, "uno", ".", "tienda")));
    expect(workspaceKey(b)).not.toBe(workspaceKey(a));
    expect(workspaceKey(path.join(base, "enlace"))).toBe(workspaceKey(a));
  });
});

describe("retomar: --continue, --resume y --fork-session", () => {
  it("--continue retoma la más reciente del workspace; sin ninguna, avisa y empieza otra", async () => {
    const ws = tmp("lab-sessions-ws-");
    const first = await start(answer("nueva"), { workspace: ws, continueLatest: true });
    expect(first.h.warnings).toContain("No previous session in this workspace: starting a new one.");
    expect(first.h.resumed).toBeNull();
    await first.h.agent.run("la vieja");
    const old = fileOf(first.h);
    utimesSync(old, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const recent = await session(ws, "la reciente");
    // Otra sesión de otro workspace no cuenta.
    await session(tmp("lab-sessions-otro-"), "de otro workspace");

    const { h, provider } = await start(answer("sigo"), { workspace: ws, continueLatest: true });
    expect(h.resumed?.id).toBe(recent.session.id);
    expect(h.session.id).toBe(recent.session.id);
    await h.agent.run("sigue");
    expect(JSON.stringify(provider.requests[0]!.messages)).toContain("la reciente");
    expect(JSON.stringify(provider.requests[0]!.messages)).not.toContain("la vieja");
  });

  it("cada arranque deja su meta, con el modelo y la ventana de ese momento", async () => {
    const ws = tmp("lab-sessions-ws-");
    const a = await session(ws, "uno", { model: "modelo-a", config: { contextWindow: 8192 } });
    const { h } = await start(answer("dos"), { workspace: ws, continueLatest: true, model: "modelo-b", config: { contextWindow: 4096 } });
    // El meta del arranque se escribe ya: el fichero existe.
    const metas = records(fileOf(a)).filter((r) => r.type === "meta");
    expect(metas).toMatchObject([
      { model: "modelo-a", contextWindow: 8192 },
      { model: "modelo-b", contextWindow: 4096 },
    ]);
    expect(h.agent.contextWindow).toBe(4096);
  });

  it("--resume por prefijo; uno ambiguo o que no existe es un error", async () => {
    const ws = tmp("lab-sessions-ws-");
    const dir = sessionsDirOf(ws);
    for (const id of ["aaaa1111-0000-4000-8000-000000000000", "aaaa2222-0000-4000-8000-000000000000", "bbbb3333-0000-4000-8000-000000000000"]) {
      const s = new JsonlSessionStore(dir, id);
      s.append({ type: "message", ts: "t", message: { role: "user", content: [text(`soy ${id.slice(0, 8)}`)] } });
    }
    const { h } = await start(answer("x"), { workspace: ws, resume: "bbbb" });
    expect(h.resumed?.id).toBe("bbbb3333-0000-4000-8000-000000000000");
    expect(JSON.stringify(h.agent.messages)).toContain("soy bbbb3333");
    await expect(start(answer("x"), { workspace: ws, resume: "aaaa" })).rejects.toThrow(/^"aaaa" es ambiguo: aaaa(1111|2222), aaaa(1111|2222)\.$/);
    await expect(start(answer("x"), { workspace: ws, resume: "cccc" })).rejects.toThrow(/No hay ninguna sesión "cccc"/);
  });

  it("--fork-session: la original no cambia y la copia lleva forkedFrom", async () => {
    const ws = tmp("lab-sessions-ws-");
    const orig = await session(ws, "la tarea");
    const file = fileOf(orig);
    const before = readFileSync(file, "utf8");
    const { h } = await start(answer("otra vía"), { workspace: ws, continueLatest: true, forkSession: true });
    expect(h.session.id).not.toBe(orig.session.id);
    expect(h.resumed?.forkedFrom).toBe(orig.session.id);
    await h.agent.run("prueba otra alternativa");
    expect(readFileSync(file, "utf8")).toBe(before);
    const copy = records(fileOf(h));
    expect(copy[0]).toMatchObject({ type: "meta", sessionId: h.session.id, forkedFrom: { sessionId: orig.session.id, records: lineCount(file) - 1 } });
    // Un solo meta: el del fork.
    expect(copy.filter((r) => r.type === "meta")).toHaveLength(1);
    expect(JSON.stringify(copy)).toContain("la tarea");
    expect(JSON.stringify(copy)).toContain("prueba otra alternativa");
  });

  it("--fork-session sin --continue ni --resume se ignora con aviso", async () => {
    const { h } = await start(answer("x"), { forkSession: true });
    expect(h.warnings).toContain("--fork-session needs --continue or --resume: ignored.");
    expect(h.resumed).toBeNull();
  });

  it("un corte en una pregunta de permiso deja el tool_use sin tool_result ni approval; al retomar se repara", async () => {
    const ws = tmp("lab-sessions-ws-");
    writeFileSync(path.join(ws, "a.txt"), "uno\n");
    // Un approver que nunca responde: como el Ctrl+C con terminal, que sale del proceso con la pregunta abierta.
    const asked: string[] = [];
    const never: Approver = (req) => (asked.push(req.call.id), new Promise(() => {}));
    const cut = await start(once(use("w1", "Write", { file_path: "b.txt", content: "x" })), { workspace: ws, approver: never });
    void cut.h.agent.run("escribe b.txt");
    await vi_waitFor(() => asked.length === 1);
    const file = fileOf(cut.h);
    const rs = records(file);
    expect(rs.at(-1)).toMatchObject({ type: "message", message: { role: "assistant", content: [{ type: "tool_use", id: "w1" }] } });
    expect(rs.filter((r) => r.type === "approval")).toEqual([]);

    const { h, provider } = await start(answer("retomo"), { workspace: ws, continueLatest: true });
    expect(h.agent.messages.at(-1)).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "w1", content: RESUME_INTERRUPTED, is_error: true }] });
    await h.agent.run("sigue");
    const sent = provider.requests[0]!.messages;
    expect(sent.at(-1)!.content).toEqual([
      { type: "tool_result", tool_use_id: "w1", content: RESUME_INTERRUPTED, is_error: true },
      { type: "text", text: "sigue" },
    ]);
    // La reparación queda escrita: una segunda retomada, o un fork, ya no ve el tool_use suelto.
    expect(records(file).find((r) => r.type === "message" && r.message.content.some((b) => b.type === "tool_result"))).toMatchObject({
      message: { role: "user", content: [{ tool_use_id: "w1", content: RESUME_INTERRUPTED }] },
    });
    const fork = await start(answer("otra"), { workspace: ws, continueLatest: true, forkSession: true });
    await fork.h.agent.run("alternativa");
    const again = fork.provider.requests[0]!.messages;
    expect(again.map((m) => [m.role, m.content.map((b) => b.type)])).toEqual([
      ["user", ["text"]],
      ["assistant", ["tool_use"]],
      ["user", ["tool_result", "text"]],
      ["assistant", ["text"]],
      ["user", ["text"]],
    ]);
  });

  it("un corte a mitad de turno guarda los resultados de lo que ya corrió; al retomar solo se repara lo que faltaba", async () => {
    const ws = tmp("lab-sessions-ws-");
    writeFileSync(path.join(ws, "a.txt"), "uno\n");
    let n = 0;
    // El Edit se aprueba y corre, el Write se rechaza con motivo y el Bash se queda en la pregunta.
    const approver: Approver = () =>
      ++n === 1 ? Promise.resolve({ kind: "allow_once" }) : n === 2 ? Promise.resolve({ kind: "deny", feedback: "ahí no" }) : new Promise(() => {});
    const cut = await start(
      (_r, turn) =>
        turn === 1
          ? { content: [use("r1", "Read", { file_path: "a.txt" })] }
          : {
              content: [
                use("e1", "Edit", { file_path: "a.txt", old_string: "uno", new_string: "dos" }),
                use("w1", "Write", { file_path: "b.txt", content: "x" }),
                use("b1", "Bash", { command: "touch c.txt" }),
              ],
            },
      { workspace: ws, approver },
    );
    void cut.h.agent.run("cambia a.txt, crea b.txt y toca c.txt");
    await vi_waitFor(() => n === 3);
    const file = fileOf(cut.h);
    expect(readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("dos\n");
    const results = records(file).flatMap((r) => (r.type === "message" ? r.message.content.filter((b) => b.type === "tool_result") : []));
    expect(results.map((b) => (b as { tool_use_id: string }).tool_use_id)).toEqual(["r1", "e1", "w1"]);
    expect(approvalsIds(file)).toEqual(["r1", "e1", "w1"]);

    const { h, provider } = await start(answer("retomo"), { workspace: ws, continueLatest: true });
    await h.agent.run("sigue");
    const last = provider.requests[0]!.messages.at(-1)!.content;
    expect(last.map((b) => (b.type === "tool_result" ? `${b.tool_use_id}:${b.content === RESUME_INTERRUPTED ? "sintético" : "real"}` : b.type))).toEqual([
      "e1:real",
      "w1:real",
      "b1:sintético",
      "text",
    ]);
    // Escrito en el transcript: solo el que faltaba.
    const synthetic = records(file).filter((r) => r.type === "message" && r.message.content.some((b) => b.type === "tool_result" && b.content === RESUME_INTERRUPTED));
    expect(synthetic).toHaveLength(1);
  });

  it("lo que no se restaura: el modo, los «siempre» y lo leído; el modelo y la ventana salen de esta invocación", async () => {
    const ws = tmp("lab-sessions-ws-");
    writeFileSync(path.join(ws, "a.txt"), "uno\n");
    const always: Approver = async (req) => ({ kind: "allow_always", rule: req.suggestedRule! });
    const first = await start(
      once(use("r1", "Read", { file_path: "a.txt" }), use("t1", "Bash", { command: "touch hecho" }), use("e1", "Edit", { file_path: "a.txt", old_string: "uno", new_string: "dos" })),
      { workspace: ws, approver: always, permissionMode: "acceptEdits" },
    );
    await first.h.agent.run("lee, toca y edita");
    expect(readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("dos\n");

    // Segunda invocación, sin terminal: lo que pregunte se deniega.
    const { h } = await start(
      once(use("t2", "Bash", { command: "touch otra" }), use("e2", "Edit", { file_path: "a.txt", old_string: "dos", new_string: "tres" })),
      { workspace: ws, continueLatest: true },
    );
    expect(h.policy.mode).toBe("default");
    await h.agent.run("sigue");
    const rs = records(fileOf(h));
    const byId = (id: string) => rs.find((r) => r.type === "approval" && r.toolUseId === id);
    expect(byId("t1")).toMatchObject({ origin: "user", answer: "always", rule: "Bash(touch *)" });
    // El «siempre» era de la sesión de la primera invocación: vuelve a preguntar.
    expect(byId("t2")).toMatchObject({ decision: "deny", origin: "user", answer: "no", reason: "run: touch otra" });
    // El modo era acceptEdits: ahora escribir pregunta. Y aunque se permitiera, lo leído no se restaura.
    expect(byId("e2")).toMatchObject({ decision: "deny", origin: "user", answer: "no" });
    const third = await start(once(use("e3", "Edit", { file_path: "a.txt", old_string: "dos", new_string: "tres" })), {
      workspace: ws,
      continueLatest: true,
      permissionMode: "acceptEdits",
    });
    await third.h.agent.run("edita otra vez");
    expect(JSON.stringify(third.provider.requests[1]!.messages.at(-1))).toContain("File has not been read yet");
    expect(records(fileOf(h)).filter((r) => r.type === "meta")).toHaveLength(3);
  });
});

describe("subagentes y tareas en el transcript", () => {
  const isChild = (req: CanonicalRequest) => req.system.some((s) => s.text.includes("# Subagent"));

  it("un explore deja su transcript en agents/, enlazado desde el registro subagent del principal, con sus approval", async () => {
    const ws = tmp("lab-sessions-ws-");
    writeFileSync(path.join(ws, "a.ts"), "export const a = 1;\n");
    let parent = 0;
    let child = 0;
    const script: Script = (req) => {
      if (isChild(req)) return ++child === 1 ? { content: [use("cr", "Read", { file_path: "a.ts" })] } : { content: [text("a vale 1")] };
      return ++parent === 1
        ? { content: [use("ag", "Agent", { description: "buscar a", prompt: "Lee a.ts y di cuánto vale a", subagent_type: "explore" })] }
        : { content: [text("vale 1")] };
    };
    const { h } = await start(script, { workspace: ws });
    await h.agent.run("¿cuánto vale a?");
    const main = records(fileOf(h));
    const sub = main.find((r): r is Extract<SessionRecord, { type: "subagent" }> => r.type === "subagent")!;
    expect(sub).toMatchObject({ agentType: "explore", description: "buscar a", reason: "end_turn", turns: 2 });
    expect(sub.file).toBe(path.join(sessionsDirOf(ws), h.session.id, "agents", `${sub.id}.jsonl`));
    const childRecords = records(sub.file!);
    expect(childRecords[0]).toMatchObject({ type: "meta", sessionId: sub.id, parentSessionId: h.session.id, agentType: "explore" });
    // La decisión del Read del subagente va a su fichero; en el del principal, solo la del Agent.
    expect(childRecords.filter((r) => r.type === "approval")).toMatchObject([{ toolUseId: "cr", tool: "Read", origin: "policy", reason: "read inside workspace" }]);
    expect(main.filter((r) => r.type === "approval")).toMatchObject([{ toolUseId: "ag", tool: "Agent", decision: "allow", origin: "policy" }]);
    // El registro subagent va entre el tool_use del Agent y su tool_result.
    const types = main.map((r) => r.type);
    expect(types.indexOf("subagent")).toBeLessThan(types.lastIndexOf("message"));
  });

  it("un Bash en segundo plano deja su task running y el de fin, con estado y exit code", async () => {
    const { h } = await start(
      (_r, turn) => {
        if (turn === 1) return { content: [use("b1", "Bash", { command: "echo listo; exit 3", run_in_background: true, description: "falla a propósito" })] };
        if (turn === 2) return { content: [use("b2", "Bash", { command: "sleep 0.5" })] };
        return { content: [text("hecho")] };
      },
      { rules: { allow: ["Bash"] } },
    );
    await h.agent.run("arranca");
    const tasks = records(fileOf(h)).filter((r) => r.type === "task");
    expect(tasks).toMatchObject([
      { kind: "shell", description: "falla a propósito", status: "running" },
      { kind: "shell", description: "falla a propósito", status: "failed", exitCode: 3 },
    ]);
    expect(tasks[1]).toHaveProperty("summary");
  });
});

describe("las sesiones, protegidas del propio agente", () => {
  const call = (name: string, input: unknown = {}): ToolUseBlock => ({ type: "tool_use", id: "x", name, input });

  it("Edit y Write sobre un transcript se deniegan en bypass aunque --allow \"Edit(**)\"; también una redirección", async () => {
    const root = sessionsRoot();
    mkdirSync(root, { recursive: true });
    const transcript = path.join(realpathSync(root), "tienda-12345678", "s.jsonl");
    const policy = new PolicyEngine(
      { workspace: tmp("lab-sessions-ws-"), mode: "bypass", rules: emptyRules(), flagRules: { allow: ["Edit(**)", "Write(**)", "Bash"] }, sessionsRoot: realpathSync(root) },
      await BashParser.create(),
    );
    for (const name of ["Edit", "Write"])
      expect(policy.evaluate(call(name), { kind: "path", path: transcript, access: "write" })).toEqual({
        kind: "deny",
        reason: SESSIONS_DENY_REASON,
        origin: "rule",
        rule: SESSIONS_RULE,
        ruleSource: "builtin",
      });
    expect(policy.evaluate(call("Bash"), { kind: "command", command: `echo '{}' >> ${transcript}` })).toMatchObject({ kind: "deny", ruleSource: "builtin" });
  });

  it("en un run, la deny integrada deja su approval y el fichero no cambia", async () => {
    const ws = tmp("lab-sessions-ws-");
    const prev = await session(ws, "la sesión que no se toca");
    const file = fileOf(prev);
    const before = readFileSync(file, "utf8");
    const { h } = await start(once(use("w1", "Write", { file_path: file, content: "borrado" })), {
      workspace: ws,
      permissionMode: "bypass",
      flagRules: { allow: ["Edit(**)"] },
    });
    await h.agent.run("reescribe el transcript");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(records(fileOf(h)).find((r) => r.type === "approval")).toMatchObject({ decision: "deny", origin: "rule", ruleSource: "builtin", reason: SESSIONS_DENY_REASON });
  });

  it("leer un transcript pregunta en default (está fuera del workspace) y se deniega en plan", async () => {
    const ws = tmp("lab-sessions-ws-");
    const file = fileOf(await session(ws, "algo privado"));
    const asked: string[] = [];
    const { h } = await start(once(use("r1", "Read", { file_path: file })), { workspace: ws, approver: async (req) => (asked.push(req.reason), { kind: "deny" }) });
    await h.agent.run("lee el transcript");
    expect(asked).toEqual([`read outside workspace: ${realpathSync(file)}`]);
    const plan = await start(once(use("r2", "Read", { file_path: file })), { workspace: ws, permissionMode: "plan" });
    await plan.h.agent.run("lee el transcript");
    expect(records(fileOf(plan.h)).find((r) => r.type === "approval")).toMatchObject({ decision: "deny", origin: "mode", reason: expect.stringMatching(/^plan mode: read outside workspace/) });
  });

  it("~/.harness/sessions está entre las rutas ocultas y bwrap la tapa con un tmpfs", async () => {
    await start(answer("x"));
    expect(defaultHiddenPaths()).toContain(sessionsRoot());
    const args = bwrapSandbox.wrap(["cat", "x"], { cwd: "/w", writablePaths: ["/w"], hiddenPaths: defaultHiddenPaths(), network: "none" });
    const i = args.indexOf(sessionsRoot());
    expect(args[i - 1]).toBe("--tmpfs");
  });
});

const approvalsIds = (file: string) => records(file).flatMap((r) => (r.type === "approval" ? [r.toolUseId] : []));

/** Espera activa corta: el run sigue en segundo plano. */
async function vi_waitFor(cond: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}
