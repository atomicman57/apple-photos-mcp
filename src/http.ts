/**
 * Streamable HTTP transport with bearer-token auth (opt-in; stdio is default).
 *
 * Enabled with APPLE_PHOTOS_MCP_TRANSPORT=http (or `--http`). Binds to
 * 127.0.0.1 only — exposure beyond the machine is a tunnel's job, never this
 * process's. Sessions are stateful: each `initialize` gets its own transport +
 * McpServer (from the caller's factory), keyed by the `mcp-session-id` header;
 * every server shares the process-wide PhotosManager, so the persistent sidecar
 * and its parsed PhotosDB stay warm across sessions.
 *
 * Auth: every request except `GET /healthz` must carry
 * `Authorization: Bearer <token>` (constant-time compared) or gets a 401. The
 * token comes from APPLE_PHOTOS_MCP_BEARER_TOKEN, else the login keychain
 * (service `apple-photos-mcp`, account `bearer-token`). It is never logged.
 *
 * @module http
 */
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { withJsonSchema2020_12 } from "./utils/jsonSchemaDialect.js";

export const HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 8788;
export const KEYCHAIN_SERVICE = "apple-photos-mcp";
export const KEYCHAIN_ACCOUNT = "bearer-token";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export function httpPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.APPLE_PHOTOS_MCP_HTTP_PORT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_HTTP_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`APPLE_PHOTOS_MCP_HTTP_PORT must be an integer 1-65535 (got "${raw}")`);
  }
  return n;
}

/**
 * Resolve the bearer token: env override first, then the login keychain.
 * Throws (without the value, ever) when neither yields a token — the server
 * never invents one; scripts/hosting/install-launchagent.sh creates it.
 */
export function loadBearerToken(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.APPLE_PHOTOS_MCP_BEARER_TOKEN?.trim();
  if (override) return override;
  let token = "";
  try {
    token = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }
    ).trim();
  } catch {
    // fall through to the error below
  }
  if (!token) {
    throw new Error(
      `HTTP mode requires a bearer token, but none was found. Expected a login-keychain ` +
        `generic password (service "${KEYCHAIN_SERVICE}", account "${KEYCHAIN_ACCOUNT}") or ` +
        `APPLE_PHOTOS_MCP_BEARER_TOKEN. Create it with scripts/hosting/install-launchagent.sh.`
    );
  }
  return token;
}

/** Constant-time check of an Authorization header against the expected token. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header ?? "");
  if (!match || !token) return false;
  // Hash both sides so the comparison is fixed-length (no length leak).
  const a = createHash("sha256").update(match[1]).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function rpcError(res: ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });
}

class BodyTooLargeError extends Error {}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastSeen: number;
}

export interface HttpServerOptions {
  port: number;
  token: string;
  createServer: () => McpServer;
  /** Close sessions idle longer than this (default 24 h; env APPLE_PHOTOS_MCP_HTTP_SESSION_TTL_MS). */
  sessionTtlMs?: number;
}

export async function startHttpServer(opts: HttpServerOptions): Promise<Server> {
  const sessions = new Map<string, Session>();
  const envTtl = Number(process.env.APPLE_PHOTOS_MCP_HTTP_SESSION_TTL_MS);
  const ttl = opts.sessionTtlMs ?? (envTtl > 0 ? envTtl : DEFAULT_SESSION_TTL_MS);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "/").split("?")[0];

    // Unauthenticated liveness probe: constant body, never touches Photos.
    if (path === "/healthz" && (req.method === "GET" || req.method === "HEAD")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(req.method === "HEAD" ? undefined : "ok");
      return;
    }

    if (!bearerMatches(req.headers.authorization, opts.token)) {
      res.writeHead(401, { "WWW-Authenticate": 'Bearer realm="apple-photos-mcp"' });
      res.end();
      return;
    }

    if (path !== "/mcp" && path !== "/") {
      res.writeHead(404).end();
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (existing) existing.lastSeen = Date.now();

    if (req.method === "POST") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          return rpcError(res, 413, -32600, "Request body too large");
        }
        return rpcError(res, 400, -32700, "Parse error: invalid JSON");
      }

      if (existing) {
        await existing.transport.handleRequest(req, res, body);
        return;
      }
      if (sessionId !== undefined) {
        return rpcError(res, 404, -32001, "Session not found — re-initialize");
      }
      if (!isInitializeRequest(body)) {
        return rpcError(res, 400, -32000, "Bad Request: no valid session ID provided");
      }

      const server = opts.createServer();
      const transport: StreamableHTTPServerTransport = withJsonSchema2020_12(
        new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, server, lastSeen: Date.now() });
          },
        })
      );
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      if (!existing) {
        return sessionId === undefined
          ? rpcError(res, 400, -32000, "Bad Request: missing mcp-session-id")
          : rpcError(res, 404, -32001, "Session not found — re-initialize");
      }
      await existing.transport.handleRequest(req, res);
      return;
    }

    res.writeHead(405, { Allow: "GET, POST, DELETE" }).end();
  };

  const httpServer = createHttpServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error("[http] request failed:", err instanceof Error ? err.message : err);
      if (!res.headersSent) rpcError(res, 500, -32603, "Internal server error");
      else res.end();
    });
  });

  const sweep = setInterval(
    () => {
      const cutoff = Date.now() - ttl;
      for (const [id, s] of sessions) {
        if (s.lastSeen < cutoff) {
          sessions.delete(id);
          s.server.close().catch(() => {});
        }
      }
    },
    Math.min(ttl, 5 * 60 * 1000)
  );
  sweep.unref();
  httpServer.on("close", () => clearInterval(sweep));

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, HTTP_HOST, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  return httpServer;
}
