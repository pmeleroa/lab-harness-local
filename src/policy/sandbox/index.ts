import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * El sandbox es la defensa real. Las reglas de permisos son UX: deciden cuándo
 * preguntar. El sandbox decide qué puede pasar aunque una regla se equivoque.
 */
export interface SandboxSpec {
  cwd: string;
  /** Únicas rutas con escritura (workspace, tmp de la sesión...). */
  writablePaths: string[];
  /** Rutas que el proceso no debe poder leer (credenciales). */
  hiddenPaths: string[];
  network: "none" | "host";
}

export interface Sandbox {
  readonly name: "bwrap" | "seatbelt" | "none";
  wrap(argv: string[], spec: SandboxSpec): string[];
}

export const noSandbox: Sandbox = {
  name: "none",
  wrap: (argv) => argv,
};

/** Linux: bubblewrap. Sistema de ficheros read-only salvo los writablePaths. */
export const bwrapSandbox: Sandbox = {
  name: "bwrap",
  wrap(argv, spec) {
    const args = ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
    for (const p of spec.hiddenPaths.filter(existsSync)) {
      // Directorio -> tmpfs vacío; fichero -> se tapa con /dev/null.
      if (statSync(p).isDirectory()) args.push("--tmpfs", p);
      else args.push("--ro-bind", "/dev/null", p);
    }
    // Los binds van después de los tmpfs: un writable bajo /tmp sigue visible.
    for (const p of spec.writablePaths) args.push("--bind", p, p);
    args.push(
      "--unshare-pid",
      "--unshare-ipc",
      "--die-with-parent",
      "--new-session", // evita inyección en la TTY del padre (TIOCSTI)
    );
    if (spec.network === "none") args.push("--unshare-net");
    args.push("--chdir", spec.cwd, "--", ...argv);
    return args;
  },
};

/** macOS: sandbox-exec con perfil SBPL. Las rutas van como parámetros, nunca interpoladas. */
export const seatbeltSandbox: Sandbox = {
  name: "seatbelt",
  wrap(argv, spec) {
    const writable = spec.writablePaths.map((_, i) => `(subpath (param "W${i}"))`).join(" ");
    const hidden = spec.hiddenPaths.map((_, i) => `(subpath (param "H${i}"))`).join(" ");
    const profile = [
      "(version 1)",
      "(allow default)",
      "(deny file-write*)",
      `(allow file-write* ${writable} (literal "/dev/null") (regex #"^/dev/tty") (subpath "/private/var/folders"))`,
      hidden ? `(deny file-read* ${hidden})` : "",
      spec.network === "none" ? '(deny network*)\n(allow network* (remote unix-socket))' : "",
    ]
      .filter(Boolean)
      .join("\n");

    const params = [
      ...spec.writablePaths.flatMap((p, i) => ["-D", `W${i}=${p}`]),
      ...spec.hiddenPaths.flatMap((p, i) => ["-D", `H${i}=${p}`]),
    ];
    return ["sandbox-exec", "-p", profile, ...params, ...argv];
  },
};

export type SandboxChoice = "auto" | "bwrap" | "seatbelt" | "none";

export interface DetectResult {
  sandbox: Sandbox;
  warning?: string;
}

/** Elige sandbox y comprueba que funciona de verdad (p.ej. userns deshabilitados en contenedores). */
export function detectSandbox(choice: SandboxChoice = "auto"): DetectResult {
  if (choice === "none") return { sandbox: noSandbox, warning: "Sandbox disabled: commands run with your full user permissions." };

  const wantBwrap = choice === "bwrap" || (choice === "auto" && process.platform === "linux");
  const wantSeatbelt = choice === "seatbelt" || (choice === "auto" && process.platform === "darwin");

  if (wantBwrap) {
    const probe = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-pid", "--", "true"], { stdio: "ignore" });
    if (probe.status === 0) return { sandbox: bwrapSandbox };
    const why = probe.error ? "bwrap is not installed" : "bwrap is installed but failed (user namespaces disabled?)";
    if (choice === "bwrap") throw new Error(`Sandbox 'bwrap' unavailable: ${why}`);
    return { sandbox: noSandbox, warning: `No sandbox: ${why}. Install bubblewrap or run inside a container.` };
  }
  if (wantSeatbelt) {
    if (existsSync("/usr/bin/sandbox-exec")) return { sandbox: seatbeltSandbox };
    if (choice === "seatbelt") throw new Error("Sandbox 'seatbelt' unavailable: /usr/bin/sandbox-exec not found");
  }
  return { sandbox: noSandbox, warning: `No sandbox available on ${process.platform}. Run inside a container.` };
}

/** Credenciales habituales que un comando nunca necesita leer. */
export function defaultHiddenPaths(): string[] {
  const h = os.homedir();
  return [".ssh", ".aws", ".gnupg", ".config/gcloud", ".azure", ".kube", ".docker/config.json", ".npmrc", ".netrc"].map(
    (p) => path.join(h, p),
  );
}

export const realpathOrSelf = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
