// Servidor MCP simulado para los tests, por stdio (recortado del de `harness`: sin resources, prompts ni HTTP).
//   FAKE_MCP_FAIL=1  sale nada más arrancar, con un mensaje en stderr
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { writeFileSync } from "node:fs";
import { z } from "zod";

if (process.env.FAKE_MCP_FAIL) {
  process.stderr.write("fake: cannot start\n");
  process.exit(2);
}

const server = new McpServer({ name: "fake", version: "1.0.0" });
server.registerTool(
  "echo",
  { description: "Devuelve el texto", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
  async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
);
server.registerTool("env", { description: "Lee una variable de entorno", inputSchema: { name: z.string() } }, async ({ name }) => ({
  content: [{ type: "text", text: String(process.env[name] ?? "") }],
}));
server.registerTool("cwd", { description: "Directorio de trabajo" }, async () => ({ content: [{ type: "text", text: process.cwd() }] }));
server.registerTool("touch", { description: "Escribe un fichero", inputSchema: { path: z.string() } }, async ({ path }) => {
  try {
    writeFileSync(path, "x");
    return { content: [{ type: "text", text: "written" }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: String(e.code ?? e) }] };
  }
});
server.registerTool("fail", { description: "Devuelve un error de tool" }, async () => ({ isError: true, content: [{ type: "text", text: "boom" }] }));
server.registerTool("crash", { description: "Mata el proceso" }, async () => {
  process.stderr.write("crashing on purpose\n");
  process.exit(3);
});
await server.connect(new StdioServerTransport());
