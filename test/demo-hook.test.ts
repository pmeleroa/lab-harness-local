import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// El hook de examples/demo: bloquea (código 2) un `git commit` cuyo mensaje no cumple la convención del proyecto.
const HOOK = fileURLToPath(new URL("../examples/demo/.harness/hooks/check-commit.mjs", import.meta.url));
const run = (tool: string, command: string) => {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ event: "PreToolUse", tool, input: { command } }), encoding: "utf8" });
  return { code: r.status, stderr: r.stderr };
};

describe("hook de la convención de commits (examples/demo)", () => {
  it.each([
    'git commit -m "fix(cart): redondea el total a céntimos (#4)"',
    "git add src/cart.ts && git commit -m 'feat: añade algo'",
    'git commit -am "fix: arregla x (#4)"',
  ])("deja pasar un mensaje válido: %s", (cmd) => {
    expect(run("Bash", cmd).code).toBe(0);
  });

  it.each([
    ['git commit -m "arreglos"', /no empieza por un tipo válido/],
    ['git commit -m "Fix: algo"', /no empieza por un tipo válido/],
    ['git commit -m "fix(cart): Redondea el total"', /minúsculas/],
    ['git commit -m "fix: redondea."', /sin punto final/],
    [`git commit -m "fix: ${"x".repeat(80)}"`, /máximo 72/],
    ["git commit", /usa git commit -m/],
  ])("bloquea con código 2 y dice por qué: %s", (cmd, why) => {
    const r = run("Bash", cmd);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(why);
    expect(r.stderr).toContain("Formato: <tipo>(<ámbito>): <descripción> (#<issue>)");
  });

  it("no mira otros comandos ni otras tools", () => {
    expect(run("Bash", "git status").code).toBe(0);
    expect(run("Read", 'git commit -m "x"').code).toBe(0);
  });
});
