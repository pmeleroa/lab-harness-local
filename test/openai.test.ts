import { describe, expect, it } from "vitest";
import { ChunkAccumulator, OpenAIProvider } from "../src/providers/openai.js";
import type { ProviderEvent } from "../src/providers/canonical.js";

function run(chunks: object[]): ProviderEvent[] {
  const acc = new ChunkAccumulator();
  const events: ProviderEvent[] = [];
  for (const c of chunks) events.push(...acc.push(c));
  events.push(acc.end());
  return events;
}

const end = (events: ProviderEvent[]) => {
  const e = events.at(-1);
  if (e?.t !== "message_end") throw new Error("falta message_end");
  return e;
};

describe("ChunkAccumulator", () => {
  it("llamada completa en un solo chunk, sin id ni index (Ollama)", () => {
    const events = run([
      { choices: [{ delta: { tool_calls: [{ function: { name: "Read", arguments: '{"path":"a.txt"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    const e = end(events);
    const call = e.message.content.find((b) => b.type === "tool_use");
    expect(call).toMatchObject({ type: "tool_use", name: "Read", input: { path: "a.txt" } });
    // Se inventa un id estable para poder emparejar el resultado.
    expect(call && call.type === "tool_use" && call.id).toMatch(/^call_0_/);
    expect(events.filter((x) => x.t === "tool_use_start")).toHaveLength(1);
  });

  it("llamada troceada en varios chunks con index e id", () => {
    const events = run([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "Glob", arguments: "" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"pattern":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"*.md"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const e = end(events);
    expect(e.message.content).toEqual([{ type: "tool_use", id: "c1", name: "Glob", input: { pattern: "*.md" } }]);
    expect(e.stopReason).toBe("tool_use");
  });

  it("finish_reason stop con llamadas se trata como tool_use", () => {
    const e = end(
      run([
        { choices: [{ delta: { content: "voy a leer" } }] },
        { choices: [{ delta: { tool_calls: [{ id: "x", function: { name: "Read", arguments: "{}" } }] }, finish_reason: "stop" }] },
      ]),
    );
    expect(e.stopReason).toBe("tool_use");
  });

  it("finish_reason stop sin llamadas es end_turn y length es max_tokens", () => {
    expect(end(run([{ choices: [{ delta: { content: "hola" }, finish_reason: "stop" }] }])).stopReason).toBe("end_turn");
    expect(end(run([{ choices: [{ delta: { content: "ho" }, finish_reason: "length" }] }])).stopReason).toBe("max_tokens");
  });

  it("dos llamadas con el mismo index pero distinto id son llamadas distintas", () => {
    const e = end(
      run([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "Read", arguments: "{}" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "b", function: { name: "Glob", arguments: "{}" } }] } }] },
      ]),
    );
    expect(e.message.content.map((b) => b.type === "tool_use" && b.id)).toEqual(["a", "b"]);
  });
});

describe("OpenAIProvider.stream", () => {
  it("lee SSE y termina con exactamente un message_end", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"ho"}}]}',
      'data: {"choices":[{"delta":{"content":"la"},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    let sent: any;
    const provider = new OpenAIProvider({
      baseURL: "http://localhost:11434/v1",
      fetch: (async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return new Response(sse, { status: 200 });
      }) as unknown as typeof fetch,
    });
    const events: ProviderEvent[] = [];
    for await (const e of provider.stream(
      { model: "m", system: [{ text: "s" }], tools: [], messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], maxTokens: 10 },
      new AbortController().signal,
    ))
      events.push(e);
    expect(sent.stream).toBe(true);
    expect(sent.messages[0]).toEqual({ role: "system", content: "s" });
    expect(events.filter((e) => e.t === "message_end")).toHaveLength(1);
    expect(events.filter((e) => e.t === "text_delta").map((e) => (e as { text: string }).text).join("")).toBe("hola");
    const last = end(events);
    expect(last.usage).toMatchObject({ inputTokens: 5, outputTokens: 2 });
  });
});
