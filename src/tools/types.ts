import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ToolSpec } from "../providers/canonical.js";
import type { FileStateCache } from "./file-state.js";

export interface ToolCtx {
  /** Raíz del workspace: límite de lectura y base de rutas relativas. */
  workspace: string;
  signal: AbortSignal;
  /** Qué ficheros ha leído el modelo y en qué estado: lo usan Edit y Write. */
  fileState: FileStateCache;
  /** Id del tool_use que se está ejecutando. */
  callId?: string;
}

export interface ToolOutput {
  content: string;
  isError?: boolean;
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  /** El texto que lee el modelo. Aquí se gana o se pierde calidad. */
  description: string;
  schema: S;
  /** true => se puede ejecutar en paralelo con otras readOnly. */
  readOnly: boolean | ((input: z.infer<S>) => boolean);
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
 * Límite de workspace. Resuelve la ruta y, si existe, sus enlaces simbólicos con `realpath`: un enlace dentro del
 * workspace que apunta fuera se rechaza. El error vuelve al modelo como resultado de la herramienta.
 * No es el modelo de permisos del agente: es el mínimo para que una herramienta de solo lectura no salga de aquí.
 */
export async function resolveInWorkspace(
  workspace: string,
  p: string,
): Promise<{ ok: true; path: string } | { ok: false; error: ToolOutput }> {
  const abs = resolvePath(workspace, p);
  const root = await realpath(workspace);
  const real = await realpath(abs).catch(() => null);
  const inside = real ? isInside(root, real) : isInside(root, abs) || isInside(workspace, abs);
  if (!inside) return { ok: false, error: { content: `Path is outside the workspace: ${p}`, isError: true } };
  return { ok: true, path: real ?? abs };
}

/** Recorta salidas largas conservando cabeza y cola, que es donde suele estar la señal. */
export function truncateMiddle(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  const omitted = s.length - head - tail;
  return `${s.slice(0, head)}\n\n[... ${omitted} characters omitted ...]\n\n${s.slice(-tail)}`;
}
