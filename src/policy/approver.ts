import readline from "node:readline/promises";
import type { ApprovalAnswer, ApprovalRequest, Approver } from "../core/loop.js";

/** `y` = una vez, `a` = siempre (regla de sesión), `n` = no; cualquier otro texto es un «no» con el motivo. */
export function parseAnswer(raw: string, suggestedRule: string | null): ApprovalAnswer {
  const ans = raw.trim();
  if (/^(y|s|si|sí|yes)$/i.test(ans)) return { kind: "allow_once" };
  if (suggestedRule && /^a$/i.test(ans)) return { kind: "allow_always", rule: suggestedRule };
  return { kind: "deny", ...(ans && !/^n(o)?$/i.test(ans) ? { feedback: ans } : {}) };
}

/** Approver de línea: pregunta por stderr y lee de stdin. El texto libre vuelve al modelo como motivo del «no». */
export function ttyApprover(rl: readline.Interface): Approver {
  return async ({ call, reason, suggestedRule }: ApprovalRequest) => {
    const input = (call.input ?? {}) as { file_path?: string; path?: string; command?: string };
    const target = input.command ?? input.file_path ?? input.path ?? "";
    process.stderr.write(`\n? ${call.name} ${target}\n  ${reason}\n`);
    const always = suggestedRule ? ` / [a] siempre: ${suggestedRule}` : "";
    const ans = await rl.question(`  [y] sí${always} / [n] no (o escribe por qué): `);
    return parseAnswer(ans, suggestedRule);
  };
}
