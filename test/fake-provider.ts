import type { Block, CanonicalRequest, Message, Provider, ProviderEvent, StopReason } from "../src/providers/canonical.js";

export type Script = (req: CanonicalRequest, turn: number) => { content: Block[]; stopReason?: StopReason };

/**
 * Proveedor determinista para tests: cada turno devuelve lo que diga el guion.
 * Cumple el mismo contrato que el adaptador real, así que el loop no sabe que no habla con un modelo.
 */
export class FakeProvider implements Provider {
  readonly id = "fake";
  readonly capabilities = { cache: false, parallelTools: true, contextWindow: 100_000 };
  readonly requests: CanonicalRequest[] = [];
  private turn = 0;

  constructor(private script: Script) {}

  async *stream(req: CanonicalRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
    // Copia profunda: el loop muta `messages` después.
    this.requests.push(structuredClone(req));
    const { content, stopReason } = this.script(req, ++this.turn);
    for (const b of content) if (b.type === "text") yield { t: "text_delta", text: b.text };
    const message: Message = { role: "assistant", content };
    const hasTools = content.some((b) => b.type === "tool_use");
    yield {
      t: "message_end",
      message,
      stopReason: stopReason ?? (hasTools ? "tool_use" : "end_turn"),
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
}

export const text = (t: string): Block => ({ type: "text", text: t });
export const use = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
