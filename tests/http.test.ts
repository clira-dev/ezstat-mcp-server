/**
 * Streamable HTTP transport tests (the hosted-endpoint path).
 *
 * Documented auth policy under test ("optimistic introspection"):
 *   - initialize + tools/list work WITHOUT an API key (discovery is free).
 *   - tools/call WITHOUT a key -> clean in-band MCP tool error (isError: true).
 *   - tools/call with an INVALID key -> clean MCP tool error (EzStat 401 relayed),
 *     never a crash or a non-JSON-RPC response.
 *
 * No real network: the EzStat backend is mocked via the makeClient seam.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { createHttpApp } from "../src/http.js";
import { EzStatClient } from "../src/ezstat-client.js";
import { makeMockFetch, type MockFetchHandle } from "./mock-fetch.js";

const INIT_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test-http-client", version: "0.0.0" },
  },
};

interface RpcEnvelope {
  jsonrpc: string;
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

describe("MCP streamable HTTP transport", () => {
  let app: http.Server;
  let port: number;
  let mock: MockFetchHandle;

  beforeAll(async () => {
    const { deps, mock: m } = makeMockFetch();
    mock = m;
    // Multi-tenant seam: each request's Bearer key builds its own client.
    // The mock backend rejects everything except the key "valid-ezkey".
    app = createHttpApp({
      makeClient: (apiKey: string) => {
        const gatedFetch: NonNullable<typeof deps.fetch> = async (url, init) => {
          if (apiKey !== "valid-ezkey") {
            return {
              ok: false,
              status: 401,
              statusText: "Unauthorized",
              async text() {
                return JSON.stringify({ error: "invalid API key" });
              },
              async json() {
                return { error: "invalid API key" };
              },
            };
          }
          return deps.fetch!(url, init);
        };
        return new EzStatClient(
          {
            apiKey,
            baseUrl: "https://api.ezstat.dev",
            timeoutMs: 5_000,
            ingestPath: "/api/ez",
            queryPath: "/api/v1/query",
            statsListPath: "/api/v1/stats",
          },
          { fetch: gatedFetch },
        );
      },
    });
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    port = (app.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => app.close(() => resolve()));
  });

  async function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  it("serves initialize WITHOUT an API key (discovery is free)", async () => {
    const res = await post(INIT_BODY);
    expect(res.status).toBe(200);
    const rpc = (await res.json()) as RpcEnvelope;
    expect(rpc.error).toBeUndefined();
    const serverInfo = (rpc.result as { serverInfo?: { name?: string; version?: string } }).serverInfo;
    expect(serverInfo?.name).toBe("ezstat");
    expect(serverInfo?.version).toBe("0.8.0");
  });

  it("serves tools/list WITHOUT an API key (all 7 tools visible)", async () => {
    const res = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(res.status).toBe(200);
    const rpc = (await res.json()) as RpcEnvelope;
    expect(rpc.error).toBeUndefined();
    const tools = (rpc.result as { tools: Array<{ name: string }> }).tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "ask_ezstat",
      "create_alert",
      "delete_alert",
      "list_alerts",
      "list_stats",
      "read_stat",
      "track_metric",
    ]);
  });

  it("tool call WITHOUT a key returns a clean in-band MCP error (not a crash)", async () => {
    const res = await post({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_stats", arguments: {} },
    });
    expect(res.status).toBe(200); // JSON-RPC delivered; the error is in-band
    const rpc = (await res.json()) as RpcEnvelope;
    expect(rpc.error).toBeUndefined();
    const result = rpc.result as { isError?: boolean; content: Array<{ type: string; text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Authorization: Bearer");
    expect(result.content[0]?.text).toContain("ezstat.dev");
  });

  it("tool call with an INVALID key returns a clean MCP error relaying the 401", async () => {
    const res = await post(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "list_stats", arguments: {} },
      },
      { authorization: "Bearer definitely-not-a-real-key" },
    );
    expect(res.status).toBe(200);
    const rpc = (await res.json()) as RpcEnvelope;
    expect(rpc.error).toBeUndefined();
    const result = rpc.result as { isError?: boolean; content: Array<{ type: string; text: string }> };
    expect(result.isError).toBe(true);
    // Clean, coded error — and the key itself is never echoed back.
    expect(result.content[0]?.text).toMatch(/unauthorized|401/i);
    expect(result.content[0]?.text).not.toContain("definitely-not-a-real-key");
  });

  it("tool call with a VALID key reaches the (mocked) EzStat backend", async () => {
    mock.configure({
      json: { stats: [{ name: "signups", type: "counter", description: "New signups" }] },
    });
    const res = await post(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "list_stats", arguments: {} },
      },
      { authorization: "Bearer valid-ezkey" },
    );
    expect(res.status).toBe(200);
    const rpc = (await res.json()) as RpcEnvelope;
    const result = rpc.result as { isError?: boolean; content: Array<{ type: string; text: string }> };
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain("signups");
    // The per-request key was forwarded to the EzStat API for THIS tenant.
    const last = mock.lastRequest();
    expect(last?.headers["Authorization"] ?? last?.headers["authorization"]).toContain("valid-ezkey");
  });

  it("GET (non-health) is 405 — stateless deployment has no server-push stream", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: "GET" });
    expect(res.status).toBe(405);
    const rpc = (await res.json()) as RpcEnvelope;
    expect(rpc.error?.message).toContain("POST");
  });

  it("GET /healthz answers 200 without auth", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; transport: string };
    expect(body.status).toBe("ok");
    expect(body.transport).toBe("streamable-http");
  });
});
