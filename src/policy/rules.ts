import os from "node:os";
import path from "node:path";

/**
 * Sintaxis de reglas de ruta:
 *   Read(src/**)         glob relativo al workspace (o absoluto / con ~)
 *   Edit(**\/*.ts)       aplica a toda escritura de ficheros (Edit y Write)
 *   Edit                 sin especificador: la herramienta entera
 */
export interface Rule {
  raw: string;
  tool: string;
  specifier?: string;
}

export function parseRule(raw: string): Rule {
  const m = /^([A-Za-z_][\w-]*)(?:\((.*)\))?$/s.exec(raw.trim());
  if (!m) throw new Error(`Invalid permission rule: ${raw}`);
  const specifier = m[2]?.trim();
  return { raw, tool: m[1]!, ...(specifier ? { specifier } : {}) };
}

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` también casa con cero directorios
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i++;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matchPath(pattern: string, absPath: string, workspace: string): boolean {
  let p = pattern;
  if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
  else if (!path.isAbsolute(p)) p = path.join(workspace, p);
  // Un directorio sin glob cubre todo su contenido.
  if (!/[*?]/.test(p)) return absPath === p || absPath.startsWith(p.endsWith("/") ? p : `${p}/`);
  return globToRegExp(p).test(absPath);
}
