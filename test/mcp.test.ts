import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Harness, type HarnessOptions, createHarness } from "../src/index.js";
import { type McpServerEntry, expandVars, loadMcpConfig } from "../src/mcp/config.js";
import { McpManager } from "../src/mcp/manager.js";
import { BashParser } from "../src/policy/bash-parser.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { parseRule } from "../src/policy/rules.js";
import { type Sandbox, type SandboxSpec, bwrapSandbox, seatbeltSandbox } from "../src/policy/sandbox/index.js";
import { mcpResultText, mcpServerOf, mcpToolName } from "../src/tools/mcp.js";
import { FakeProvider, text, use } from "./fake-provider.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
const tmp = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), "lab-mcp-")));

const stdio = (name: string, env: Record<string, string> = {}, extra: Partial<McpServerEntry["config"]> = {}): McpServerEntry => ({
  name,
  file: ".mcp.json",
  config: { type: "stdio", command: process.execPath, args: [FIXTURE], env, ...extra },
});

const managers: McpManager[] = [];
const manager = (entries: McpServerEntry[], o: Partial<ConstructorParameters<typeof McpManager>[1]> = {}) => {
  const m = new McpManager(entries, { workspace: tmp(), ...o });
  managers.push(m);
  return m;
};
let harnesses: Harness[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.dispose()));
  for (const h of harnesses) h.dispose();
  harnesses = [];
});

const textOf = (r: { content: unknown }) => (r.content as { text?: string }[]).map((c) => c.text).join("");

function wsWith(mcpJson: unknown): string {
  const ws = tmp();
  writeFileSync(path.join(ws, ".mcp.json"), typeof mcpJson === "string" ? mcpJson : JSON.stringify(mcpJson));
  return ws;
}

describe("loadMcpConfig", () => {
  it("sin .mcp.json no hay servidores ni avisos", () => {
    expect(loadMcpConfig(tmp())).toEqual({ servers: [], warnings: [] });
  });

  it("lee servidores stdio y expande ${VAR} y ${VAR:-defecto} en command, args y env", () => {
    const ws = wsWith({ mcpServers: { github: { command: "${BIN:-github-mcp-server}", args: ["stdio", "--toolsets=${SETS}"], env: { T: "${TOKEN}" } } } });
    const { servers, warnings } = loadMcpConfig(ws, { TOKEN: "valor-falso", SETS: "issues" });
    expect(warnings).toEqual([]);
    expect(servers).toEqual([
      { name: "github", file: path.join(ws, ".mcp.json"), config: { type: "stdio", command: "github-mcp-server", args: ["stdio", "--toolsets=issues"], env: { T: "valor-falso" } } },
    ]);
  });

  it("una variable sin definir deja el servidor fuera, con aviso de cuál falta", () => {
    const { servers, warnings } = loadMcpConfig(wsWith({ mcpServers: { github: { command: "x", env: { T: "${GITHUB_PERSONAL_ACCESS_TOKEN}" } } } }), {});
    expect(servers).toEqual([]);
    expect(warnings[0]).toMatch(/variables sin definir: \$GITHUB_PERSONAL_ACCESS_TOKEN/);
  });

  it('un proyecto no puede sacar un servidor del sandbox: "sandbox": false se ignora con aviso', () => {
    const { servers, warnings } = loadMcpConfig(wsWith({ mcpServers: { s: { command: "x", sandbox: false } } }), {});
    expect(servers[0]!.config).toEqual({ type: "stdio", command: "x", args: [], env: {} });
    expect(warnings[0]).toMatch(/"sandbox": false: se ignora y corre dentro del sandbox \(usa --sandbox none\)/);
  });

  it("puede cortar la red de un servidor, no abrirla", () => {
    const { servers } = loadMcpConfig(wsWith({ mcpServers: { a: { command: "x", sandbox: { network: "none" } }, b: { command: "x", sandbox: { network: "host" } } } }), {});
    expect(servers.map((s) => s.config.network)).toEqual(["none", undefined]);
  });

  it("ignora con aviso HTTP, nombres inválidos y entradas mal formadas; un JSON roto no tumba el arranque", () => {
    const { servers, warnings } = loadMcpConfig(
      wsWith({ mcpServers: { remoto: { url: "https://example.org/mcp" }, sse: { type: "http", url: "https://x" }, "a__b": { command: "x" }, roto: { args: [] }, ok: { command: "x" } } }),
      {},
    );
    expect(servers.map((s) => s.name)).toEqual(["ok"]);
    expect(warnings).toHaveLength(4);
    expect(warnings.filter((w) => /solo tiene el transporte stdio/.test(w))).toHaveLength(2);
    expect(loadMcpConfig(wsWith("{ no es json"), {}).warnings[0]).toMatch(/JSON inválido/);
  });

  it("expandVars deja tal cual lo que no tiene la forma ${VAR}", () => {
    expect(expandVars("$HOME y $$", {}, new Set())).toBe("$HOME y $$");
  });
});

