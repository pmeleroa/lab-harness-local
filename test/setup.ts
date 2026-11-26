import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Cada fichero de tests tiene un HOME vacío: las sesiones (~/.harness/sessions) nunca van al HOME real. Va bajo el
// HOME real y no en el temporal porque los tests del sandbox ponen ahí sus rutas: en Linux `/tmp` es un tmpfs dentro
// de bwrap y en macOS el perfil deja escribir en el temporal, así que allí no demostrarían nada.
process.env.HOME = mkdtempSync(path.join(process.env.LAB_TEST_HOMES ?? os.homedir(), "home-"));
