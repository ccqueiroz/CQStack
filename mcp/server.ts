import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createBus, invoke, TOOL_DESCRIPTORS } from "../runtime/src/surface.js";
const server = new Server(
  { name: "cartera-harness", version: "0.1.0" },
  { capabilities: { tools: {} } }
);
const bus = createBus();
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DESCRIPTORS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            await invoke(
              bus,
              request.params.name,
              request.params.arguments ?? {}
            )
          ),
        },
      ],
    };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : "UNKNOWN_ERROR",
        },
      ],
    };
  }
});
await server.connect(new StdioServerTransport());
