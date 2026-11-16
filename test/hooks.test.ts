import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HookRunner, matchesTool } from "../src/hooks/runner.js";
import { type Harness, type HarnessOptions, createHarness } from "../src/index.js";
import type { ToolResultBlock } from "../src/providers/canonical.js";
import { type Sandbox, type SandboxSpec, bwrapSandbox, noSandbox } from "../src/policy/sandbox/index.js";
import { type HookConfig, loadSettings } from "../src/policy/settings.js";
import { FakeProvider, text, use } from "./fake-provider.js";

let harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses) h.dispose();
  harnesses = [];
});

const dir = (files: Record<string, string> = {}): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "lab-hooks-"));
  for (const [f, c] of Object.entries(files)) writeFileSync(path.join(d, f), c);
  return d;
};

const runnerFor = (config: HookConfig, cwd = dir(), sandbox: Sandbox = noSandbox) =>
  new HookRunner(config, { cwd, writablePaths: [cwd], hiddenPaths: [], network: "none", sandbox });

const signal = () => new AbortController().signal;

describe("matcher", () => {
  it("sin matcher o con * casa con todas las tools", () => {
    expect(matchesTool(undefined, "Bash")).toBe(true);
    expect(matchesTool("*", "Bash")).toBe(true);
  });

  it("nombres exactos separados por | y comodín *", () => {
    expect(matchesTool("Edit|Write", "Write")).toBe(true);
    expect(matchesTool("Edit|Write", "Bash")).toBe(false);
    expect(matchesTool("Bash", "BashX")).toBe(false);
    expect(matchesTool("mcp__github__*", "mcp__github__issue_read")).toBe(true);
    expect(matchesTool("mcp__github__*", "mcp__otro__issue_read")).toBe(false);
  });
});

