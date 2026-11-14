import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLEARED_NOTE, capToolResult, estimateRequest, extractSummary } from "../src/context/manager.js";
import { OVERFLOW_MIN_GROWTH_COMPACT, looksTruncated } from "../src/context/overflow.js";
import type { AgentEvent } from "../src/core/events.js";
import { createHarness } from "../src/index.js";
import type { Message, ToolResultBlock } from "../src/providers/canonical.js";
import { DEFAULT_CONTEXT_WINDOW, OpenAIProvider } from "../src/providers/openai.js";
import { FakeProvider, type Script, text, use } from "./fake-provider.js";

/** Fichero de ~`tokens` tokens en líneas cortas. */
const bigFile = (tokens: number) => `${"x".repeat(79)}\n`.repeat(Math.ceil((tokens * 4) / 80));

function workspace(files: Record<string, string> = {}): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "lab-ctx-")));
  for (const [f, c] of Object.entries(files)) writeFileSync(path.join(dir, f), c);
  return dir;
}

/** Ventana de 20k con 4k de respuesta: 16k útiles (clearing a 9,6k, compaction a 13,6k). */
async function setup(script: Script, o: { files?: Record<string, string>; config?: Record<string, unknown>; truncate?: { window: number; mode?: "collapse" | "plateau" } } = {}) {
  const provider = new FakeProvider(script, o.truncate ? { truncate: o.truncate } : {});
  const h = await createHarness({
    workspace: workspace(o.files),
    provider,
    config: { contextWindow: 20_000, maxTokens: 4_000, ...o.config },
  });
  const events: AgentEvent[] = [];
  h.bus.on((e) => events.push(e));
  return { ...h, provider, events };
}

const results = (ms: Message[]): ToolResultBlock[] =>
  ms.flatMap((m) => m.content.filter((b): b is ToolResultBlock => b.type === "tool_result"));

const isSummaryRequest = (req: { messages: Message[] }) => {
  const last = req.messages.at(-1)!.content.at(-1);
  return last?.type === "text" && last.text.includes("<summary></summary>");
};

describe("escalón 1: tope por resultado", () => {
  it("capToolResult deja intacto lo que cabe y recorta por el medio lo que no", () => {
    expect(capToolResult("corto", 100)).toBe("corto");
    const out = capToolResult(`INICIO${"a".repeat(10_000)}FIN`, 500);
    expect(out.length).toBeLessThan(2_100);
    expect(out).toContain("INICIO");
    expect(out).toContain("FIN");
  });

  it("un resultado nunca ocupa más del 20 % del espacio útil", async () => {
    const { agent, provider } = await setup(
      (_r, turn) => (turn === 1 ? { content: [use("t1", "Read", { file_path: "big.txt" })] } : { content: [text("ok")] }),
      { files: { "big.txt": bigFile(8_000) } },
    );
    await agent.run("lee");
    // 16k útiles * 0,2 = 3,2k tokens, unos 12,8k caracteres
    const [r] = results(provider.requests[1]!.messages);
    expect(r!.content.length).toBeLessThan(13_000);
    expect(r!.content).toContain("characters omitted");
  });
});

