import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadSettings } from "../src/policy/settings.js";
import { type Sandbox, bwrapSandbox, defaultHiddenPaths, detectSandbox, seatbeltSandbox } from "../src/policy/sandbox/index.js";
import { BashSession } from "../src/tools/bash.js";

const tmp = (prefix: string) => realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
const WS = "/work/repo";

describe("bwrap: los argumentos", () => {
  const spec = { cwd: WS, writablePaths: [WS, "/tmp/state"], hiddenPaths: [], network: "none" as const };

  it("raíz de solo lectura, escritura solo en los binds, sin red y en otra sesión", () => {
    const argv = bwrapSandbox.wrap(["bash", "-c", "ls"], spec);
    expect(argv.slice(0, 5)).toEqual(["bwrap", "--ro-bind", "/", "/", "--dev"]);
    expect(argv.join(" ")).toContain("--tmpfs /tmp");
    expect(argv.join(" ")).toContain(`--bind ${WS} ${WS}`);
    expect(argv.join(" ")).toContain("--bind /tmp/state /tmp/state");
    for (const flag of ["--unshare-pid", "--unshare-ipc", "--die-with-parent", "--new-session", "--unshare-net"]) expect(argv).toContain(flag);
    expect(argv.slice(-6)).toEqual(["--chdir", WS, "--", "bash", "-c", "ls"]);
  });

  it("con red del usuario no se añade --unshare-net", () => {
    expect(bwrapSandbox.wrap(["true"], { ...spec, network: "host" })).not.toContain("--unshare-net");
  });

  it("un directorio oculto se tapa con un tmpfs vacío y un fichero con /dev/null; lo que no existe se ignora", () => {
    const home = tmp("lab-home-");
    mkdirSync(path.join(home, ".ssh"));
    writeFileSync(path.join(home, ".npmrc"), "//registry/:_authToken=falso");
    const argv = bwrapSandbox.wrap(["true"], {
      ...spec,
      hiddenPaths: [path.join(home, ".ssh"), path.join(home, ".npmrc"), path.join(home, ".aws")],
    }).join(" ");
    expect(argv).toContain(`--tmpfs ${home}/.ssh`);
    expect(argv).toContain(`--ro-bind /dev/null ${home}/.npmrc`);
    expect(argv).not.toContain(".aws");
    // Los binds de escritura van después: un workspace bajo /tmp sigue visible.
    expect(argv.indexOf("--tmpfs /tmp")).toBeLessThan(argv.indexOf(`--bind ${WS}`));
  });
});

describe("seatbelt: el perfil", () => {
  const spec = { cwd: WS, writablePaths: [WS], hiddenPaths: ["/home/u/.ssh"], network: "none" as const };

  it("rutas como parámetros, nunca interpoladas en el perfil", () => {
    const evil = '/tmp/x") (allow file-write* (subpath "/';
    const argv = seatbeltSandbox.wrap(["ls"], { ...spec, writablePaths: [evil] });
    const profile = argv[2]!;
    expect(profile).not.toContain(evil);
    expect(profile).toContain('(subpath (param "W0"))');
    expect(argv).toContain(`W0=${evil}`);
  });

  it("deniega escribir salvo en lo permitido, leer lo oculto y la red", () => {
    const profile = seatbeltSandbox.wrap(["ls"], spec)[2]!;
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain('(deny file-read* (subpath (param "H0")))');
    expect(profile).toContain("(deny network*)");
  });
});

describe("detectSandbox: comprobar que funciona y avisar si no", () => {
  const savedPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = savedPath;
  });

  it("`none` es una elección explícita y siempre avisa", () => {
    const r = detectSandbox("none");
    expect(r.sandbox.name).toBe("none");
    expect(r.warning).toMatch(/full user permissions/);
  });

  it("pedir bwrap sin bwrap instalado es un error, no un aviso", () => {
    process.env.PATH = tmp("lab-empty-path-");
    expect(() => detectSandbox("bwrap")).toThrow(/bwrap is not installed/);
  });

  it.runIf(process.platform === "linux")("en Linux, `auto` sin bwrap cae a `none` con aviso", () => {
    process.env.PATH = tmp("lab-empty-path-");
    const r = detectSandbox("auto");
    expect(r.sandbox.name).toBe("none");
    expect(r.warning).toMatch(/No sandbox: bwrap is not installed/);
  });

  it.runIf(process.platform === "darwin")("en macOS, `auto` es seatbelt", () => {
    expect(detectSandbox("auto")).toEqual({ sandbox: seatbeltSandbox });
  });

  it("las credenciales habituales están en la lista de rutas ocultas", () => {
    const hidden = defaultHiddenPaths().map((p) => path.relative(os.homedir(), p));
    for (const p of [".ssh", ".aws", ".gnupg", ".kube", ".npmrc", ".netrc"]) expect(hidden).toContain(p);
  });
});

