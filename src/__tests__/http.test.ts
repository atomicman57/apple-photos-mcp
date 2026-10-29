import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { bearerMatches, httpPort, loadBearerToken, startHttpServer } from "../http.js";

const TOKEN = "test-token-0123456789abcdef";

describe("bearerMatches", () => {
  it("accepts the exact token, case-insensitive scheme", () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it("rejects missing, malformed, and wrong tokens", () => {
    expect(bearerMatches(undefined, TOKEN)).toBe(false);
    expect(bearerMatches("", TOKEN)).toBe(false);
    expect(bearerMatches(TOKEN, TOKEN)).toBe(false);
    expect(bearerMatches(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(bearerMatches("Bearer ", TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer ${TOKEN}`, "")).toBe(false);
  });
});

describe("httpPort / loadBearerToken", () => {
  it("defaults to 8788 and validates overrides", () => {
    expect(httpPort({})).toBe(8788);
    expect(httpPort({ APPLE_PHOTOS_MCP_HTTP_PORT: "9001" })).toBe(9001);
    expect(() => httpPort({ APPLE_PHOTOS_MCP_HTTP_PORT: "nope" })).toThrow(/1-65535/);
  });

  it("prefers the env override", () => {
    expect(loadBearerToken({ APPLE_PHOTOS_MCP_BEARER_TOKEN: " abc " })).toBe("abc");
  });
});

describe("startHttpServer", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = await startHttpServer({
      port: 0,
      token: TOKEN,
      createServer: () => {
        const s = new McpServer({ name: "test", version: "0.0.0" });
        s.registerTool("ping", { description: "ping" }, async () => ({
          content: [{ type: "text", text: "pong" }],
        }));
        return s;
      },
    });
    const { address, port } = server.address() as AddressInfo;
    expect(address).toBe("127.0.0.1");
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it("serves an unauthenticated /healthz", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("returns 401 + WWW-Authenticate without a valid token", async () => {
    for (const headers of [{}, { Authorization: "Bearer wrong" }] as Record<string, string>[]) {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: "{}",
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    }
  });

  it("rejects a non-initialize request without a session", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(400);
  });

  it("runs initialize + tools/list + tools/call over Streamable HTTP, on /mcp and /", async () => {
    for (const path of ["/mcp", "/"]) {
      const transport = new StreamableHTTPClientTransport(new URL(`${base}${path}`), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      });
      const client = new Client({ name: "t", version: "0" });
      await client.connect(transport);
      expect(transport.sessionId).toBeTruthy();
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["ping"]);
      const result = await client.callTool({ name: "ping", arguments: {} });
      expect(result.content).toEqual([{ type: "text", text: "pong" }]);
      await transport.terminateSession();
      await client.close();
    }
  });
});