describe("escalón 2: limpiar resultados antiguos", () => {
  it("al pasar de clearAt sustituye los antiguos por una nota y la conversación guardada sigue completa", async () => {
    const files = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}.txt`, bigFile(2_500)]));
    const { agent, provider, events } = await setup(
      (_r, turn) => (turn <= 5 ? { content: [use(`t${turn}`, "Read", { file_path: `f${turn - 1}.txt` })] } : { content: [text("ok")] }),
      { files, config: { context: { maxToolResultTokens: 25_000, clearAt: 0.6, compactAt: 0.95, keepToolResults: 2 } } },
    );
    await agent.run("lee todos");
    expect(events.some((e) => e.t === "context" && e.action === "cleared")).toBe(true);
    const sent = results(provider.requests.at(-1)!.messages);
    expect(sent.some((r) => r.content === CLEARED_NOTE)).toBe(true);
    expect(sent.slice(-2).every((r) => r.content !== CLEARED_NOTE)).toBe(true);
    expect(results(agent.messages).every((r) => r.content !== CLEARED_NOTE)).toBe(true);
  });
});

describe("escalón 3: compactar", () => {
  it("al pasar de compactAt sustituye la conversación por el resumen y la tarea sigue", async () => {
    const files = { "a.txt": bigFile(3_000), "b.txt": bigFile(3_000), "c.txt": bigFile(3_000) };
    const script: Script = (req) => {
      if (isSummaryRequest(req)) return { content: [text("<summary>Leídos a, b y c.</summary>")] };
      const reads = results(req.messages).length;
      if (JSON.stringify(req.messages).includes("conversation_summary") || reads >= 3) return { content: [text("hecho")] };
      return { content: [use(`r${reads}`, "Read", { file_path: `${"abc"[reads]}.txt` })] };
    };
    const { agent, events } = await setup(script, { files, config: { context: { maxToolResultTokens: 25_000, clearAt: 0.99, compactAt: 0.5, keepToolResults: 6 } } });
    await agent.run("lee a, b y c");
    expect(events.some((e) => e.t === "context" && e.action === "compacted")).toBe(true);
    expect(JSON.stringify(agent.messages[0])).toContain("Leídos a, b y c.");
    expect(agent.messages).toHaveLength(2);
  });

  it("extractSummary toma lo de dentro de <summary>", () => {
    expect(extractSummary("antes <summary> el resumen </summary> después")).toBe("el resumen");
  });

  it("extractSummary no acepta una etiqueta <summary> sin cerrar", () => {
    expect(extractSummary("<summary>1. Objetivo: arreglar")).toBe("");
  });

  it("compact() deja la historia intacta si el resumen acaba por max_tokens", async () => {
    const s = await setup(
      (req, turn) => {
        if (isSummaryRequest(req)) return { content: [text("<summary>1. Objetivo: arre")], stopReason: "max_tokens" };
        return turn === 1 ? { content: [use("t1", "Read", { file_path: "a.txt" })] } : { content: [text("hecho")] };
      },
      { files: { "a.txt": bigFile(100) } },
    );
    await s.agent.run("lee a");
    const before = JSON.stringify(s.agent.messages);
    await expect(s.agent.compact()).rejects.toThrow(/not completed.*max_tokens/);
    expect(JSON.stringify(s.agent.messages)).toBe(before);
  });
});

describe("reserva de respuesta proporcional a la ventana", () => {
  it.each([
    [4_096, 1_024],
    [16_000, 4_000],
    [32_768, 8_192],
  ])("con ventana %i reserva %i y la envía como max_tokens", async (contextWindow, expected) => {
    const { agent, provider } = await setup(() => ({ content: [text("ok")] }), { config: { contextWindow, maxTokens: 16_000 } });
    await agent.run("hola");
    expect(agent.reserve).toBe(expected);
    expect(provider.requests[0]!.maxTokens).toBe(expected);
  });

  it("con una ventana grande sigue valiendo maxTokens", async () => {
    const { agent } = await setup(() => ({ content: [text("ok")] }), { config: { contextWindow: 200_000, maxTokens: 4_096 } });
    expect(agent.reserve).toBe(4_096);
  });
});

describe("ventana por defecto del adaptador", () => {
  it("sin configuración asume 4.096 y la configurada gana", () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(4_096);
    expect(new OpenAIProvider({ baseURL: "http://localhost:11434/v1" }).capabilities.contextWindow).toBe(4_096);
    expect(new OpenAIProvider({ baseURL: "http://localhost:11434/v1", contextWindow: 32_768 }).capabilities.contextWindow).toBe(32_768);
  });
});

describe("final: context_overflow", () => {
  /** El agente cree tener 100k (mal configurada) y el servidor simulado recorta a 4.096 (más `base`); la petición base ronda 500 tokens. */
  async function overflow(fileTokens: number, reads: number, mode: "collapse" | "plateau", base = 0) {
    const files = Object.fromEntries(Array.from({ length: reads }, (_, i) => [`f${i}.txt`, bigFile(fileTokens)]));
    const s = await setup(
      (_r, turn) => (turn <= reads ? { content: [use(`t${turn}`, "Read", { file_path: `f${turn - 1}.txt` })] } : { content: [text("hecho")] }),
      { files, config: { contextWindow: 100_000, maxTokens: 4_096 }, truncate: { window: 4_096 + base, mode } },
    );
    return { ...s, result: await s.agent.run("lee los ficheros y resume") };
  }

  it("termina en context_overflow, con el cómo arreglarlo, y la historia sigue completa", async () => {
    const { agent, result, events } = await overflow(2_500, 3, "collapse");
    expect(result.reason).toBe("context_overflow");
    expect(result.error).toContain("--context-window");
    expect(events.at(-1)).toMatchObject({ t: "run_end", reason: "context_overflow" });
    expect(JSON.stringify(agent.messages)).toContain("lee los ficheros");
    expect(agent.messages.at(-1)!.role).toBe("user");
    expect(JSON.stringify(agent.messages.at(-1))).toContain("tool_result");
  });

  it("también cuando el servidor se queda cerca de la ventana en vez de colapsar", async () => {
    expect((await overflow(1_000, 6, "plateau")).result.reason).toBe("context_overflow");
  });

  it("un run sin recorte no lo dispara", async () => {
    const { result, events } = await overflow(300, 3, "collapse");
    expect(result.reason).toBe("end_turn");
    expect(events.some((e) => e.t === "turn_end" && e.truncated)).toBe(false);
  });

  it("un turno recortado no recalibra contextTokens()", async () => {
    const { agent, events } = await overflow(2_500, 3, "collapse");
    const turns = events.filter((e): e is Extract<AgentEvent, { t: "turn_end" }> => e.t === "turn_end");
    expect(turns.at(-1)!.truncated).toBe(true);
    expect(turns.at(-1)!.usage.inputTokens).toBeLessThan(100);
    expect(agent.contextTokens()).toBeGreaterThan(turns.at(-2)!.usage.inputTokens);
  });

  it("compact() falla y la historia queda intacta si el servidor recorta su petición", async () => {
    const dir = ["a.txt", "b.txt"];
    const s = await setup(
      (req, turn) => {
        if (isSummaryRequest(req)) return { content: [text("<summary>Leídos a y b.</summary>")] };
        return turn <= 2 ? { content: [use(`t${turn}`, "Read", { file_path: dir[turn - 1]! })] } : { content: [text("hecho")] };
      },
      { files: { "a.txt": bigFile(1_000), "b.txt": bigFile(1_000) }, config: { contextWindow: 100_000 }, truncate: { window: 4_000 } },
    );
    expect((await s.agent.run("lee a y b")).reason).toBe("end_turn");
    const before = JSON.stringify(s.agent.messages);
    const lastNormal = estimateRequest(s.provider.requests.at(-1)!);
    await expect(s.agent.compact()).rejects.toThrow(/truncated the compaction request/);
    expect(lastNormal).toBeLessThanOrEqual(4_000);
    expect(estimateRequest(s.provider.requests.at(-1)!)).toBeGreaterThan(4_000);
    expect(JSON.stringify(s.agent.messages)).toBe(before);
  });
});

describe("looksTruncated", () => {
  const prev = { tokens: 3_000, estimate: 2_600 };

  it("no decide sin uso informado ni con una conversación que crece con normalidad (1,0 a 1,5 y 0,22)", () => {
    expect(looksTruncated(prev, { tokens: 0, estimate: 5_000 })).toBe(false);
    for (const k of [0.22, 1.0, 1.2, 1.5]) expect(looksTruncated(prev, { tokens: 3_000 + 600 * k, estimate: 3_200 })).toBe(false);
  });

  it("se marca cuando el uso no crece aunque la conversación sí", () => {
    for (const tokens of [2_964, 3_016, 63]) expect(looksTruncated(prev, { tokens, estimate: 3_200 })).toBe(true);
  });

  it("con poco crecimiento solo decide la compaction, que usa un mínimo menor", () => {
    expect(looksTruncated(prev, { tokens: 63, estimate: 2_700 })).toBe(false);
    expect(looksTruncated(prev, { tokens: 63, estimate: 2_700 }, OVERFLOW_MIN_GROWTH_COMPACT)).toBe(true);
  });

  it("sin petición previa usa la proporción con la estimación", () => {
    expect(looksTruncated(null, { tokens: 63, estimate: 4_000 })).toBe(true);
    expect(looksTruncated(null, { tokens: 590, estimate: 400 })).toBe(false);
  });
});

describe("instrucciones del proyecto (AGENTS.md)", () => {
  const script: Script = (req) => {
    if (isSummaryRequest(req)) return { content: [text("<summary>Leídos a, b y c.</summary>")] };
    const reads = results(req.messages).length;
    if (JSON.stringify(req.messages).includes("conversation_summary") || reads >= 3) return { content: [text("hecho")] };
    return { content: [use(`r${reads}`, "Read", { file_path: `${"abc"[reads]}.txt` })] };
  };
  const files = { "a.txt": bigFile(3_000), "b.txt": bigFile(3_000), "c.txt": bigFile(3_000) };
  const policy = { context: { maxToolResultTokens: 25_000, clearAt: 0.99, compactAt: 0.5, keepToolResults: 6 } };

  it("su contenido sigue en la petición tras compactar", async () => {
    const { agent, provider, events } = await setup(script, { files: { ...files, "AGENTS.md": "Responde siempre en español.\n" }, config: policy });
    await agent.run("lee a, b y c");
    expect(events.some((e) => e.t === "context" && e.action === "compacted")).toBe(true);
    const system = (r: { system: { text: string }[] }) => r.system.map((p) => p.text).join("\n");
    expect(system(provider.requests[0]!)).toContain("Responde siempre en español.");
    expect(system(provider.requests.at(-1)!)).toContain("Responde siempre en español.");
    // Está en el system prompt, no en la conversación: la compaction no lo ha resumido ni borrado.
    expect(JSON.stringify(agent.messages)).not.toContain("Responde siempre en español.");
  });

  it("el run funciona sin el fichero, y con uno vacío", async () => {
    for (const extra of [{} as Record<string, string>, { "AGENTS.md": "  \n" }]) {
      const { agent, provider } = await setup(script, { files: { ...files, ...extra }, config: policy });
      expect((await agent.run("lee a, b y c")).reason).toBe("end_turn");
      expect(provider.requests[0]!.system.map((p) => p.text).join("\n")).not.toContain("Project instructions");
    }
  });
});
