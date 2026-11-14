import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ToolSpec } from "../providers/canonical.js";
import type { FileStateCache } from "./file-state.js";

export interface ToolCtx {
  /** Raíz del workspace: límite de lectura y base de rutas relativas. */
  workspace: string;
  signal: AbortSignal;
  /** Si una búsqueda (Glob, Grep) puede incluir este fichero: quita lo que una regla de lectura más concreta deniega. */
  searchable?: (absPath: string) => boolean;
  /** Qué ficheros ha leído el modelo y en qué estado: lo usan Edit y Write. */
  fileState: FileStateCache;
  /** Id del tool_use que se está ejecutando. */
  callId?: string;
}

export interface ToolOutput {
  content: string;
  isError?: boolean;
}

/**
 * Lo que el motor de permisos necesita saber de una llamada: qué ruta real toca y si lee o escribe, qué comando
 * ejecuta, o qué tarea en segundo plano propia consulta o para.
 */
export type PermissionTarget =
  | { kind: "path"; path: string; access: "read" | "write" }
  /** `cwd`: directorio del shell en el que se ejecutará; las rutas relativas del comando se resuelven desde ahí. */
  | { kind: "command"; command: string; cwd?: string }
  | { kind: "task"; id: string };

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  /** El texto que lee el modelo. Aquí se gana o se pierde calidad. */
  description: string;
  schema: S;
  /** true => se puede ejecutar en paralelo con otras readOnly. */
  readOnly: boolean | ((input: z.infer<S>) => boolean);
  permissionTarget(input: z.infer<S>, ctx: Pick<ToolCtx, "workspace">): PermissionTarget;
  run(input: z.infer<S>, ctx: ToolCtx): Promise<ToolOutput>;
}

export const defineTool = <S extends z.ZodType>(t: Tool<S>): Tool<S> => t;

export function toolSpec(t: Tool): ToolSpec {
  const schema = z.toJSONSchema(t.schema, { target: "draft-2020-12" }) as Record<string, unknown>;
  delete schema.$schema;
  return { name: t.name, description: t.description, inputSchema: schema };
}

export function resolvePath(workspace: string, p: string): string {
  if (p === "~" || p.startsWith("~/")) return path.join(os.homedir(), p.slice(1));
  return path.resolve(workspace, p);
}

export function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Ruta real de `p`: resuelve los enlaces simbólicos con `realpath`. Si la ruta aún no existe (un `Write` nuevo), se
 * resuelve el ancestro más profundo que sí existe y se le añade el resto: un directorio que es un enlace hacia fuera
 * se detecta igual. Un enlace colgante (que apunta a algo que no existe) se sigue con `readlink`: `writeFile` lo
 * seguiría y crearía el destino, así que el motor tiene que ver el destino y no el nombre del enlace.
 * No rechaza nada: decidir si se puede tocar es cosa del motor de permisos, que recibe esta ruta.
 */
export function resolveReal(workspace: string, p: string): string {
  return resolveFrom(resolvePath(workspace, p), 0);
}

const MAX_LINK_HOPS = 40;

function resolveFrom(abs: string, hops: number): string {
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(realpathSync(cur), ...rest.reverse());
    } catch {
      // ¿Es un enlace colgante? Se sustituye por su destino y se resuelve de nuevo.
      try {
        if (lstatSync(cur).isSymbolicLink() && hops < MAX_LINK_HOPS) {
          const target = path.resolve(path.dirname(cur), readlinkSync(cur));
          return resolveFrom(path.join(target, ...rest.reverse()), hops + 1);
        }
      } catch {
        // no existe: se sube un nivel
      }
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Recorta salidas largas conservando cabeza y cola, que es donde suele estar la señal. */
export function truncateMiddle(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  const omitted = s.length - head - tail;
  return `${s.slice(0, head)}\n\n[... ${omitted} characters omitted ...]\n\n${s.slice(-tail)}`;
}
