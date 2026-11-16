import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { McpManager, McpTool } from "../mcp/manager.js";
import { type Tool, defineTool } from "./types.js";

/** Límite de la API para el nombre de una tool. */
const MAX_NAME = 64;

/** `mcp__<servidor>__<tool>`, con lo que la API no admite cambiado por `_`. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, MAX_NAME);
}

/** El servidor de una tool `mcp__<servidor>__<tool>`. */
export function mcpServerOf(toolName: string): string {
  return /^mcp__(.+?)__/.exec(toolName)?.[1] ?? "";
}

/**
 * Tools de los servidores conectados, listas para el registro. Dos que acaben con el mismo nombre (tras normalizar
 * o recortar) se quedan en la primera, con aviso.
 */
export function createMcpTools(mcp: McpManager, warnings: string[]): Tool[] {
  const out = new Map<string, Tool>();
  for (const t of mcp.tools()) {
    const name = mcpToolName(t.server, t.name);
    if (out.has(name)) {
      warnings.push(`MCP tool "${t.name}" from "${t.server}" ignored: its name collides with another tool (${name}).`);
      continue;
    }
    out.set(name, createMcpTool(mcp, t, name));
  }
  return [...out.values()];
}

function createMcpTool(mcp: McpManager, t: McpTool, name: string): Tool {
  return defineTool({
    name,
    description: t.description?.trim() || `Tool "${t.name}" of the MCP server "${t.server}".`,
    // El servidor valida los argumentos; aquí solo se exige un objeto.
    schema: z.record(z.string(), z.unknown()),
    jsonSchema: { ...t.inputSchema, type: "object" },
    // Lo que declare el servidor no basta para ejecutarla en paralelo con otras.
    readOnly: false,
    permissionTarget: () => ({ kind: "mcp", server: t.server }),
    async run(input, ctx) {
      try {
        const r = await mcp.callTool(t.server, t.name, input, ctx.signal);
        return { content: mcpResultText(r), ...(r.isError ? { isError: true } : {}) };
      } catch (e) {
        if (ctx.signal.aborted) return { content: "Interrupted by user.", isError: true };
        return { content: `MCP error (${t.server}): ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
    },
  });
}

/**
 * El resultado como texto para el `tool_result`. Imágenes y audio no caben (el `tool_result` canónico solo
 * lleva texto): se describen. Un recurso embebido de texto va entero; uno binario, solo su referencia.
 */
export function mcpResultText(r: CallToolResult): string {
  const parts = r.content.map((c) => {
    switch (c.type) {
      case "text":
        return c.text;
      case "image":
      case "audio":
        return `[${c.type} ${c.mimeType}, ${sizeOf(c.data)}: not shown]`;
      case "resource":
        return "text" in c.resource ? c.resource.text : `[resource ${c.resource.uri}${c.resource.mimeType ? ` (${c.resource.mimeType})` : ""}, binary: not shown]`;
      case "resource_link":
        return `[resource ${c.uri}${c.name && c.name !== c.uri ? ` "${c.name}"` : ""}]`;
      default:
        return `[unsupported content: ${(c as { type: string }).type}]`;
    }
  });
  // Sin content, `structuredContent` es lo único que hay.
  if (!parts.length && r.structuredContent) parts.push(JSON.stringify(r.structuredContent, null, 2));
  return parts.join("\n") || "(no output)";
}

function sizeOf(base64: string): string {
  const bytes = Math.floor((base64.length * 3) / 4);
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}
