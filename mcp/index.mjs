import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { allTools, toCallToolResult, validateToolArguments } from "./tools.mjs";
import { killTrackedDetachedChildren } from "./utils/child-process.js";

export { allTools };

// MCP Server Setup
const server = new Server(
  { name: "pisoul", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: Object.values(allTools).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
      _meta: {
        "antigravity/alwaysLoad": true,
      },
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const toolName = request.params.name;
  const tool = allTools[toolName];
  if (!tool) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  const args = request.params.arguments ?? {};
  const argumentError = validateToolArguments(toolName, args);
  if (argumentError) {
    return toCallToolResult({
      content: [{ type: "text", text: argumentError }],
      isError: true,
    });
  }

  const result = await tool.execute(
    `call_${Date.now()}`,
    args,
    extra.signal
  );

  return toCallToolResult(result);
});

const transport = new StdioServerTransport();
await server.connect(transport);

// Bash children run in their own process group on Unix, so they would outlive this server. pi kills
// its tracked detached children on shutdown for the same reason.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    killTrackedDetachedChildren();
    process.exit(0);
  });
}
process.on("exit", () => {
  killTrackedDetachedChildren();
});
