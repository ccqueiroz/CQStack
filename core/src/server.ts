import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Bus } from "./bus.js";
import { ProfileError } from "./profile.js";
import { StateError } from "./storage.js";
import { TOOL_DESCRIPTORS, invoke } from "./tools.js";

export const SERVER_NAME = "cqstack";

const codeOf = (error: unknown) => (error instanceof StateError || error instanceof ProfileError ? error.code : "UNEXPECTED_ERROR");

// No exception leaves the call handler, so the server answers the next call after any error. The SDK itself refuses arguments
// that are not an object with a JSON-RPC error before this handler runs.
export function createServer(bus: Bus): Server {
  const server = new Server({ name: SERVER_NAME, version: bus.version.tag ?? bus.version.commit }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DESCRIPTORS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema: inputSchema as { type: "object" } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return { content: [{ type: "text" as const, text: JSON.stringify(invoke(bus, request.params.name, request.params.arguments)) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ code: codeOf(error), message }) }] };
    }
  });
  return server;
}
