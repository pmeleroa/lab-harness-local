import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { type HarnessOptions, createHarness } from "../src/index.js";
import type { AgentEvent } from "../src/core/events.js";
import type { Block, Message, Provider } from "../src/providers/canonical.js";
import { FakeProvider, type Script, text, use } from "./fake-provider.js";

let workspace: string;

beforeAll(() => {
  workspace = realpathSync(mkdtempSync(path.join(os.tmpdir(), "lab-loop-")));
  mkdirSync(path.join(workspace, "src"));
  writeFileSync(path.join(workspace, "src", "a.ts"), "export const a = 1;\n");
});

function setup(script: Script, config = {}) {
  const provider = new FakeProvider(script);
  const h = createHarness({ workspace, provider, config });
  const events: AgentEvent[] = [];
  h.bus.on((e) => events.push(e));
  return { ...h, provider, events };
}

/** Invariante del contrato: cada tool_use del asistente tiene su tool_result en el mensaje siguiente. */
function expectEveryCallAnswered(messages: Message[]) {
  messages.forEach((m, i) => {
    if (m.role !== "assistant") return;
    const ids = m.content.flatMap((b) => (b.type === "tool_use" ? [b.id] : []));
    if (!ids.length) return;
    const next = messages[i + 1];
    const answered = next?.content.flatMap((b: Block) => (b.type === "tool_result" ? [b.tool_use_id] : [])) ?? [];
    expect(answered.sort()).toEqual(ids.sort());
  });
}

describe("final: end_turn", () => {
  it("llama a una herramienta, recibe el resultado y responde", async () => {
    const { agent, provider, events } = setup((_req, turn) =>
      turn === 1 ? { content: [use("c1", "Read", { file_path: "src/a.ts" })] } : { content: [text("a vale 1")] },
    );
    const r = await agent.run("¿cuánto vale a?");
    expect(r).toMatchObject({ reason: "end_turn", text: "a vale 1", turns: 2, toolCalls: 1 });
    expectEveryCallAnswered(agent.messages);
    // El segundo turno ve el resultado de la herramienta.
    const second = provider.requests[1]!.messages.at(-1)!;
    expect(second.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "c1" });
    expect(JSON.stringify(second)).toContain("export const a = 1;");
    expect(events.map((e) => e.t)).toContain("tool_end");
    expect(events.at(-1)).toMatchObject({ t: "run_end", reason: "end_turn" });
  });

  it("emite el texto en streaming por el bus", async () => {
    const { agent, events } = setup(() => ({ content: [text("hola")] }));
    await agent.run("hi");
    expect(events.filter((e) => e.t === "text_delta")).toEqual([{ t: "text_delta", text: "hola" }]);
  });
});

describe("final: max_turns", () => {
  it("corta un modelo que nunca termina", async () => {
    // Cada turno pide un fichero distinto para no activar el circuit breaker.
    const { agent } = setup((_req, turn) => ({ content: [use(`c${turn}`, "Glob", { pattern: `*${turn}.ts` })] }), { maxTurns: 3 });
    const r = await agent.run("busca");
    expect(r).toMatchObject({ reason: "max_turns", turns: 3, toolCalls: 3 });
    expectEveryCallAnswered(agent.messages);
  });
});

describe("final: repeated_failure", () => {
  it("para cuando la misma llamada falla tres veces seguidas", async () => {
    const { agent, events } = setup((_req, turn) => ({ content: [use(`c${turn}`, "Read", { file_path: "no-existe.txt" })] }));
    const r = await agent.run("lee");
    expect(r).toMatchObject({ reason: "repeated_failure", turns: 3, toolCalls: 3 });
    expect(events.some((e) => e.t === "warning")).toBe(true);
    expectEveryCallAnswered(agent.messages);
  });

  it("fallos con entradas distintas no cuentan como repetición", async () => {
    const files = ["a.txt", "b.txt", "c.txt", "d.txt"];
    const { agent } = setup((_req, turn) =>
      turn <= files.length ? { content: [use(`c${turn}`, "Read", { file_path: files[turn - 1] })] } : { content: [text("no hay nada")] },
    );
    expect((await agent.run("lee")).reason).toBe("end_turn");
  });

  it("un éxito de la misma llamada reinicia la cuenta", async () => {
    const flaky = path.join(workspace, "flaky.txt");
    const { agent } = setup((_req, turn) => {
      // Falla (no existe), falla, aparece y funciona, desaparece y vuelve a fallar dos veces.
      if (turn === 3) writeFileSync(flaky, "x\n");
      if (turn === 4) rmSync(flaky);
      return turn <= 5 ? { content: [use(`c${turn}`, "Read", { file_path: "flaky.txt" })] } : { content: [text("listo")] };
    });
    expect((await agent.run("lee")).reason).toBe("end_turn");
  });
});

