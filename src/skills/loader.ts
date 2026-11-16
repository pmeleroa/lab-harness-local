import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Message } from "../providers/canonical.js";

/**
 * Skill: una carpeta con un SKILL.md (frontmatter name/description + instrucciones) y, opcionalmente,
 * scripts y referencias. Se cargan a demanda: el modelo solo ve name + description hasta que la invoca.
 */
export interface Skill {
  name: string;
  description: string;
  /** Carpeta de la skill: las rutas relativas de sus instrucciones salen de aquí. */
  dir: string;
  file: string;
  source: "usuario" | "proyecto";
  /** false (`disable-model-invocation: true`) => no aparece en el catálogo del modelo ni la puede invocar. */
  modelInvocable: boolean;
}

/** Límite por descripción en el catálogo: con ventanas pequeñas, una descripción larga se come el margen. */
export const MAX_DESCRIPTION = 250;
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Raíces donde se buscan skills. El lab solo tiene la del proyecto; `harness` añade las de usuario
 * (`~/.harness/skills`), que pierden frente a las de proyecto con el mismo nombre.
 */
export function skillRoots(workspace: string): { dir: string; source: Skill["source"] }[] {
  return [{ dir: path.join(workspace, ".harness", "skills"), source: "proyecto" }];
}

/**
 * Busca `<raíz>/<carpeta>/SKILL.md` en cada raíz. Con el mismo nombre gana la de la última raíz.
 */
export function loadSkills(workspace: string, roots = skillRoots(workspace)): { skills: Skill[]; warnings: string[] } {
  const byName = new Map<string, Skill>();
  const warnings: string[] = [];
  for (const root of roots) {
    if (!existsSync(root.dir)) continue;
    for (const entry of readdirSync(root.dir).sort()) {
      const dir = path.join(root.dir, entry);
      const file = path.join(dir, "SKILL.md");
      if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory() || !existsSync(file)) continue;
      const { meta } = parseSkillFile(readFileSync(file, "utf8"));
      const name = meta.name || entry;
      if (!NAME_RE.test(name)) {
        warnings.push(`skill ignorada (nombre no válido "${name}"): ${file}`);
        continue;
      }
      if (!meta.description) {
        warnings.push(`skill ignorada (sin description): ${file}`);
        continue;
      }
      byName.set(name, {
        name,
        description: meta.description.replace(/\s+/g, " ").trim(),
        dir,
        file,
        source: root.source,
        modelInvocable: meta["disable-model-invocation"] !== "true",
      });
    }
  }
  return { skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), warnings };
}

/**
 * Frontmatter YAML mínimo: `clave: valor` de una línea (con o sin comillas) y bloques `>` / `|`.
 * Basta para SKILL.md; claves desconocidas (allowed-tools...) se leen y se ignoran.
 */
export function parseSkillFile(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    const [, key, raw] = kv;
    let value = raw!.trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1] === "")) block.push(lines[++i]!.trim());
      value = block.join(value.startsWith(">") ? " " : "\n").trim();
    } else if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    meta[key!] = value;
  }
  return { meta, body: text.slice(m[0].length).trim() };
}

/**
 * Lo que entra en la conversación al invocar una skill con la tool. La etiqueta <skill> permite reconocer
 * después que ya está cargada. $ARGUMENTS se sustituye; si no aparece, los argumentos van al final.
 */
export function renderSkill(skill: Skill, args = ""): string {
  const { body } = parseSkillFile(readFileSync(skill.file, "utf8"));
  const a = args.trim();
  const text = body.includes("$ARGUMENTS") ? body.replaceAll("$ARGUMENTS", a) : a ? `${body}\n\nARGUMENTS: ${a}` : body;
  return [
    `<skill name="${skill.name}">`,
    `Base directory for this skill: ${skill.dir}`,
    "Relative paths in these instructions (scripts, references) are relative to that directory.",
    "",
    text,
    "</skill>",
  ].join("\n");
}

/** Bloque del system prompt con el catálogo. Solo name + description: el cuerpo se carga al invocar. */
export function skillCatalog(skills: Skill[]): string {
  const visible = skills.filter((s) => s.modelInvocable);
  if (!visible.length) return "";
  const clip = (d: string) => (d.length > MAX_DESCRIPTION ? `${d.slice(0, MAX_DESCRIPTION - 1)}…` : d);
  return [
    "# Skills",
    "Skills are packaged instructions for specific tasks. When a task matches a skill's description, call the",
    "Skill tool with its name before doing anything else, then follow the instructions it returns.",
    "<available_skills>",
    ...visible.map((s) => `- ${s.name}: ${clip(s.description)}`),
    "</available_skills>",
  ].join("\n");
}

const LOADED_RE = /^<skill name="([^"]+)">/;

/** Skills cuyo cuerpo ya está en la conversación (cargadas por la tool Skill). */
export function loadedSkills(messages: Message[]): Set<string> {
  const names = new Set<string>();
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const b of m.content) {
      const text = b.type === "text" ? b.text : b.type === "tool_result" ? b.content : "";
      const hit = LOADED_RE.exec(text);
      if (hit) names.add(hit[1]!);
    }
  }
  return names;
}

/**
 * Lo que se envía al invocar una skill que ya está en la conversación: una referencia y los argumentos,
 * no el cuerpo otra vez. No empieza por <skill name=…>, así que no cuenta como una segunda carga.
 */
export function renderSkillReference(skill: Skill, args = ""): string {
  const a = args.trim();
  return [
    `The "${skill.name}" skill is already loaded earlier in this conversation. Follow those instructions again`,
    a ? `with these arguments (they replace any previous ones): ${a}` : "for this request.",
  ].join(" ");
}
