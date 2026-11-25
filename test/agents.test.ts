import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_TOOL, BUILTIN_AGENTS, agentRoots, loadAgents, mcpToolAllowed, toolsFor } from "../src/agents/loader.js";
import { Semaphore } from "../src/agents/runs.js";
import { BackgroundTasks } from "../src/core/background.js";
import type { AgentEvent } from "../src/core/events.js";
import type { ApprovalRequest, Approver } from "../src/core/loop.js";
import { type Harness, type HarnessOptions, MAX_CONCURRENT_SUBAGENTS, createHarness } from "../src/index.js";
import { BashParser } from "../src/policy/bash-parser.js";
import { PolicyEngine, emptyRules, narrowMode } from "../src/policy/engine.js";
import type { CanonicalRequest, ToolResultBlock, ToolUseBlock } from "../src/providers/canonical.js";
import { FakeProvider, type Script, text, use } from "./fake-provider.js";

let harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses) h.dispose();
  harnesses = [];
});

const tmp = (prefix = "lab-agents-") => realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));

/** El provider es compartido: las peticiones de un subagente se distinguen por su system prompt. */
const isChild = (req: CanonicalRequest) => req.system.some((s) => s.text.includes("# Subagent"));
const childType = (req: CanonicalRequest) => /as a "([^"]+)" subagent/.exec(req.system.map((s) => s.text).join("\n"))?.[1];
const lastResults = (req: CanonicalRequest): ToolResultBlock[] =>
  req.messages.at(-1)!.content.filter((b): b is ToolResultBlock => b.type === "tool_result");

/** Guion por agente: `parent` y `child` reciben su número de turno propio (1, 2, …). */
function scripted(parent: Script, child: Script): Script {
  let p = 0;
  let c = 0;
  return (req) => (isChild(req) ? child(req, ++c) : parent(req, ++p));
}

async function setup(script: Script, o: Partial<HarnessOptions> = {}) {
  const provider = (o.provider as FakeProvider | undefined) ?? new FakeProvider(script);
  const events: AgentEvent[] = [];
  const h = await createHarness({ workspace: o.workspace ?? tmp("lab-agents-ws-"), sandbox: "none", mcp: false, ...o, provider });
  harnesses.push(h);
  h.bus.on((e) => events.push(e));
  return { h, provider, events };
}