describe("HookRunner", () => {
  it("PreToolUse con código 2 bloquea y el motivo es el stderr", async () => {
    const r = runnerFor({ PreToolUse: [{ command: "echo 'no' >&2; exit 2" }] });
    const out = await r.run("PreToolUse", { tool: "Bash", input: {} }, signal());
    expect(out.block).toBe(true);
    expect(out.message).toContain("no");
  });

  it("código 0 no bloquea y el stdin trae el evento, la tool y el input", async () => {
    const cwd = dir();
    const r = runnerFor({ PreToolUse: [{ command: `cat > ${path.join(cwd, "in.json")}` }] }, cwd);
    const out = await r.run("PreToolUse", { tool: "Edit", input: { file_path: "a.ts" } }, signal());
    expect(out.block).toBe(false);
    expect(JSON.parse(readFileSync(path.join(cwd, "in.json"), "utf8"))).toEqual({ event: "PreToolUse", tool: "Edit", input: { file_path: "a.ts" } });
  });

  it("solo ejecuta los hooks cuyo matcher casa", async () => {
    const cwd = dir();
    const r = runnerFor({ PreToolUse: [{ matcher: "Bash", command: `touch ${path.join(cwd, "bash-ran")}` }] }, cwd);
    await r.run("PreToolUse", { tool: "Read", input: {} }, signal());
    expect(() => readFileSync(path.join(cwd, "bash-ran"))).toThrow();
  });

  it("un fallo distinto de 2 no bloquea, avisa", async () => {
    const r = runnerFor({ PreToolUse: [{ command: "exit 1" }] });
    const out = await r.run("PreToolUse", { tool: "Bash", input: {} }, signal());
    expect(out.block).toBe(false);
    expect(out.notes.join("\n")).toMatch(/failed \(exit 1\)/);
  });

  it("un timeout no bloquea, avisa y mata el proceso", async () => {
    const r = runnerFor({ PreToolUse: [{ command: "sleep 5", timeoutMs: 200 }] });
    const t0 = Date.now();
    const out = await r.run("PreToolUse", { tool: "Bash", input: {} }, signal());
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(out.block).toBe(false);
    expect(out.notes.join("\n")).toMatch(/timed out/);
  });

  it("en PostToolUse el código 2 no bloquea, y el stderr queda como aviso", async () => {
    const r = runnerFor({ PostToolUse: [{ command: "echo 'lint falla' >&2; exit 2" }] });
    const out = await r.run("PostToolUse", { tool: "Edit", input: {}, result: { content: "ok", isError: false } }, signal());
    expect(out.block).toBe(false);
    expect(out.notes.join("\n")).toContain("lint falla");
  });

  it("stdout JSON con message en código 0 se añade como aviso", async () => {
    const r = runnerFor({ PostToolUse: [{ command: `echo '{"message":"formateado"}'` }] });
    const out = await r.run("PostToolUse", { tool: "Write", input: {}, result: { content: "ok", isError: false } }, signal());
    expect(out.notes).toEqual(["formateado"]);
  });

  it("expone la ruta del fichero en HARNESS_FILE_PATH", async () => {
    const cwd = dir();
    const r = runnerFor({ PostToolUse: [{ command: `printf %s "$HARNESS_FILE_PATH" > env.txt` }] }, cwd);
    await r.run("PostToolUse", { tool: "Edit", input: { file_path: "src/a.ts" }, result: { content: "", isError: false } }, signal());
    expect(readFileSync(path.join(cwd, "env.txt"), "utf8")).toBe("src/a.ts");
  });

  it("no le pasa las variables con credenciales (el mismo filtro que Bash)", async () => {
    const cwd = dir();
    process.env.LAB_FAKE_TOKEN = "valor-falso";
    try {
      const r = runnerFor({ PreToolUse: [{ command: `printf '[%s]' "$LAB_FAKE_TOKEN" > env.txt` }] }, cwd);
      await r.run("PreToolUse", { tool: "Bash", input: {} }, signal());
      expect(readFileSync(path.join(cwd, "env.txt"), "utf8")).toBe("[]");
    } finally {
      delete process.env.LAB_FAKE_TOKEN;
    }
  });

  it("el comando se envuelve con el sandbox, con el workspace como única ruta de escritura", async () => {
    const cwd = dir();
    const specs: SandboxSpec[] = [];
    const recording: Sandbox = {
      name: "bwrap",
      wrap: (argv, spec) => {
        specs.push(spec);
        // Para no depender de bwrap en el test: se ejecuta tal cual, pero se comprueba el argv que se habría lanzado.
        expect(bwrapSandbox.wrap(argv, spec)).toEqual(expect.arrayContaining(["bwrap", "--ro-bind", "/", "/", "--bind", cwd, cwd, "--unshare-net", "sh", "-c", "exit 0"]));
        return argv;
      },
    };
    await runnerFor({ PreToolUse: [{ command: "exit 0" }] }, cwd, recording).run("PreToolUse", { tool: "Bash", input: {} }, signal());
    expect(specs).toEqual([{ cwd, writablePaths: [cwd], hiddenPaths: [], network: "none" }]);
  });
});

const toolResults = (req: FakeProvider["requests"][number]): ToolResultBlock[] =>
  req.messages.at(-1)!.content.filter((b): b is ToolResultBlock => b.type === "tool_result");

async function harnessWith(hooks: HookConfig, call = use("t1", "Read", { file_path: "a.txt" }), o: Partial<HarnessOptions> = {}) {
  const provider = new FakeProvider((_req, turn) => (turn === 1 ? { content: [call] } : { content: [text("listo")] }));
  const h = await createHarness({ workspace: dir({ "a.txt": "contenido" }), sandbox: "none", provider, hooks, ...o });
  harnesses.push(h);
  return { h, provider };
}

