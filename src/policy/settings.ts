import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { PermissionMode, RuleSet } from "./engine.js";
import { parseRule } from "./rules.js";
import type { SandboxChoice } from "./sandbox/index.js";

const SettingsSchema = z.object({
  permissions: z
    .object({
      allow: z.array(z.string()).default([]),
      ask: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
      defaultMode: z.enum(["default", "acceptEdits", "bypass"]).optional(),
    })
    .default({ allow: [], ask: [], deny: [] }),
  sandbox: z
    .object({
      mode: z.enum(["auto", "bwrap", "seatbelt", "none"]).optional(),
      network: z.enum(["none", "host"]).optional(),
    })
    .optional(),
});

export interface LoadedSettings {
  rules: RuleSet;
  mode?: PermissionMode;
  sandbox: { mode?: SandboxChoice; network?: "none" | "host" };
  warnings: string[];
  file?: string;
}

export const settingsFile = (workspace: string) => path.join(workspace, ".harness", "settings.json");

/**
 * Lee los bloques `permissions` y `sandbox` de `<workspace>/.harness/settings.json`. No hay ningún `deny` implícito:
 * lo que no esté escrito aquí o en `--deny` no se deniega. Un repositorio no puede escalarse a sí mismo: ni ponerse
 * en `bypass` (solo con `--permission-mode`), ni desactivar el sandbox (solo con `--sandbox none`), ni abrir la red
 * (puede cortarla, nunca abrirla).
 */
export function loadSettings(workspace: string): LoadedSettings {
  const out: LoadedSettings = { rules: { allow: [], ask: [], deny: [] }, sandbox: {}, warnings: [] };
  const file = settingsFile(workspace);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return out;
  }
  const parsed = SettingsSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`Invalid settings in ${file}: ${parsed.error.message}`);
  const p = parsed.data.permissions;
  for (const r of [...p.allow, ...p.ask, ...p.deny]) parseRule(r); // una regla mal escrita falla al arrancar, no al evaluarla
  out.file = file;
  out.rules = { allow: p.allow, ask: p.ask, deny: p.deny };
  if (p.defaultMode === "bypass") out.warnings.push(`Ignored defaultMode "bypass" from ${file}: use --permission-mode bypass.`);
  else if (p.defaultMode) out.mode = p.defaultMode;
  const sb = parsed.data.sandbox;
  if (sb?.mode === "none") out.warnings.push(`Ignored sandbox.mode "none" from ${file}: use --sandbox none.`);
  else if (sb?.mode) out.sandbox.mode = sb.mode;
  // Un proyecto puede restringir la red, no abrirla.
  if (sb?.network === "none") out.sandbox.network = "none";
  return out;
}

export const PERMISSION_MODES = new Set<string>(["default", "acceptEdits", "bypass"]);
export const SANDBOX_CHOICES = new Set<string>(["auto", "bwrap", "seatbelt", "none"]);