describe("final: empty_response", () => {
  it("reintenta una vez con feedback y, si vuelve a pasar, termina", async () => {
    const { agent, provider, events } = setup(() => ({ content: [] }));
    const r = await agent.run("hola");
    expect(r.reason).toBe("empty_response");
    expect(r.turns).toBe(2);
    expect(r.error).toContain("Empty response again");
    expect(events.filter((e) => e.t === "warning")).toHaveLength(1);
    // El feedback le dice qué herramientas existen.
    expect(JSON.stringify(provider.requests[1]!.messages)).toContain("The only tools you can call are: Read, Glob");
  });

  it("si responde tras el feedback, el run continúa con normalidad", async () => {
    const { agent } = setup((_req, turn) => (turn === 1 ? { content: [] } : { content: [text("ya")] }));
    expect(await agent.run("hola")).toMatchObject({ reason: "end_turn", text: "ya" });
  });
});

describe("final: max_tokens", () => {
  it("una respuesta truncada no se presenta como un final normal", async () => {
    const { agent } = setup(() => ({ content: [text("La respuesta empieza")], stopReason: "max_tokens" }));
    expect(await agent.run("explica")).toMatchObject({ reason: "max_tokens", text: "La respuesta empieza" });
  });
});

describe("finales secundarios", () => {
  it("max_tool_calls: corta al superar el tope de llamadas del run", async () => {
    const { agent } = setup((_req, turn) => ({ content: [use(`c${turn}`, "Glob", { pattern: `*${turn}.ts` })] }), { maxToolCalls: 2 });
    expect(await agent.run("busca")).toMatchObject({ reason: "max_tool_calls", toolCalls: 2 });
    expectEveryCallAnswered(agent.messages);
  });

  it("refusal: el proveedor rechaza la petición", async () => {
    const { agent } = setup(() => ({ content: [text("No puedo ayudar con eso.")], stopReason: "refusal" }));
    expect((await agent.run("algo")).reason).toBe("refusal");
  });
});

describe("final: error", () => {
  it("un proveedor que lanza termina el run con error, sin excepción", async () => {
    const provider: Provider = {
      id: "roto",
      capabilities: { cache: false, parallelTools: false, contextWindow: 1000 },
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
      },
    };
    const h = createHarness({ workspace, provider });
    const r = await h.agent.run("hola");
    expect(r).toMatchObject({ reason: "error", turns: 0 });
    expect(r.error).toContain("ECONNREFUSED");
    expect(h.agent.state).toBe("error");
  });

  it("un stream sin message_end es un error", async () => {
    const provider: Provider = {
      id: "cortado",
      capabilities: { cache: false, parallelTools: false, contextWindow: 1000 },
      async *stream() {
        yield { t: "text_delta", text: "a medias" };
      },
    };
    const r = await createHarness({ workspace, provider }).agent.run("hola");
    expect(r.reason).toBe("error");
    expect(r.error).toContain("without message_end");
  });
});

describe("final: aborted", () => {
  it("una señal ya cancelada no llama al modelo", async () => {
    const { agent, provider } = setup(() => ({ content: [text("no")] }));
    const ctl = new AbortController();
    ctl.abort();
    expect((await agent.run("hola", ctl.signal)).reason).toBe("aborted");
    expect(provider.requests).toHaveLength(0);
  });
});

describe("herramientas que fallan no rompen el bucle", () => {
  it("input inválido y herramienta inexistente vuelven al modelo como error", async () => {
    const { agent } = setup((_req, turn) =>
      turn === 1
        ? { content: [use("c1", "Read", { file_path: 42 }), use("c2", "Bash", { command: "ls" })] }
        : { content: [text("vale")] },
    );
    const r = await agent.run("lee");
    expect(r.reason).toBe("end_turn");
    const results = agent.messages[2]!.content;
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ tool_use_id: "c1", is_error: true });
    expect(JSON.stringify(results[0])).toContain("Invalid input for Read");
    expect(results[1]).toMatchObject({ tool_use_id: "c2", is_error: true });
    expect(JSON.stringify(results[1])).toContain("Unknown tool: Bash");
    expectEveryCallAnswered(agent.messages);
  });

  it("una lectura fuera del workspace sin terminal se deniega y el modelo ve el motivo", async () => {
    const { agent } = setup((_req, turn) =>
      turn === 1 ? { content: [use("c1", "Read", { file_path: "../../etc/passwd" })] } : { content: [text("no puedo")] },
    );
    await agent.run("lee");
    expect(agent.messages[2]!.content[0]).toMatchObject({ type: "tool_result", is_error: true });
    expect(JSON.stringify(agent.messages[2])).toContain("No interactive user available");
  });

  it("varias llamadas en un turno devuelven los resultados en el mismo orden", async () => {
    const { agent } = setup((_req, turn) =>
      turn === 1
        ? { content: [use("a", "Glob", { pattern: "*.ts" }), use("b", "Read", { file_path: "src/a.ts" }), use("c", "Read", { file_path: "nada" })] }
        : { content: [text("ok")] },
    );
    await agent.run("todo");
    expect(agent.messages[2]!.content.map((b) => b.type === "tool_result" && b.tool_use_id)).toEqual(["a", "b", "c"]);
    expectEveryCallAnswered(agent.messages);
  });
});