describe("McpManager", () => {
  it("conecta, lista y llama; cwd en el workspace y env añadido al mínimo del SDK, no al nuestro", async () => {
    process.env.LAB_MCP_SECRET = "no-deberia-llegar";
    try {
      const m = manager([stdio("fake", { FOO: "bar" })]);
      await m.connectAll();
      expect(m.servers()[0]).toMatchObject({ name: "fake", status: "connected", sandbox: "none", serverInfo: { name: "fake", version: "1.0.0" } });
      expect(m.tools().map((t) => t.name)).toEqual(["echo", "env", "cwd", "touch", "fail", "crash"]);
      expect(m.tools()[0]).toMatchObject({ server: "fake", description: "Devuelve el texto", annotations: { readOnlyHint: true } });
      expect(textOf(await m.callTool("fake", "echo", { text: "hola" }))).toBe("echo: hola");
      expect(textOf(await m.callTool("fake", "env", { name: "FOO" }))).toBe("bar");
      expect(textOf(await m.callTool("fake", "env", { name: "LAB_MCP_SECRET" }))).toBe("");
      expect(textOf(await m.callTool("fake", "env", { name: "PATH" }))).not.toBe("");
    } finally {
      delete process.env.LAB_MCP_SECRET;
    }
  });

  it("isError del servidor llega tal cual", async () => {
    const m = manager([stdio("fake")]);
    await m.connectAll();
    expect(await m.callTool("fake", "fail", {})).toMatchObject({ isError: true, content: [{ type: "text", text: "boom" }] });
  });

  it("un servidor que no arranca queda en failed con su stderr, y los demás siguen", async () => {
    const m = manager([stdio("roto", { FAKE_MCP_FAIL: "1" }), stdio("fake")]);
    await m.connectAll();
    expect(m.servers().map((s) => s.status)).toEqual(["failed", "connected"]);
    expect(m.servers()[0]!.error).toMatch(/fake: cannot start/);
  });

  it("si el proceso muere, el servidor pasa a failed y la siguiente llamada da un error claro", async () => {
    const m = manager([stdio("fake")]);
    await m.connectAll();
    await m.callTool("fake", "crash", {}).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    expect(m.servers()[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/crashing on purpose/) });
    await expect(m.callTool("fake", "echo", { text: "x" })).rejects.toThrow(/not connected/);
  });

  describe("sandbox por defecto", () => {
    const recorder = () => {
      const specs: SandboxSpec[] = [];
      const argvs: string[][] = [];
      // Graba lo que se pediría y lo ejecuta tal cual, para no depender de un sandbox real en el test.
      const sandbox: Sandbox = { name: "bwrap", wrap: (argv, spec) => (specs.push(spec), argvs.push(bwrapSandbox.wrap(argv, spec)), argv) };
      return { specs, argvs, sandbox };
    };

    it("todo servidor se lanza con el sandbox del harness: workspace y tmp escribibles, credenciales ocultas, red del harness", async () => {
      const r = recorder();
      const ws = tmp();
      const m = manager([stdio("fake")], { workspace: ws, sandbox: r.sandbox, hiddenPaths: ["/ocultas"], network: "host" });
      await m.connectAll();
      expect(m.servers()[0]).toMatchObject({ status: "connected", sandbox: "bwrap" });
      expect(r.specs).toEqual([{ cwd: ws, writablePaths: [ws, os.tmpdir()], hiddenPaths: ["/ocultas"], network: "host" }]);
      expect(r.argvs[0]).toEqual(expect.arrayContaining(["bwrap", "--ro-bind", "/", "/", "--bind", ws, ws, "--chdir", ws, "--", process.execPath, FIXTURE]));
      expect(r.argvs[0]).not.toContain("--unshare-net");
    });

    it("sin red en el harness, ningún servidor la tiene; y un servidor puede cortarse la suya", async () => {
      const a = recorder();
      await manager([stdio("fake")], { sandbox: a.sandbox, network: "none" }).connectAll();
      expect(a.specs[0]!.network).toBe("none");
      const b = recorder();
      await manager([stdio("fake", {}, { network: "none" })], { sandbox: b.sandbox, network: "host" }).connectAll();
      expect(b.specs[0]!.network).toBe("none");
      expect(b.argvs[0]).toContain("--unshare-net");
    });
  });
});

