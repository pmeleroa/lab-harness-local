// Hook PreToolUse de Bash: bloquea un `git commit` cuyo mensaje no cumple la convención del proyecto.
// Recibe la llamada como JSON por stdin. Sale con 2 y el motivo en stderr para bloquear; con 0, la deja pasar.
// Es un ejemplo: solo entiende `git commit -m "<mensaje>"` (no `-F`, ni un editor, ni un heredoc).
import { readFileSync } from "node:fs";

const { tool, input } = JSON.parse(readFileSync(0, "utf8"));
const command = String(input?.command ?? "");
if (tool !== "Bash" || !/\bgit\s+commit\b/.test(command)) process.exit(0);

const FORMAT = "<tipo>(<ámbito>): <descripción> (#<issue>), por ejemplo: fix(cart): redondea el total a céntimos (#12)";
const block = (why) => {
  process.stderr.write(`Commit bloqueado por la convención del proyecto: ${why}. Formato: ${FORMAT}.\n`);
  process.exit(2);
};

const m = /\s-[a-z]*m\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(command);
if (!m) block('usa git commit -m "<mensaje>"');
const message = m[1] ?? m[2];
if (message.length > 72) block(`el mensaje tiene ${message.length} caracteres (máximo 72)`);
if (!/^(fix|feat|refactor|test|docs|chore)(\([a-z0-9-]+\))?: \S/.test(message)) block(`«${message}» no empieza por un tipo válido seguido de «: »`);
if (/^[^:]+: [A-ZÁÉÍÓÚÑ]/.test(message)) block(`«${message}»: la descripción va en minúsculas`);
if (/\.$/.test(message)) block(`«${message}»: sin punto final`);
process.exit(0);