describe("loadAgents", () => {
  it("integrados + .harness/agents; el del proyecto gana y las tools se filtran con aviso", () => {
    const ws = tmp();
    const dir = path.join(ws, ".harness", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "revisor.md"), "---\ndescription: del proyecto\ntools: [Read, Bash, Agent, Inventada]\nmodel: otro-modelo\nmode: plan\n---\nRevisa el diff.");
    writeFileSync(path.join(dir, "explore.md"), "---\ndescription: explore propio\nmode: raro\nmaxTurns: cero\n---\nBusca.");
    writeFileSync(path.join(dir, "sin.md"), "---\nname: sin\n---\nNada.");
    writeFileSync(path.join(dir, "Mal Nombre.md"), "---\ndescription: x\n---\nx");
    writeFileSync(path.join(dir, "heredado.md"), "---\ndescription: usa el modelo del principal\nmodel: inherit\nmaxTurns: 7\n---\nx");
    writeFileSync(path.join(dir, "notas.txt"), "no es un agente");

    const { agents, warnings } = loadAgents(ws, ["Read", "Write", "Edit", "Bash"]);
    expect(agents.map((a) => [a.name, a.source])).toEqual([
      ["explore", "proyecto"],
      ["general", "integrado"],
      ["heredado", "proyecto"],
      ["revisor", "proyecto"],
    ]);
    expect(agents.find((a) => a.name === "revisor")).toMatchObject({
      description: "del proyecto",
      tools: ["Read", "Bash"],
      model: "otro-modelo",
      mode: "plan",
      prompt: "Revisa el diff.",
    });
    expect(agents.find((a) => a.name === "heredado")).toMatchObject({ maxTurns: 7 });
    expect(agents.find((a) => a.name === "heredado")!.model).toBeUndefined();
    expect(agents.find((a) => a.name === "explore")!.mode).toBeUndefined();
    expect(warnings).toEqual([
      expect.stringMatching(/nombre no válido "Mal Nombre"/),
      expect.stringMatching(/mode "raro"/),
      expect.stringMatching(/maxTurns "cero"/),
      expect.stringMatching(/revisor: tools ignoradas \(Agent, Inventada\)/),
      expect.stringMatching(/sin description/),
    ]);
  });

  it("solo busca en el proyecto: el lab no tiene capa de usuario", () => {
    const ws = tmp();
    expect(agentRoots(ws)).toEqual([{ dir: path.join(ws, ".harness", "agents"), source: "proyecto" }]);
    expect(loadAgents(ws, ["Read"]).agents.map((a) => a.name)).toEqual(BUILTIN_AGENTS.map((a) => a.name));
  });

  it("toolsFor: el subconjunto pedido de lo disponible, en su orden, y nunca Agent", () => {
    const general = BUILTIN_AGENTS.find((a) => a.name === "general")!;
    const explore = BUILTIN_AGENTS.find((a) => a.name === "explore")!;
    expect(toolsFor(general, ["Read", "Bash", AGENT_TOOL])).toEqual(["Read", "Bash"]);
    expect(toolsFor(explore, ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "BashOutput"])).toEqual(["Read", "Glob", "Grep", "Bash"]);
  });

  it("mcpToolAllowed: sin MCP en tools recibe todas; si nombra alguna, solo esas", () => {
    const base = { name: "x", description: "x", prompt: "", source: "proyecto" as const };
    expect(mcpToolAllowed({ ...base }, "mcp__github__issue_read", "github")).toBe(true);
    expect(mcpToolAllowed({ ...base, tools: ["Read"] }, "mcp__github__issue_read", "github")).toBe(true);
    expect(mcpToolAllowed({ ...base, tools: ["mcp__github"] }, "mcp__github__issue_read", "github")).toBe(true);
    expect(mcpToolAllowed({ ...base, tools: ["mcp__github__get_*"] }, "mcp__github__issue_read", "github")).toBe(false);
    expect(mcpToolAllowed({ ...base, tools: ["mcp__github"] }, "mcp__inventory__get_stock", "inventory")).toBe(false);
  });
});

describe("modo plan y política de los subagentes", () => {
  const call = (name: string, input: unknown): ToolUseBlock => ({ type: "tool_use", id: "c", name, input });

  async function engine(mode: "default" | "acceptEdits" | "plan" | "bypass", deny: string[] = []) {
    const ws = tmp();
    return { ws, policy: new PolicyEngine({ workspace: ws, mode, rules: { ...emptyRules(), deny } }, await BashParser.create()) };
  }

  it("plan deniega lo que preguntaría y deja leer", async () => {
    const { ws, policy } = await engine("plan");
    expect(policy.evaluate(call("Write", {}), { kind: "path", path: path.join(ws, "a.txt"), access: "write" })).toMatchObject({
      kind: "deny",
      reason: expect.stringMatching(/^plan mode: /),
    });
    expect(policy.evaluate(call("Read", {}), { kind: "path", path: path.join(ws, "a.txt"), access: "read" }).kind).toBe("allow");
    expect(policy.evaluate(call("Bash", {}), { kind: "command", command: "ls -la" }).kind).toBe("allow");
    expect(policy.evaluate(call("Bash", {}), { kind: "command", command: "touch x" }).kind).toBe("deny");
  });

  it("en plan no pasa ninguna tool MCP, ni con una regla allow", async () => {
    const ws = tmp();
    const policy = new PolicyEngine({ workspace: ws, mode: "plan", rules: { ...emptyRules(), allow: ["mcp__github"] } }, await BashParser.create());
    expect(policy.evaluate(call("mcp__github__issue_read", {}), { kind: "mcp", server: "github" })).toMatchObject({ kind: "deny" });
  });

  it("narrowMode y derive: un subagente nunca es más permisivo que quien lo lanza", async () => {
    expect(narrowMode("plan", "acceptEdits")).toBe("plan");
    expect(narrowMode("acceptEdits", "plan")).toBe("plan");
    expect(narrowMode("default", undefined)).toBe("default");
    expect(narrowMode("default", "bypass")).toBe("default");
    const { policy } = await engine("default", ["Read(**/.env)"]);
    policy.addSessionRule("allow", "Bash(npm test *)");
    const child = policy.derive("bypass");
    expect(child.mode).toBe("default");
    expect(policy.derive("plan").mode).toBe("plan");
    // Hereda los deny y las reglas «siempre» aceptadas hasta ahora; lo que acepte el hijo se queda en él.
    expect(child.evaluate(call("Bash", {}), { kind: "command", command: "npm test -- x" }).kind).toBe("allow");
    child.addSessionRule("allow", "Bash(make *)");
    expect(policy.evaluate(call("Bash", {}), { kind: "command", command: "make all" }).kind).toBe("ask");
  });

  it("lanzar se permite salvo regla Agent o Agent(<tipo>)", async () => {
    const { policy } = await engine("default", ["Agent(general)"]);
    expect(policy.evaluate(call("Agent", {}), { kind: "agent", type: "explore" }).kind).toBe("allow");
    expect(policy.evaluate(call("Agent", {}), { kind: "agent", type: "general" }).kind).toBe("deny");
    const { policy: all } = await engine("default", ["Agent"]);
    expect(all.evaluate(call("Agent", {}), { kind: "agent", type: "explore" }).kind).toBe("deny");
  });
});

