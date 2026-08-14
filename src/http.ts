#!/usr/bin/env node
/**
 * EzStat MCP server — streamable HTTP entry point (the hosted endpoint).
 *
 * Serves the SAME seven tools as the stdio entry (`src/index.ts`) over the MCP
 * streamable-HTTP transport, so agents can connect to https://mcp.ezstat.dev
 * with zero install — just their EzStat API key.
 *
 * MULTI-TENANT BY CONSTRUCTION: every request carries the caller's OWN key as
 * `Authorization: Bearer <ezkey>`. There is NO server-side EzStat key and this
 * process never reads EZSTAT_API_KEY — the env is consulted only for base-URL /
 * timeout / path overrides and the listen host/port.
 *
 * Auth policy — "optimistic introspection" (mirrors the stdio entry's
 * boot-without-key behavior):
 *   - `initialize` and `tools/list` are served WITHOUT a key, so agents and
 *     registry inspectors can discover the tool surface with zero setup.
 *   - every tool CALL requires the per-request key. A missing key produces a
 *     clean in-band MCP tool error (isError: true) telling the agent exactly
 *     which header to send — never a crash, never a hung connection.
 *   - an invalid key surfaces the EzStat API's 401/403 as a clean tool error.
 *
 * STATELESS: each POST builds a fresh McpServer + StreamableHTTPServerTransport
 * (`sessionIdGenerator: undefined`). No session state is held between requests,
 * so restarts lose nothing and any request can land on any worker.
 */

import http from "node:http";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { EzStatConfigError, loadConfigForKey } from "./config.js";
import { EzStatClient } from "./ezstat-client.js";
import { buildServer } from "./server.js";

export const DEFAULT_HTTP_PORT = 8432;
export const DEFAULT_HTTP_HOST = "127.0.0.1";

/** Injectable client factory so tests can swap in a mocked EzStat backend. */
export interface HttpAppDeps {
  makeClient?: (apiKey: string) => EzStatClient;
}

/**
 * A client whose every method rejects with a "send your key" error. Used when a
 * request arrives without Authorization: introspection (initialize/tools/list)
 * still works; tool calls fail with a clear, actionable in-band error.
 */
function makeKeylessClient(): EzStatClient {
  const err = new EzStatConfigError(
    "No EzStat API key on this request. Send it as `Authorization: Bearer <your ezkey>` — get a key at https://ezstat.dev.",
  );
  const reject = (): Promise<never> => Promise.reject(err);
  return new Proxy({} as EzStatClient, { get: () => reject });
}

/** Extract the Bearer token from the Authorization header, or null. */
function bearerKey(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const key = match?.[1]?.trim();
  return key ? key : null;
}

function jsonRpcError(res: http.ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" }).end(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
  );
}

/**
 * Build the HTTP server (not yet listening) so tests can bind an ephemeral port.
 */
export function createHttpApp(deps: HttpAppDeps = {}): http.Server {
  const makeClient =
    deps.makeClient ?? ((apiKey: string): EzStatClient => new EzStatClient(loadConfigForKey(apiKey)));

  return http.createServer((req, res) => {
    void handleRequest(req, res, makeClient).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      // Never echo headers/body here — the Authorization header must not leak.
      process.stderr.write(`[ezstat-mcp-http] request error: ${message}\n`);
      if (!res.headersSent) {
        jsonRpcError(res, 500, -32603, "Internal server error");
      } else {
        res.end();
      }
    });
  });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  makeClient: (apiKey: string) => EzStatClient,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  // Health probe for systemd / monitoring — no auth, no MCP.
  if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/health")) {
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({ status: "ok", server: "ezstat-mcp", transport: "streamable-http" }),
    );
    return;
  }

  // Stateless deployment: no server-push SSE stream, no sessions to delete.
  if (req.method === "GET" || req.method === "DELETE") {
    res.setHeader("Allow", "POST");
    jsonRpcError(res, 405, -32000, "Method not allowed. POST MCP JSON-RPC messages to this endpoint.");
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    jsonRpcError(res, 405, -32000, "Method not allowed.");
    return;
  }

  // Per-request, per-tenant wiring: the caller's own key (or the keyless stub).
  const apiKey = bearerKey(req);
  let client: EzStatClient;
  try {
    client = apiKey ? makeClient(apiKey) : makeKeylessClient();
  } catch (err) {
    if (err instanceof EzStatConfigError) {
      client = makeKeylessClient();
    } else {
      throw err;
    }
  }

  const server = buildServer({ client });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no Mcp-Session-Id issued or required
    enableJsonResponse: true, // single JSON response per POST (SSE upgrade still spec-compliant)
  });

  res.on("close", () => {
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
  });

  await server.connect(transport);
  await transport.handleRequest(req, res);
}

async function main(): Promise<void> {
  const portRaw = (process.env.EZSTAT_MCP_HTTP_PORT ?? "").trim();
  const port = portRaw ? parseInt(portRaw, 10) || DEFAULT_HTTP_PORT : DEFAULT_HTTP_PORT;
  const host = (process.env.EZSTAT_MCP_HTTP_HOST ?? "").trim() || DEFAULT_HTTP_HOST;

  const app = createHttpApp();
  await new Promise<void>((resolve, reject) => {
    app.once("error", reject);
    app.listen(port, host, () => resolve());
  });
  process.stderr.write(`[ezstat-mcp-http] listening on http://${host}:${port} (stateless streamable HTTP)\n`);

  const shutdown = (signal: NodeJS.Signals): void => {
    process.stderr.write(`[ezstat-mcp-http] received ${signal}, shutting down\n`);
    app.close(() => process.exit(0));
    // Hard stop if in-flight requests refuse to drain.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[ezstat-mcp-http] fatal: ${message}\n`);
    process.exit(1);
  });
}