/** Lo que pasa de verdad dentro del sandbox, solo donde existe (igual que en test/sandbox.test.ts). */
function contained(name: string, sandbox: Sandbox, available: boolean) {
  describe.runIf(available)(`MCP con ${name}: dentro del sandbox`, () => {
    const base = path.join(os.homedir(), `.lab-harness-test-mcp-${name}-${process.pid}`);
    const workspace = path.join(base, "ws");
    const outside = path.join(base, "fuera");
    let m: McpManager;
    beforeAll(async () => {
      mkdirSync(workspace, { recursive: true });
      mkdirSync(outside);
      m = new McpManager([stdio("fake")], { workspace, sandbox, hiddenPaths: [], network: "none" });
      await m.connectAll();
    });
    afterAll(async () => {
      await m?.dispose();
      rmSync(base, { recursive: true, force: true });
    });

    it("escribe en el workspace, no fuera", async () => {
      expect(m.servers()[0]).toMatchObject({ status: "connected", sandbox: name });
      expect(textOf(await m.callTool("fake", "touch", { path: path.join(workspace, "dentro.txt") }))).toBe("written");
      const r = await m.callTool("fake", "touch", { path: path.join(outside, "escapado.txt") });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/EROFS|EPERM/);
      expect(existsSync(path.join(outside, "escapado.txt"))).toBe(false);
    });
  });
}
const bwrapWorks = process.platform === "linux" && spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-pid", "--", "true"]).status === 0;
contained("bwrap", bwrapSandbox, bwrapWorks);
contained("seatbelt", seatbeltSandbox, process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec"));

describe("tools MCP", () => {
  it("nombre mcp__<servidor>__<tool>, con lo que la API no admite cambiado por _ y recortado a 64", () => {
    expect(mcpToolName("github", "issue_read")).toBe("mcp__github__issue_read");
    expect(mcpToolName("s", "a.b c")).toBe("mcp__s__a_b_c");
    expect(mcpToolName("s", "x".repeat(100))).toHaveLength(64);
    expect(mcpServerOf("mcp__github__issue_read")).toBe("github");
  });

  it("el resultado se pasa a texto; lo binario se describe", () => {
    expect(mcpResultText({ content: [{ type: "text", text: "a" }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }] })).toBe("a\n[image image/png, 9 B: not shown]");
    expect(mcpResultText({ content: [], structuredContent: { n: 1 } })).toBe('{\n  "n": 1\n}');
    expect(mcpResultText({ content: [] })).toBe("(no output)");
  });
});