describe("tool Agent", () => {
  it("lanza un subagente con su propio contexto y devuelve solo su informe", async () => {
    const ws = tmp();
    writeFileSync(path.join(ws, "a.txt"), "secreto del fichero");
    const { h, provider, events } = await setup(
      scripted(
        (_r, turn) =>
          turn === 1
            ? { content: [use("p1", "Agent", { description: "busca a", prompt: "Lee a.txt y resume", subagent_type: "explore" })] }
            : { content: [text("hecho")] },
        (_r, turn) => (turn === 1 ? { content: [use("c1", "Read", { file_path: "a.txt" })] } : { content: [text("a.txt contiene un secreto")] }),
      ),
      { workspace: ws },
    );

    const r = await h.agent.run("investiga");
    expect(r.reason).toBe("end_turn");

    const childReqs = provider.requests.filter(isChild);
    expect(childReqs).toHaveLength(2);
    expect(childReqs[0]!.tools.map((t) => t.name)).toEqual(["Read", "Glob", "Grep", "Bash"]);
    expect(childReqs[0]!.messages[0]!.content).toEqual([{ type: "text", text: "Lee a.txt y resume" }]);

    // Al principal solo llega el informe; el contenido del fichero se queda en el subagente.
    const parentReqs = provider.requests.filter((q) => !isChild(q));
    expect(parentReqs[0]!.tools.map((t) => t.name)).toContain("Agent");
    const [res] = lastResults(parentReqs[1]!);
    expect(res).toMatchObject({ tool_use_id: "p1", content: "a.txt contiene un secreto" });
    expect(JSON.stringify(parentReqs[1]!.messages)).not.toContain("secreto del fichero");

    // Eventos: los del hijo, etiquetados; inicio y fin enlazados con la llamada.
    const start = events.find((e) => e.t === "subagent_start");
    expect(start).toMatchObject({ type: "explore", description: "busca a", toolUseId: "p1" });
    const tagged = events.filter((e) => e.agent);
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged.every((e) => e.agent!.type === "explore" && e.agent!.id === (start as { id: string }).id)).toBe(true);
    expect(tagged.some((e) => e.t === "tool_start" && e.call.name === "Read")).toBe(true);
    const end = events.find((e) => e.t === "subagent_end");
    expect(end).toMatchObject({ reason: "end_turn", turns: 2, toolCalls: 1 });
    expect((end as { peakContext: number }).peakContext).toBeGreaterThan(0);

    expect(h.subagentRuns).toHaveLength(1);
    expect(h.subagentRuns[0]).toMatchObject({ type: "explore", description: "busca a", reason: "end_turn", toolCalls: 1, reportTokens: 7 });
  });

  it("explore está en modo plan: no puede escribir aunque el principal acepte ediciones", async () => {
    const ws = tmp();
    const { h, provider } = await setup(
      scripted(
        (_r, turn) =>
          turn === 1 ? { content: [use("p1", "Agent", { description: "x", prompt: "escribe", subagent_type: "explore" })] } : { content: [text("ok")] },
        (_r, turn) => (turn === 1 ? { content: [use("c1", "Bash", { command: "touch x.txt" })] } : { content: [text("no pude")] }),
      ),
      { workspace: ws, permissionMode: "acceptEdits" },
    );
    await h.agent.run("x");
    const childResult = lastResults(provider.requests.filter(isChild)[1]!)[0]!;
    expect(childResult.is_error).toBe(true);
    expect(childResult.content).toMatch(/plan mode/);
    expect(existsSync(path.join(ws, "x.txt"))).toBe(false);
  });

  it("los permisos del subagente pasan por el approver con su identidad", async () => {
    const asked: ApprovalRequest[] = [];
    const approver: Approver = async (req) => {
      asked.push(req);
      return { kind: "allow_once" };
    };
    const ws = tmp();
    const { h } = await setup(
      scripted(
        (_r, turn) =>
          turn === 1 ? { content: [use("p1", "Agent", { description: "x", prompt: "crea f", subagent_type: "general" })] } : { content: [text("ok")] },
        (_r, turn) => (turn === 1 ? { content: [use("c1", "Write", { file_path: "f.txt", content: "hola" })] } : { content: [text("creado")] }),
      ),
      { workspace: ws, approver },
    );
    await h.agent.run("x");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.call.name).toBe("Write");
    expect(asked[0]!.agent).toMatchObject({ type: "general" });
    expect(readFileSync(path.join(ws, "f.txt"), "utf8")).toBe("hola");
  });

  it("con el principal en plan, un general tampoco escribe", async () => {
    const { h, provider } = await setup(
      scripted(
        (_r, turn) =>
          turn === 1 ? { content: [use("p1", "Agent", { description: "x", prompt: "escribe", subagent_type: "general" })] } : { content: [text("ok")] },
        (_r, turn) => (turn === 1 ? { content: [use("c1", "Write", { file_path: "f.txt", content: "x" })] } : { content: [text("fin")] }),
      ),
      { permissionMode: "plan" },
    );
    await h.agent.run("x");
    expect(lastResults(provider.requests.filter(isChild)[1]!)[0]!.content).toMatch(/plan mode/);
  });

  it("una regla deny Agent(<tipo>) impide lanzarlo", async () => {
    const { h, provider } = await setup(
      scripted(
        (_r, turn) =>
          turn === 1 ? { content: [use("p1", "Agent", { description: "x", prompt: "y", subagent_type: "general" })] } : { content: [text("ok")] },
        () => ({ content: [text("no debería correr")] }),
      ),
      { rules: { deny: ["Agent(general)"] } },
    );
    await h.agent.run("x");
    expect(provider.requests.some(isChild)).toBe(false);
    expect(lastResults(provider.requests[1]!)[0]!.content).toMatch(/denied/i);
  });

  it("los subagentes no tienen la tool Agent (un solo nivel)", async () => {
    const { h, provider } = await setup(
      scripted(
        (_r, turn) =>
          turn === 1 ? { content: [use("p1", "Agent", { description: "x", prompt: "y", subagent_type: "general" })] } : { content: [text("ok")] },
        (_r, turn) => (turn === 1 ? { content: [use("c1", "Agent", { description: "z", prompt: "w", subagent_type: "explore" })] } : { content: [text("fin")] }),
      ),
    );
    await h.agent.run("x");
    const child = provider.requests.filter(isChild);
    expect(child[0]!.tools.map((t) => t.name)).not.toContain("Agent");
    expect(lastResults(child[1]!)[0]!.content).toMatch(/Unknown tool: Agent/);
    expect(h.subagentRuns).toHaveLength(1);
  });

  it("explore corre en paralelo con otras lecturas; general, en serie", async () => {
    let active = 0;
    let peak = 0;
    const provider = new FakeProvider(
      scripted(
        (_r, turn) =>
          turn === 1
            ? {
                content: [
                  use("p1", "Agent", { description: "a", prompt: "a", subagent_type: "explore" }),
                  use("p2", "Agent", { description: "b", prompt: "b", subagent_type: "explore" }),
                ],
              }
            : { content: [text("ok")] },
        () => ({ content: [text("informe")] }),
      ),
      { delayMs: 50 },
    );
    const stream = provider.stream.bind(provider);
    provider.stream = async function* (req, signal) {
      const child = isChild(req);
      if (child) peak = Math.max(peak, ++active);
      try {
        yield* stream(req, signal);
      } finally {
        if (child) active--;
      }
    };
    const { h } = await setup(() => ({ content: [] }), { provider });
    await h.agent.run("x");
    expect(peak).toBe(2);

    expect(h.registry.isReadOnly("Agent", { description: "a", prompt: "a", subagent_type: "explore" })).toBe(true);
    expect(h.registry.isReadOnly("Agent", { description: "a", prompt: "a", subagent_type: "general" })).toBe(false);
  });

  it(`como mucho ${MAX_CONCURRENT_SUBAGENTS} a la vez: el resto espera turno`, async () => {
    let active = 0;
    let peak = 0;
    const launches = Array.from({ length: MAX_CONCURRENT_SUBAGENTS + 2 }, (_, i) =>
      use(`p${i}`, "Agent", { description: `t${i}`, prompt: `t${i}`, subagent_type: "explore" }),
    );
    const provider = new FakeProvider(
      scripted((_r, turn) => (turn === 1 ? { content: launches } : { content: [text("ok")] }), () => ({ content: [text("informe")] })),
      { delayMs: 30 },
    );
    const stream = provider.stream.bind(provider);
    provider.stream = async function* (req, signal) {
      const child = isChild(req);
      if (child) peak = Math.max(peak, ++active);
      try {
        yield* stream(req, signal);
      } finally {
        if (child) active--;
      }
    };
    const { h } = await setup(() => ({ content: [] }), { provider });
    await h.agent.run("x");
    expect(peak).toBe(MAX_CONCURRENT_SUBAGENTS);
    expect(h.subagentRuns).toHaveLength(MAX_CONCURRENT_SUBAGENTS + 2);
  });

  it("si el subagente se queda sin turnos, el informe avisa de que puede estar incompleto", async () => {
    const ws = tmp();
    mkdirSync(path.join(ws, ".harness", "agents"), { recursive: true });
    writeFileSync(path.join(ws, ".harness", "agents", "corto.md"), "---\ndescription: dos turnos\ntools: Read\nmaxTurns: 2\n---\nLee.");
    writeFileSync(path.join(ws, "a.txt"), "a");
    const { h, provider } = await setup(
      scripted(
        (_r, turn) =>
          turn === 1 ? { content: [use("p1", "Agent", { description: "x", prompt: "y", subagent_type: "corto" })] } : { content: [text("ok")] },
        (_r, turn) => ({ content: [text(`voy por el ${turn}`), use(`c${turn}`, "Read", { file_path: "a.txt" })] }),
      ),
      { workspace: ws },
    );
    await h.agent.run("x");
    expect(childType(provider.requests.find(isChild)!)).toBe("corto");
    const res = lastResults(provider.requests.filter((q) => !isChild(q))[1]!)[0]!;
    expect(res.is_error).toBeUndefined();
    expect(res.content).toMatch(/stopped early \(max_turns\)/);
    expect(res.content).toContain("voy por el 2");
  });

  it("agents: false (--no-agents) quita la tool", async () => {
    const { h, provider } = await setup(() => ({ content: [text("ok")] }), { agents: false });
    await h.agent.run("x");
    expect(h.agents).toEqual([]);
    expect(provider.requests[0]!.tools.map((t) => t.name)).not.toContain("Agent");
  });

  it("un subagente no recibe BashOutput ni KillShell: sus comandos mueren con él", async () => {
    const { h, provider } = await setup(
      scripted(
        (_r, turn) =>
          turn === 1 ? { content: [use("p1", "Agent", { description: "x", prompt: "y", subagent_type: "general" })] } : { content: [text("ok")] },
        () => ({ content: [text("fin")] }),
      ),
    );
    await h.agent.run("x");
    const tools = provider.requests.find(isChild)!.tools;
    expect(tools.map((t) => t.name)).toEqual(["Read", "Glob", "Grep", "Write", "Edit", "Bash"]);
    expect(JSON.stringify(tools.find((t) => t.name === "Bash")!.inputSchema)).not.toContain("run_in_background");
  });
});

