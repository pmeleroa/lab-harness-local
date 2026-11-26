import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Una carpeta por pasada, bajo el HOME real, con un HOME vacío por fichero de tests dentro (test/setup.ts). Se borra
 * al final de la pasada y no al de cada fichero: un comando en segundo plano que acaba tarde aún escribe su `task`.
 */
export default function setup() {
  const base = mkdtempSync(path.join(os.homedir(), ".lab-harness-test-homes-"));
  process.env.LAB_TEST_HOMES = base;
  return () => rmSync(base, { recursive: true, force: true });
}