/** Un workspace propio por test: estos escriben. */
function writable(files: Record<string, string> = {}) {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "lab-perm-")));
  const ws = path.join(base, "ws");
  const outside = path.join(base, "fuera");
  mkdirSync(path.join(ws, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(ws, "src", "a.ts"), "export const a = 1;\n");
  for (const [f, c] of Object.entries(files)) writeFileSync(path.join(ws, f), c);
  return { ws, outside };
}

function runWith(ws: string, calls: Block[], o: Partial<HarnessOptions> = {}) {
  const provider = new FakeProvider((_req, turn) => (turn === 1 ? { content: calls } : { content: [text("hecho")] }));
  const h = createHarness({ workspace: ws, provider, ...o });
  const events: AgentEvent[] = [];
  h.bus.on((e) => events.push(e));
  return { ...h, events };
}

const resultText = (agent: { messages: Message[] }) => JSON.stringify(agent.messages[2]);

describe("permisos en el bucle", () => {
  it("default: Edit pregunta y, sin terminal, se deniega sin tocar el fichero", async () => {
    const { ws } = writable();
    const { agent } = runWith(ws, [use("r", "Read", { file_path: "src/a.ts" }), use("e", "Edit", { file_path: "src/a.ts", old_string: "1", new_string: "2" })]);
    await agent.run("cambia");
    expect(readFileSync(path.join(ws, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(resultText(agent)).toContain("No interactive user available");
  });

  it("acceptEdits: Read y Edit dentro del workspace, sin preguntar", async () => {
    const { ws } = writable();
    // En el mismo turno los dos van seguidos: Read es de solo lectura y Edit no, así que corren en orden.
    const { agent, events } = runWith(ws, [use("r", "Read", { file_path: "src/a.ts" }), use("e", "Edit", { file_path: "src/a.ts", old_string: "= 1", new_string: "= 2" })], { permissionMode: "acceptEdits" });
    await agent.run("cambia");
    expect(readFileSync(path.join(ws, "src/a.ts"), "utf8")).toBe("export const a = 2;\n");
    expect(events.some((e) => e.t === "permission_request")).toBe(false);
  });

  it("bypass: un deny sigue ganando", async () => {
    const { ws } = writable({ ".env": "TOKEN=1\n" });
    const { agent, events } = runWith(ws, [use("r", "Read", { file_path: ".env" }), use("e", "Edit", { file_path: ".env", old_string: "1", new_string: "2" })], {
      permissionMode: "bypass",
      rules: { deny: ["Read(**/.env*)", "Edit(**/.env*)"] },
    });
    await agent.run("cambia");
    expect(readFileSync(path.join(ws, ".env"), "utf8")).toBe("TOKEN=1\n");
    expect(resultText(agent)).toContain("Permission denied");
    expect(events.filter((e) => e.t === "permission_decision" && e.decision === "deny")).toHaveLength(2);
  });

  it("Edit(...) cubre a Write y una regla deny no deja crear el fichero", async () => {
    const { ws } = writable();
    const { agent } = runWith(ws, [use("w", "Write", { file_path: ".harness/settings.json", content: "{}" })], {
      permissionMode: "acceptEdits",
      rules: { deny: ["Edit(.harness/**)"] },
    });
    await agent.run("amplía permisos");
    expect(() => readFileSync(path.join(ws, ".harness/settings.json"))).toThrow();
    expect(resultText(agent)).toContain("Permission denied");
  });

  it("acceptEdits: escribir fuera del workspace pregunta y sin terminal se deniega", async () => {
    const { ws, outside } = writable();
    const { agent } = runWith(ws, [use("w", "Write", { file_path: path.join(outside, "x.txt"), content: "x" })], { permissionMode: "acceptEdits" });
    await agent.run("escribe fuera");
    expect(() => readFileSync(path.join(outside, "x.txt"))).toThrow();
    expect(resultText(agent)).toContain("No interactive user available");
  });

  it("un enlace simbólico hacia fuera se trata como fuera: ni leer ni escribir sin permiso", async () => {
    const { ws, outside } = writable();
    writeFileSync(path.join(outside, "token.txt"), "TOP-SECRET");
    symlinkSync(outside, path.join(ws, "link-out"));
    const { agent } = runWith(ws, [use("r", "Read", { file_path: "link-out/token.txt" }), use("w", "Write", { file_path: "link-out/nuevo.txt", content: "x" })], { permissionMode: "acceptEdits" });
    await agent.run("sigue el enlace");
    expect(resultText(agent)).not.toContain("TOP-SECRET");
    expect(() => readFileSync(path.join(outside, "nuevo.txt"))).toThrow();
  });

  it("un deny de lectura oculta el fichero también a Grep", async () => {
    const { ws } = writable({ ".env": "TOKEN=1\n", "notas.txt": "TOKEN=2\n" });
    const { agent } = runWith(ws, [use("g", "Grep", { pattern: "TOKEN", output_mode: "content" })], { rules: { deny: ["Read(**/.env*)"] } });
    await agent.run("busca");
    expect(resultText(agent)).toContain("notas.txt");
    expect(resultText(agent)).not.toContain(".env:");
    expect(resultText(agent)).toContain("excluded by permission rules");
  });
});