describe("Semaphore", () => {
  it("deja pasar a max a la vez y al resto en orden", async () => {
    const s = new Semaphore(2);
    const order: number[] = [];
    const r1 = await s.acquire();
    const r2 = await s.acquire();
    const p3 = s.acquire().then((r) => (order.push(3), r));
    const p4 = s.acquire().then((r) => (order.push(4), r));
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]);
    r1();
    r1(); // liberar dos veces no cuenta doble
    (await p3)();
    r2();
    (await p4)();
    expect(order).toEqual([3, 4]);
  });
});

describe("subagentes en segundo plano", () => {
  const isNotice = (b: { type: string; text?: string }) => b.type === "text" && !!b.text?.startsWith("<background-notification");
  const notices = (req: CanonicalRequest) => req.messages.flatMap((m) => m.content).filter(isNotice) as { text: string }[];
  const launch = (o: Record<string, unknown> = {}) =>
    use("p1", "Agent", { description: "busca el loop", prompt: "Busca dónde está el loop", subagent_type: "explore", run_in_background: true, ...o });

  /** Subagente lento: tres turnos (dos Glob y el informe). El principal termina antes. */
  const slowChild: Script = (_r, turn) => (turn < 3 ? { content: [use(`c${turn}`, "Glob", { pattern: "*" })] } : { content: [text("el loop está en src/core/loop.ts")] });

  it("vuelve al momento, el principal sigue y el informe llega como aviso en el run siguiente", async () => {
    const provider = new FakeProvider(
      scripted((_r, turn) => (turn === 1 ? { content: [launch()] } : { content: [text("sigo con lo mío")] }), slowChild),
      { delayMs: 30 },
    );
    const { h, events } = await setup(() => ({ content: [] }), { provider });
    const r = await h.agent.run("investiga");
    expect(r.reason).toBe("end_turn");

    const started = lastResults(provider.requests.find((q) => !isChild(q) && q.messages.length > 1)!)[0]!;
    expect(started.is_error).toBeFalsy();
    const id = /agent·([0-9a-f]{8})/.exec(started.content as string)![1]!;
    // El principal ha terminado y el subagente sigue: no lo bloqueó.
    expect(h.tasks.get(id)).toMatchObject({ kind: "agent", status: "running", description: "explore · busca el loop" });

    await h.tasks.nextNotification();
    expect(h.tasks.get(id)?.status).toBe("completed");
    // Los eventos del subagente llevan el id de la tarea y van marcados como background.
    expect(events.find((e) => e.t === "subagent_start")).toMatchObject({ id, background: true });
    expect(events.filter((e) => e.agent?.id === id).every((e) => e.agent?.background)).toBe(true);

    await h.agent.run("¿y bien?");
    const [n] = notices(provider.requests.at(-1)!);
    expect(n!.text).toMatch(new RegExp(`task="agent·${id}" status="completed"`));
    expect(n!.text).toContain("Report from the explore subagent:\nel loop está en src/core/loop.ts");
    expect(h.subagentRuns.map((x) => x.id)).toEqual([id]);
  });

  it("no relanza un subagente idéntico que sigue en marcha", async () => {
    const provider = new FakeProvider(
      scripted(
        (_r, turn) => (turn <= 2 ? { content: [launch({ description: `intento ${turn}` })] } : turn === 3 ? { content: [launch({ prompt: "otra cosa" })] } : { content: [text("ok")] }),
        (_r, turn) => ({ content: [use(`c${turn}`, "Glob", { pattern: "*" })] }), // no termina solo
      ),
      { delayMs: 5 },
    );
    const { h } = await setup(() => ({ content: [] }), { provider });
    await h.agent.run("x");
    const results = provider.requests.filter((q) => !isChild(q)).slice(1, 4).map((q) => lastResults(q)[0]!.content as string);
    const id = /agent·([0-9a-f]{8})/.exec(results[0]!)![1]!;
    expect(results[1]).toMatch(new RegExp(`^agent·${id} is already running this same task`));
    expect(results[2]).toMatch(/^Started agent·/);
    expect(h.tasks.list({ running: true })).toHaveLength(2);
  });

  it("un tipo que puede escribir se rechaza con un error claro y no arranca nada", async () => {
    const { h, provider } = await setup(
      scripted((_r, turn) => (turn === 1 ? { content: [launch({ subagent_type: "general" })] } : { content: [text("ok")] }), () => ({ content: [text("x")] })),
    );
    await h.agent.run("x");
    const [res] = lastResults(provider.requests.at(-1)!);
    expect(res).toMatchObject({ is_error: true });
    expect(res!.content).toMatch(/only available for read-only agent types \(explore\); "general" can write/);
    expect(h.tasks.list()).toEqual([]);
    expect(provider.requests.filter(isChild)).toEqual([]);
  });

  it("Ctrl+C sobre el principal no lo mata; kill sí", async () => {
    const provider = new FakeProvider(
      scripted(
        (_r, turn) => (turn === 1 ? { content: [launch()] } : { content: [use("p2", "Bash", { command: "sleep 30" })] }),
        (_r, turn) => ({ content: [use(`c${turn}`, "Glob", { pattern: "*" })] }), // nunca termina solo
      ),
      { delayMs: 20 },
    );
    const { h } = await setup(() => ({ content: [] }), { provider, rules: { allow: ["Bash"] } });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    expect((await h.agent.run("x", ac.signal)).reason).toBe("aborted");
    const [task] = h.tasks.list();
    expect(task).toMatchObject({ kind: "agent", status: "running" });

    expect(await h.tasks.kill(task!.id)).toMatchObject({ status: "killed" });
    expect(h.subagentRuns.at(-1)).toMatchObject({ id: task!.id, reason: "aborted" });
  });

  it("el campo run_in_background solo lo ve el principal, y la descripción dice qué tipos valen", async () => {
    const { h, provider } = await setup(
      scripted((_r, turn) => (turn === 1 ? { content: [use("p1", "Agent", { description: "x", prompt: "x", subagent_type: "explore" })] } : { content: [text("ok")] }), () => ({ content: [text("informe")] })),
    );
    await h.agent.run("x");
    const agentSpec = provider.requests[0]!.tools.find((t) => t.name === "Agent")!;
    expect(JSON.stringify(agentSpec.inputSchema)).toContain("run_in_background");
    expect(agentSpec.description).toContain("Read-only types now: explore.");
  });
});