describe("hooks en el loop", () => {
  it("PreToolUse que bloquea: la tool no se ejecuta y el modelo recibe el motivo", async () => {
    const { h, provider } = await harnessWith({ PreToolUse: [{ matcher: "Read", command: "echo 'fuera de horario' >&2; exit 2" }] });
    await h.agent.run("lee a.txt");
    const res = toolResults(provider.requests.at(-1)!)[0]!;
    expect(res.is_error).toBe(true);
    expect(String(res.content)).toContain("fuera de horario");
    expect(String(res.content)).not.toContain("contenido");
  });

  it("un bloqueo se emite como evento hook_blocked (la CLI lo enseña), sin tool_start", async () => {
    const { h } = await harnessWith({ PreToolUse: [{ matcher: "Read", command: "echo 'no' >&2; exit 2" }] });
    const events: string[] = [];
    h.bus.on((e) => {
      if (e.t === "hook_blocked") events.push(`${e.t}:${e.call.name}:${e.message}`);
      if (e.t === "tool_start") events.push(e.t);
    });
    await h.agent.run("lee a.txt");
    expect(events).toEqual([expect.stringMatching(/^hook_blocked:Read:Blocked by PreToolUse hook .*no/)]);
  });

  it("PreToolUse corre antes de los permisos: un bloqueo no llega a preguntar al usuario", async () => {
    let asked = 0;
    const { h, provider } = await harnessWith(
      { PreToolUse: [{ matcher: "Write", command: "echo 'no se escribe aquí' >&2; exit 2" }] },
      use("t1", "Write", { file_path: "b.txt", content: "x" }),
      { approver: async () => (asked++, { kind: "allow_once" }) },
    );
    await h.agent.run("escribe b.txt");
    expect(asked).toBe(0);
    expect(String(toolResults(provider.requests.at(-1)!)[0]!.content)).toContain("no se escribe aquí");
  });

  it("si se cancela mientras corre el PreToolUse, la tool no se ejecuta aunque esté permitida", async () => {
    const ctl = new AbortController();
    const provider = new FakeProvider((_req, turn) => (turn === 1 ? { content: [use("w1", "Write", { file_path: "b.txt", content: "x" })] } : { content: [text("listo")] }));
    const ws = dir();
    const h = await createHarness({ workspace: ws, sandbox: "none", provider, permissionMode: "acceptEdits", hooks: { PreToolUse: [{ matcher: "Write", command: "sleep 5" }] } });
    harnesses.push(h);
    setTimeout(() => ctl.abort(), 300);
    await h.agent.run("escribe b.txt", ctl.signal);
    expect(existsSync(path.join(ws, "b.txt"))).toBe(false);
    const res = h.agent.messages.flatMap((m) => m.content).find((b) => b.type === "tool_result");
    expect(res).toMatchObject({ is_error: true, content: expect.stringMatching(/Interrupted/) });
  });

  it("PostToolUse añade su aviso al tool_result que ve el modelo", async () => {
    const { h, provider } = await harnessWith({ PostToolUse: [{ command: `echo '{"message":"revisa el fichero"}'` }] });
    await h.agent.run("lee a.txt");
    const res = toolResults(provider.requests.at(-1)!)[0]!;
    expect(String(res.content)).toContain("contenido");
    expect(String(res.content)).toContain("revisa el fichero");
  });
});

describe("hooks desde settings", () => {
  it("lee el bloque hooks de .harness/settings.json", () => {
    const ws = dir();
    mkdirSync(path.join(ws, ".harness"));
    writeFileSync(path.join(ws, ".harness", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", command: "node check.mjs" }] } }));
    expect(loadSettings(ws).hooks).toEqual({ PreToolUse: [{ matcher: "Bash", command: "node check.mjs" }] });
  });

  it("un hook mal formado invalida los settings con un error claro", () => {
    const ws = dir();
    mkdirSync(path.join(ws, ".harness"));
    writeFileSync(path.join(ws, ".harness", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash" }] } }));
    expect(() => loadSettings(ws)).toThrow(/Invalid settings/);
  });
});
