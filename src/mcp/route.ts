// POST /mcp: MCP Streamable HTTP, stateless (no sessions), JSON responses (no SSE). Each request gets a
// fresh server + transport, which is what Workers want: no state survives between requests anyway.
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { requireBearer } from "../auth.ts";
import type { Env } from "../env.ts";
import { createMcpServer } from "./server.ts";

export const mcp = new Hono<{ Bindings: Env }>();

mcp.use("*", requireBearer);

mcp.post("/", async (c) => {
  const server = createMcpServer(c.env);
  const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(c);
    // Notifications/responses from the client: 202 Accepted with no body (the transport sends "null").
    return res?.status === 202 ? new Response(null, { status: 202 }) : res;
  } finally {
    // With JSON responses the reply is complete once handleRequest resolves.
    await server.close();
  }
});

// Stateless server: no standalone SSE stream (GET) and no sessions to end (DELETE). The spec allows 405 for both.
mcp.on(["GET", "DELETE"], "/", (c) =>
  c.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this MCP server is stateless, send JSON-RPC requests with POST." }, id: null },
    405,
    { Allow: "POST" },
  ),
);