describe("headless: esperar a los subagentes en segundo plano", () => {
  const launch = (id: string, prompt: string) =>
    use(id, "Agent", { description: prompt, prompt, subagent_type: "explore", run_in_background: true });
  const childPrompt = (req: CanonicalRequest) => {
    const first = req.messages[0]!.content[0];
    return first?.type === "text" ? first.text : "";
  };

  it("followUp espera al informe y hace otro run con él; el último run es el que cuenta", async () => {
    let parentTurn = 0;
    const provider = new FakeProvider(
      (req) => {
        if (isChild(req)) return req.messages.length < 3 ? { content: [use("c1", "Glob", { pattern: "*" })] } : { content: [text("informe: 3 ficheros")] };
        parentTurn++;
        if (parentTurn === 1) return { content: [launch("p1", "cuenta ficheros")] };
        if (parentTurn === 2) return { content: [text("lanzado, espero el informe")] };
        return { content: [text(`resumen final con ${JSON.stringify(req.messages.at(-1)!.content).includes("informe: 3 ficheros") ? "el informe" : "nada"}`)] };
      },
      { delayMs: 20 },
    );
    const { h } = await setup(() => ({ content: [] }), { provider });
    const waited: string[][] = [];
    const rounds: number[] = [];
    expect((await h.agent.run("cuenta")).reason).toBe("end_turn");
    const last = await h.followUp((p) => h.agent.run(p), {
      onWait: (ps) => waited.push(ps.map((p) => p.kind)),
      onRound: (ns) => rounds.push(ns.length),
    });
    expect(last).toMatchObject({ reason: "end_turn", text: "resumen final con el informe" });
    expect(waited).toEqual([["agent"]]);
    expect(rounds).toEqual([1]);
    expect(h.tasks.needsFollowUp()).toBe(false);
    // Sin nada pendiente, no hace ningún run.
    expect(await h.followUp((p) => h.agent.run(p))).toBeNull();
  });

  it("respeta el límite de rondas y mata lo que siga pendiente, con aviso", async () => {
    const provider = new FakeProvider(
      (req, turn) => {
        if (isChild(req))
          // "rápido" termina tras unos turnos (después de que acabe el run del principal); "lento" no termina nunca solo.
          return childPrompt(req) === "rápido" && req.messages.length > 6
            ? { content: [text("hecho rápido")] }
            : { content: [use(`c${turn}`, "Glob", { pattern: "*" })] };
        const last = req.messages.at(-1)!.content;
        if (req.messages.length === 1) return { content: [launch("p1", "rápido"), launch("p2", "lento")] };
        if (last.some((b) => b.type === "tool_result")) return { content: [text("lanzados")] };
        return { content: [text("recibido")] };
      },
      { delayMs: 10 },
    );
    const { h, events } = await setup(() => ({ content: [] }), { provider });
    await h.agent.run("lanza");
    const last = await h.followUp((p) => h.agent.run(p), { maxRounds: 1, waitMs: 3_000 });
    expect(last?.text).toBe("recibido");
    const slow = h.tasks.list().find((t) => t.description.includes("lento"))!;
    expect(slow.status).toBe("killed");
    expect(events.filter((e) => e.t === "warning").map((e) => (e as { message: string }).message)).toContainEqual(
      `Killed background agent·${slow.id} after 1 follow-up rounds: explore · lento`,
    );
    expect(h.tasks.needsFollowUp()).toBe(false);
  });

  it("si no llega ningún aviso en waitMs, mata lo pendiente y termina", async () => {
    const provider = new FakeProvider(
      (req, turn) => {
        if (isChild(req)) return { content: [use(`c${turn}`, "Glob", { pattern: "*" })] }; // no termina nunca solo
        return req.messages.length === 1 ? { content: [launch("p1", "lento")] } : { content: [text("lanzado")] };
      },
      { delayMs: 10 },
    );
    const { h, events } = await setup(() => ({ content: [] }), { provider });
    await h.agent.run("lanza");
    const t0 = Date.now();
    expect(await h.followUp((p) => h.agent.run(p), { waitMs: 200 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2_000);
    const [task] = h.tasks.list();
    expect(task?.status).toBe("killed");
    expect(events.some((e) => e.t === "warning" && e.message.startsWith(`Killed background agent·${task!.id} after waiting 0s`))).toBe(true);
  });

  it("needsFollowUp cuenta los avisos de subagentes sin entregar, no los de comandos", async () => {
    const tasks = new BackgroundTasks();
    tasks.start({ kind: "shell", description: "x", run: async () => ({ status: "completed", summary: "" }) });
    await tasks.nextNotification();
    expect(tasks.needsFollowUp()).toBe(false);
    tasks.start({ kind: "agent", description: "y", run: async () => ({ status: "completed", summary: "informe" }) });
    await new Promise((r) => setImmediate(r));
    expect(tasks.awaited()).toEqual([]);
    expect(tasks.needsFollowUp()).toBe(true);
    tasks.drain();
    expect(tasks.needsFollowUp()).toBe(false);
  });

  it("al acabar el run, los comandos se matan y los subagentes se esperan", async () => {
    const tasks = new BackgroundTasks();
    let stop: () => void = () => {};
    const forever = (signal: AbortSignal) => new Promise<{ status: "completed"; summary: string }>((resolve) => signal.addEventListener("abort", () => resolve({ status: "completed", summary: "" })));
    tasks.start({ kind: "shell", description: "dev server", run: (s) => forever(s) });
    tasks.start({ kind: "agent", description: "explore · x", run: (s) => new Promise((resolve) => (stop = () => resolve({ status: "completed", summary: "ok" }), s.addEventListener("abort", stop))) });
    const killed = await tasks.runEnd();
    expect(killed.map((t) => t.kind)).toEqual(["shell"]);
    expect(tasks.awaited().map((t) => t.kind)).toEqual(["agent"]);
    stop();
    await tasks.nextNotification();
    expect(tasks.awaited()).toEqual([]);
  });
});
