import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { BackgroundTasks } from "../src/core/background.js";
import { type Harness, type HarnessOptions, createHarness } from "../src/index.js";
import type { CanonicalRequest, ToolResultBlock } from "../src/providers/canonical.js";
import { BackgroundShells, BashSession, createBashOutputTool, createBashTool, createKillShellTool } from "../src/tools/bash.js";
import { FileStateCache } from "../src/tools/file-state.js";
import type { ToolCtx } from "../src/tools/types.js";
import { FakeProvider, type Script, text, use } from "./fake-provider.js";

const tmp = (prefix: string) => realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Espera a que se cumpla la condición (los procesos tardan un poco en arrancar o en morir). */
async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("timeout waiting for condition");
    await sleep(25);
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("BashSession", () => {
  const sh = new BashSession({ workspace: tmp("lab-bash-"), maxOutputChars: 500, defaultTimeoutMs: 1500 });
  afterAll(() => sh.dispose());

  it("persiste cwd y variables exportadas entre llamadas", async () => {
    await sh.exec("mkdir -p sub/inner && cd sub && export FOO=bar");
    const r = await sh.exec('echo "$FOO" && basename "$PWD"');
    expect(r.output).toBe("bar\nsub");
  });

  it("resetea cwd si sale del workspace", async () => {
    const r = await sh.exec("cd / && pwd");
    expect(r.output).toBe("/");
    expect(r.cwdReset).toBe(true);
    expect((await sh.exec("pwd")).output).toBe(sh.workspace);
  });

  it("devuelve el exit code", async () => {
    expect((await sh.exec("exit 3")).exitCode).toBe(3);
  });

  it("mata por timeout al grupo de procesos completo", async () => {
    const t0 = Date.now();
    const r = await sh.exec("sleep 30 & sleep 30; echo nunca");
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("trunca la salida por el medio", async () => {
    const r = await sh.exec("seq 1 5000");
    expect(r.output.length).toBeLessThan(600);
    expect(r.output).toMatch(/^1\n2\n/);
    expect(r.output).toMatch(/5000$/);
    expect(r.output).toContain("characters omitted");
  });

  it("no filtra secretos del entorno al proceso hijo", async () => {
    process.env.FAKE_API_KEY = "valor-falso";
    const r = await sh.exec('echo "[$FAKE_API_KEY]"');
    delete process.env.FAKE_API_KEY;
    expect(r.output).toBe("[]");
  });
});

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function shellSetup() {
  const session = new BashSession({ workspace: tmp("lab-bg-"), maxOutputChars: 2000 });
  const tasks = new BackgroundTasks();
  const shells = new BackgroundShells(session, tasks);
  cleanups.push(() => {
    tasks.disposeAll();
    session.dispose();
  });
  const ctx = (): ToolCtx => ({ workspace: session.workspace, signal: new AbortController().signal, fileState: new FileStateCache() });
  const bash = createBashTool(session, shells);
  const output = createBashOutputTool(shells);
  const kill = createKillShellTool(shells);
  /** Lanza en segundo plano y devuelve el id que da la tool. */
  const start = async (command: string) => {
    const r = await bash.run({ command, run_in_background: true }, ctx());
    return /shell·([0-9a-f]{8})/.exec(r.content)![1]!;
  };
  /** Lee los pids que el comando ha ido escribiendo en `pids`, uno por línea. */
  const pids = (n: number) => {
    const f = path.join(session.workspace, "pids");
    return until(() => existsSync(f) && readFileSync(f, "utf8").trim().split("\n").length >= n).then(() =>
      readFileSync(f, "utf8").trim().split("\n").map(Number),
    );
  };
  return { session, tasks, ctx, bash, output, kill, start, pids };
}

describe("Bash en segundo plano", () => {
  it("vuelve al momento; BashOutput da lo nuevo y al terminar queda la notificación", async () => {
    const { tasks, ctx, output, start } = shellSetup();
    const t0 = Date.now();
    const id = await start("sleep 0.5; echo done");
    expect(Date.now() - t0).toBeLessThan(200);

    expect((await output.run({ id }, ctx())).content).toBe("(no new output)\n[still running]");

    await until(() => tasks.pending > 0);
    const [n] = tasks.drain();
    expect(n!.task).toMatchObject({ id, kind: "shell", status: "completed", exitCode: 0 });
    expect(n!.summary).toContain("Command exited with code 0: sleep 0.5; echo done");
    expect(n!.summary).toContain("Last output:\ndone");

    expect((await output.run({ id }, ctx())).content).toBe("done\n[exited with code 0]");
    expect((await output.run({ id }, ctx())).content).toBe("(no new output)\n[exited with code 0]");
  });

  it("un exit code distinto de 0 deja la tarea como failed", async () => {
    const { tasks, start } = shellSetup();
    await start("echo fallo >&2; exit 3");
    await until(() => tasks.pending > 0);
    const [n] = tasks.drain();
    expect(n!.task).toMatchObject({ status: "failed", exitCode: 3 });
    expect(n!.summary).toContain("fallo");
  });

  it("parte del cwd y del entorno de la sesión pero no los cambia", async () => {
    const { session, tasks, ctx, bash, output, start } = shellSetup();
    await bash.run({ command: "mkdir -p sub && cd sub && export FOO=bar" }, ctx());
    const id = await start('echo "$FOO $(basename "$PWD")"; cd /tmp; export FOO=otro');
    await until(() => tasks.pending > 0);
    expect((await output.run({ id }, ctx())).content).toContain("bar sub");
    expect((await bash.run({ command: 'echo "$FOO $(basename "$PWD")"' }, ctx())).content).toBe("bar sub");
    expect(session.cwd).toBe(path.join(session.workspace, "sub"));
  });

  it("KillShell mata al comando y a sus nietos, sin notificación", async () => {
    const { tasks, ctx, kill, start, pids } = shellSetup();
    const id = await start("sleep 100 & echo $! > pids; sleep 100 & echo $! >> pids; echo $$ >> pids; wait");
    const ps = await pids(3);
    expect(ps.every(alive)).toBe(true);

    expect((await kill.run({ id }, ctx())).content).toBe(`Killed shell·${id}.`);
    await until(() => !ps.some(alive));
    expect(tasks.get(id)?.status).toBe("killed");
    expect(tasks.pending).toBe(0);
    expect((await kill.run({ id }, ctx())).content).toBe(`shell·${id} had already finished [killed].`);
  });

  it("al salir bash se mata lo que quede en su grupo", async () => {
    const { tasks, start, pids } = shellSetup();
    await start("sleep 100 & echo $! > pids");
    const [orphan] = await pids(1);
    await until(() => tasks.pending > 0);
    await until(() => !alive(orphan!));
  });

  it("BashOutput y KillShell con un id desconocido devuelven error", async () => {
    const { ctx, output, kill } = shellSetup();
    expect(await output.run({ id: "nope" }, ctx())).toMatchObject({ isError: true, content: 'No background shell with id "nope".' });
    expect((await kill.run({ id: "nope" }, ctx())).isError).toBe(true);
  });
});

describe("Bash en el bucle", () => {
  let harnesses: Harness[] = [];
  afterEach(() => {
    for (const h of harnesses) h.dispose();
    harnesses = [];
  });

  async function harness(script: Script, o: Partial<HarnessOptions> = {}) {
    const provider = new FakeProvider(script);
    const h = await createHarness({ workspace: tmp("lab-bash-ws-"), sandbox: "none", provider, ...o });
    harnesses.push(h);
    return { h, provider };
  }
  const results = (req: CanonicalRequest) => req.messages.at(-1)!.content.filter((b): b is ToolResultBlock => b.type === "tool_result");
  const once = (calls: ReturnType<typeof use>[]): Script => (_r, turn) => (turn === 1 ? { content: calls } : { content: [text("hecho")] });

  it("un comando que no es de solo lectura pregunta; sin terminal, se deniega y no se ejecuta", async () => {
    const { h, provider } = await harness(once([use("b", "Bash", { command: "touch creado.txt" })]));
    await h.agent.run("crea");
    const [res] = results(provider.requests[1]!);
    expect(res!.is_error).toBe(true);
    expect(res!.content).toContain("The user denied this action");
    expect(existsSync(path.join(h.workspace, "creado.txt"))).toBe(false);
  });

  it("un comando de solo lectura se ejecuta sin preguntar", async () => {
    const { h, provider } = await harness(once([use("b", "Bash", { command: "echo hola && pwd" })]));
    await h.agent.run("di hola");
    expect(results(provider.requests[1]!)[0]!.content).toBe(`hola\n${h.workspace}`);
  });

  it("una regla Bash(npm run *) deja pasar el comando sin preguntar", async () => {
    const asked: string[] = [];
    const { h, provider } = await harness(once([use("b", "Bash", { command: "npm run build" })]), {
      rules: { allow: ["Bash(npm run *)"] },
      approver: async (req) => {
        asked.push(req.reason);
        return { kind: "deny" };
      },
    });
    await h.agent.run("compila");
    expect(asked).toEqual([]);
    // Se ejecutó: npm responde que no hay package.json, que es lo que hay en el workspace.
    expect(results(provider.requests[1]!)[0]!.content).toMatch(/package\.json|ENOENT/);
  });

  it("el approver recibe la regla sugerida para el comando", async () => {
    const suggested: (string | null)[] = [];
    const { h } = await harness(once([use("b", "Bash", { command: "git commit -m x" })]), {
      approver: async (req) => {
        suggested.push(req.suggestedRule);
        return { kind: "deny" };
      },
    });
    await h.agent.run("commit");
    expect(suggested).toEqual(["Bash(git commit *)"]);
  });

  it("una regla deny bloquea también el modo background", async () => {
    const { h, provider } = await harness(once([use("t1", "Bash", { command: "rm -rf build", run_in_background: true })]), {
      rules: { deny: ["Bash(rm *)"] },
    });
    await h.agent.run("limpia");
    const [res] = results(provider.requests[1]!);
    expect(res!.is_error).toBe(true);
    expect(res!.content).toMatch(/denied by rule Bash\(rm \*\)/);
    expect(h.tasks.list()).toEqual([]);
  });

  it("el aviso de una tarea terminada llega al modelo antes de su siguiente llamada", async () => {
    const { h, provider } = await harness(
      (_r, turn) => {
        if (turn === 1) return { content: [use("t1", "Bash", { command: "echo listo", run_in_background: true })] };
        if (turn === 2) return { content: [use("t2", "Bash", { command: "sleep 0.5" })] };
        return { content: [text("hecho")] };
      },
      { rules: { allow: ["Bash"] } },
    );
    await h.agent.run("arranca");
    const third = JSON.stringify(provider.requests[2]!.messages.at(-1));
    expect(third).toContain("<background-notification task=\\\"shell·");
    expect(third).toContain("Last output:\\nlisto");
  });

  it("endRun mata el comando que sigue corriendo y avisa", async () => {
    const warnings: string[] = [];
    const { h } = await harness(once([use("t1", "Bash", { command: "echo $$ > pids; sleep 100", run_in_background: true, description: "servidor" })]), {
      approver: async () => ({ kind: "allow_once" }),
    });
    h.bus.on((e) => e.t === "warning" && warnings.push(e.message));
    expect((await h.agent.run("arranca")).reason).toBe("end_turn");
    const pidFile = path.join(h.workspace, "pids");
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(alive(pid)).toBe(true);

    const killed = await h.endRun();
    expect(killed).toEqual([expect.objectContaining({ kind: "shell", status: "killed", description: "servidor" })]);
    await until(() => !alive(pid));
    expect(warnings).toEqual([`Killed background shell·${killed[0]!.id} at the end of the run: servidor`]);
    expect(h.tasks.pending).toBe(0);
  });

  it("Ctrl+C sobre el run no mata los comandos en segundo plano", async () => {
    const { h } = await harness(
      (_r, turn) =>
        turn === 1
          ? { content: [use("t1", "Bash", { command: "sleep 100", run_in_background: true })] }
          : { content: [use("t2", "Bash", { command: "sleep 30" })] },
      { rules: { allow: ["Bash"] } },
    );
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    expect((await h.agent.run("x", ac.signal)).reason).toBe("aborted");
    expect(h.tasks.list({ running: true })).toHaveLength(1);
  });
});
