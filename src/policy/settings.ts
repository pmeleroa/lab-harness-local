import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { PermissionMode, RuleSet } from "./engine.js";
import { parseRule } from "./rules.js";

const SettingsSchema = z.object({
  permissions: z
    .object({
      allow: z.array(z.string()).default([]),
      ask: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
      defaultMode: z.enum(["default", "acceptEdits", "bypass"]).optional(),
    })
    .default({ allow: [], ask: [], deny: [] }),
});

export interface LoadedSettings {
  rules: RuleSet;
  mode?: PermissionMode;
  warnings: string[];
  file?: string;
}

export const settingsFile = (workspace: string) => path.join(workspace, ".harness", "settings.json");

/**
 * Lee el bloque `permissions` de `<workspace>/.harness/settings.json`. No hay ningún `deny` implícito: lo que no
 * esté escrito aquí o en `--deny` no se deniega. Un repositorio no puede ponerse a sí mismo en `bypass`: ese modo
 * solo se activa con `--permission-mode`.
 */
export function loadSettings(workspace: string): LoadedSettings {
  const out: LoadedSettings = { rules: { allow: [], ask: [], deny: [] }, warnings: [] };
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
  return out;
}

export const PERMISSION_MODES = new Set<string>(["default", "acceptEdits", "bypass"]);
