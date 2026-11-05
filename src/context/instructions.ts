import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const INSTRUCTIONS_FILENAME = "AGENTS.md";

/**
 * Las instrucciones del proyecto: el `AGENTS.md` de la raíz del workspace, si existe y no está vacío.
 * Van en el system prompt, que no forma parte de `messages`: ni la limpieza ni la compaction lo tocan, y se
 * envía entero en cada petición, así que cada línea cuesta contexto en cada turno. Que esté disponible no
 * garantiza que el modelo lo cumpla.
 */
export function loadInstructions(workspace: string): string | null {
  const file = path.join(workspace, INSTRUCTIONS_FILENAME);
  if (!existsSync(file)) return null;
  const content = readFileSync(file, "utf8").trim();
  return content ? `# Project instructions\n<project_instructions path="${INSTRUCTIONS_FILENAME}">\n${content}\n</project_instructions>` : null;
}
