import { realpathSync } from "node:fs";
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

/** Lo que el motor de permisos necesita saber de una llamada: qué ruta real toca y si lee o escribe. */
export interface PermissionTarget {
  kind: "path";
  path: string;
  access: "read" | "write";
}

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
 * se detecta igual. No rechaza nada: decidir si se puede tocar es cosa del motor de permisos, que recibe esta ruta.
 */
export function resolveReal(workspace: string, p: string): string {
  const abs = resolvePath(workspace, p);
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(realpathSync(cur), ...rest.reverse());
    } catch {
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