describe("settings: un repositorio no puede desactivar el sandbox ni abrir la red", () => {
  const ws = (json: unknown) => {
    const dir = tmp("lab-settings-");
    mkdirSync(path.join(dir, ".harness"));
    writeFileSync(path.join(dir, ".harness", "settings.json"), JSON.stringify(json));
    return dir;
  };

  it("sandbox.mode none se ignora con aviso", () => {
    const s = loadSettings(ws({ sandbox: { mode: "none" } }));
    expect(s.sandbox.mode).toBeUndefined();
    expect(s.warnings[0]).toMatch(/Ignored sandbox.mode "none" .*use --sandbox none/);
  });

  it("puede elegir un sandbox concreto y cortar la red, pero no abrirla", () => {
    expect(loadSettings(ws({ sandbox: { mode: "bwrap", network: "none" } })).sandbox).toEqual({ mode: "bwrap", network: "none" });
    expect(loadSettings(ws({ sandbox: { network: "host" } })).sandbox).toEqual({});
  });
});

/**
 * Lo que pasa de verdad dentro del sandbox: solo donde existe. Bajo el home y no en el temporal: en Linux `/tmp` es un
 * tmpfs vacío dentro de bwrap (escribir ahí no demostraría nada) y en macOS el perfil deja escribir en
 * `/private/var/folders`, que es donde está el temporal.
 */
function contained(name: string, sandbox: Sandbox, available: boolean) {
  describe.runIf(available)(`${name}: dentro del sandbox`, () => {
    const base = path.join(os.homedir(), `.lab-harness-test-${name}-${process.pid}`);
    const workspace = path.join(base, "ws");
    const outside = path.join(base, "fuera");
    const secret = path.join(base, "credenciales");
    let sh: BashSession;
    // Dentro de beforeAll: el cuerpo de un describe saltado también se ejecuta al recolectar los tests.
    beforeAll(() => {
      mkdirSync(workspace, { recursive: true });
      mkdirSync(outside);
      mkdirSync(secret);
      writeFileSync(path.join(secret, "id_falsa"), "CLAVE-FALSA");
      sh = new BashSession({ workspace, sandbox, hiddenPaths: [secret], network: "none" });
    });
    afterAll(() => {
      sh?.dispose();
      rmSync(base, { recursive: true, force: true });
    });

    it("escribir en el workspace funciona", async () => {
      const r = await sh.exec("echo hola > dentro.txt && cat dentro.txt");
      expect(r).toMatchObject({ exitCode: 0, output: "hola" });
    });

    it("escribir fuera falla y el fichero no aparece", async () => {
      const r = await sh.exec(`echo x > ${outside}/escapado.txt`);
      expect(r.exitCode).not.toBe(0);
      expect(existsSync(path.join(outside, "escapado.txt"))).toBe(false);
    });

    it("lo oculto no se puede leer", async () => {
      const r = await sh.exec(`cat ${secret}/id_falsa`);
      expect(r.output).not.toContain("CLAVE-FALSA");
    });

    it("sin red, una conexión falla", async () => {
      const r = await sh.exec("curl -s --max-time 5 https://example.com > /dev/null");
      expect(r.exitCode).not.toBe(0);
    });

    it("fuera del sandbox, el mismo fichero sí se lee (la prueba no es trivial)", () => {
      expect(readFileSync(path.join(secret, "id_falsa"), "utf8")).toBe("CLAVE-FALSA");
    });
  });
}

const bwrapWorks = process.platform === "linux" && spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-pid", "--", "true"]).status === 0;
contained("bwrap", bwrapSandbox, bwrapWorks);
contained("seatbelt", seatbeltSandbox, process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec"));