describe("permisos de las tools MCP", () => {
  const call = (name: string) => ({ type: "tool_use" as const, id: "1", name, input: {} });
  const target = { kind: "mcp" as const, server: "github" };
  const engine = async (rules: Partial<Record<"allow" | "ask" | "deny", string[]>>, mode: "default" | "bypass" = "default") =>
    new PolicyEngine({ workspace: "/ws", mode, rules: { allow: [], ask: [], deny: [], ...rules } }, await BashParser.create());

  it("por defecto preguntan, aunque el servidor declare readOnlyHint", async () => {
    expect((await engine({})).evaluate(call("mcp__github__issue_read"), target)).toMatchObject({ kind: "ask", reason: expect.stringMatching(/MCP server "github"/) });
  });

  it("allow por servidor, por nombre exacto o por comodín; deny gana siempre, también en bypass", async () => {
    expect((await engine({ allow: ["mcp__github"] })).evaluate(call("mcp__github__issue_read"), target).kind).toBe("allow");
    expect((await engine({ allow: ["mcp__github__issue_read"] })).evaluate(call("mcp__github__issue_read"), target).kind).toBe("allow");
    const wild = await engine({ allow: ["mcp__github__issue_*"] });
    expect(wild.evaluate(call("mcp__github__issue_read"), target).kind).toBe("allow");
    expect(wild.evaluate(call("mcp__github__create_pr"), target).kind).toBe("ask");
    expect((await engine({ allow: ["mcp__github"], deny: ["mcp__github__issue_*"] })).evaluate(call("mcp__github__issue_read"), target).kind).toBe("deny");
    expect((await engine({ deny: ["mcp__*"] }, "bypass")).evaluate(call("mcp__github__issue_read"), target).kind).toBe("deny");
  });

  it("el comodín en el nombre solo vale para tools mcp__", () => {
    expect(parseRule("mcp__github__get_*")).toMatchObject({ tool: "mcp__github__get_*" });
    expect(() => parseRule("Ba*sh")).toThrow(/Invalid permission rule/);
  });
});

describe("harness con .mcp.json", () => {
  async function harnessWith(script: ConstructorParameters<typeof FakeProvider>[0], env: Record<string, string> = {}, o: Partial<HarnessOptions> = {}) {
    const ws = wsWith({ mcpServers: { fake: { command: process.execPath, args: [FIXTURE], env } } });
    const provider = new FakeProvider(script);
    const h = await createHarness({ workspace: ws, sandbox: "none", provider, ...o });
    harnesses.push(h);
    return { h, provider };
  }

  it("las tools del servidor llegan al modelo con el schema del servidor y se llaman con permiso", async () => {
    const { h, provider } = await harnessWith(
      (_req, turn) => (turn === 1 ? { content: [use("m1", "mcp__fake__echo", { text: "hola" })] } : { content: [text("listo")] }),
      {},
      { rules: { allow: ["mcp__fake__echo"], ask: [], deny: [] } },
    );
    expect(h.mcp.servers()[0]!.status).toBe("connected");
    await h.agent.run("di hola");
    const spec = provider.requests[0]!.tools.find((t) => t.name === "mcp__fake__echo");
    expect(spec).toMatchObject({ description: "Devuelve el texto", inputSchema: { type: "object", properties: { text: { type: "string" } } } });
    const result = provider.requests[1]!.messages.at(-1)!.content.find((b) => b.type === "tool_result");
    expect(result).toMatchObject({ content: "echo: hola" });
  });

  it("la credencial llega al servidor por su env y Bash no la ve", async () => {
    process.env.LAB_FAKE_MCP_TOKEN = "valor-falso";
    try {
      const { h, provider } = await harnessWith(
        (_req, turn) =>
          turn === 1
            ? { content: [use("m1", "mcp__fake__env", { name: "T" }), use("b1", "Bash", { command: "printf '[%s]' \"$LAB_FAKE_MCP_TOKEN\"" })] }
            : { content: [text("listo")] },
        { T: "${LAB_FAKE_MCP_TOKEN}" },
        { permissionMode: "bypass" },
      );
      await h.agent.run("lee el token");
      const results = provider.requests[1]!.messages.at(-1)!.content.filter((b) => b.type === "tool_result");
      expect(results.map((r) => (r as { content: string }).content)).toEqual(["valor-falso", expect.stringContaining("[]")]);
    } finally {
      delete process.env.LAB_FAKE_MCP_TOKEN;
    }
  });

  it("mcp: false no carga .mcp.json", async () => {
    const { h, provider } = await harnessWith(() => ({ content: [text("ok")] }), {}, { mcp: false });
    await h.agent.run("hola");
    expect(h.mcp.servers()).toEqual([]);
    expect(provider.requests[0]!.tools.some((t) => t.name.startsWith("mcp__"))).toBe(false);
  });
});
