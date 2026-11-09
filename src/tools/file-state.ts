import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

export interface FileSnapshot {
  mtimeMs: number;
  size: number;
  hash: string;
}

export const hashContent = (buf: string | Buffer): string =>
  createHash("sha256").update(buf).digest("hex");

/**
 * Registra qué ficheros ha leído el modelo y en qué estado.
 * Edit/Write lo usan para:
 *  - exigir read-before-edit (el modelo no edita a ciegas)
 *  - detectar ediciones concurrentes (humano, formatter, otro proceso)
 */
export class FileStateCache {
  private snaps = new Map<string, FileSnapshot>();

  record(path: string, snap: FileSnapshot): void {
    this.snaps.set(path, snap);
  }

  get(path: string): FileSnapshot | undefined {
    return this.snaps.get(path);
  }

  /** Devuelve un mensaje de error si el fichero no se puede modificar con seguridad. */
  async checkWritable(path: string): Promise<string | null> {
    const snap = this.snaps.get(path);
    if (!snap) {
      return `File has not been read yet. Read ${path} before modifying it.`;
    }
    const st = await stat(path).catch(() => null);
    if (!st) return null; // borrado desde la lectura: se permite recrearlo
    const modified = `File ${path} was modified since it was last read. Read it again before modifying it.`;
    if (st.mtimeMs !== snap.mtimeMs || st.size !== snap.size) return modified;
    // Un reemplazo externo puede conservar tamaño y fecha: el contenido manda.
    const buf = await readFile(path).catch(() => null);
    if (buf && hashContent(buf) !== snap.hash) return modified;
    return null;
  }
}
