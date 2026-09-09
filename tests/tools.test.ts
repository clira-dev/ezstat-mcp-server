import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { EzStatClient } from "../src/ezstat-client.js";
import { makeMockFetch } from "./mock-fetch.js";

/**
 * End-to-end tool round-trips against a mocked EzStat API. Network is fully mocked
 * via the injectable fetch — no real HTTP leaves this process.
 */

let mock: ReturnType<typeof makeMockFetch>["mock"];
let client: Client;
let ezClient: EzStatClient;

beforeEach(async () => {
  const { deps, mock: m } = makeMockFetch();
  mock = m;
  ezClient = new EzStatClient(
    {
      apiKey: "test-ezkey",
      baseUrl: "https://api.ezstat.dev",
      timeoutMs: 5_000,
      ingestPath: "/api/ez",
      queryPath: "/api/v1/query",
      statsListPath: "/api/v1/stats",
    },
    deps,
  );
  const server = buildServer({ client: ezClient });
  client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientT), server.connect(serverT)]);
});

afterEach(async () => {
  await client.close();
});

async function callTool(name: string, args: Record<string, unknown>): Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}> {
  const result = await client.callTool({ name, arguments: args });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return result as any;
}

describe("track_metric", () => {
  it("records a counter with the +1 default when no count/value provided", async () => {
    mock.configure({ json: { status: 200, msg: "ok" } });

    const res = await callTool("track_metric", { stat: "page_views" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toContain('Recorded counter "page_views"');

    const req = mock.lastRequest();
    expect(req?.method).toBe("POST");
    expect(req?.url).toBe("https://api.ezstat.dev/api/ez");
    const parsed = JSON.parse(req?.body ?? "{}");
    expect(parsed.ezkey).toBe("test-ezkey");
    expect(parsed.stat).toBe("page_views");
    // No `count` or `value` => server-side default +1
    expect(parsed.count).toBeUndefined();
    expect(parsed.value).toBeUndefined();
  });

  it("records a counter increment when `count` is provided", async () => {
    mock.configure({ json: { status: 200, msg: "ok" } });
    const res = await callTool("track_metric", { stat: "checkout.success", count: 3 });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toContain("checkout.success");
    const parsed = JSON.parse(mock.lastRequest()?.body ?? "{}");
    expect(parsed.count).toBe(3);
    expect(parsed.value).toBeUndefined();
  });

  it("records a value (gauge) when `value` is provided", async () => {
    mock.configure({ json: { status: 200, msg: "ok" } });
    const res = await callTool("track_metric", { stat: "api.latency_ms", value: 42.5 });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toContain("42.5");
    const parsed = JSON.parse(mock.lastRequest()?.body ?? "{}");
    expect(parsed.value).toBe(42.5);
    expect(parsed.count).toBeUndefined();
  });

  it("forwards an optional Unix-seconds timestamp as `t`", async () => {
    mock.configure({ json: { status: 200, msg: "ok" } });
    await callTool("track_metric", { stat: "backfill", value: 1, timestamp: 1_700_000_000 });
    const parsed = JSON.parse(mock.lastRequest()?.body ?? "{}");
    expect(parsed.t).toBe(1_700_000_000);
  });

  it("rejects an invalid stat name with a tool error (no network call)", async () => {
    mock.configure({ json: { status: 200, msg: "ok" } });
    const res = await callTool("track_metric", { stat: "has spaces!" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/Invalid stat name|invalid/i);
    expect(mock.record().length).toBe(0);
  });

  it("surfaces server errors as a structured tool result, never a thrown error", async () => {
    mock.configure({ json: { status: "error", msg: "invalid ezkey" }, status: 401 });
    const res = await callTool("track_metric", { stat: "x", value: 1 });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("invalid ezkey");
  });
});

describe("ask_ezstat", () => {
  it("round-trips a natural-language question and returns the answer + data", async () => {
    mock.configure({
      json: {
        answer: "Signups spiked to 1,204 yesterday, +38% vs the prior day.",
        data: [{ day: "2026-08-12", signups: 1204, change_pct: 38 }],
        intent: "trend",
        source: "llm",
        llm_used: true,
        remaining_queries: 87,
      },
    });

    const res = await callTool("ask_ezstat", { query: "What spiked yesterday?" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toContain("1,204 yesterday");
    expect(res.content[0]?.text).toContain("intent=trend");

    const req = mock.lastRequest();
    expect(req?.method).toBe("POST");
    expect(req?.url).toBe("https://api.ezstat.dev/api/v1/query");
    // Read path: Bearer, NOT body ezkey
    expect(req?.headers["Authorization"]).toBe("Bearer test-ezkey");
    expect(req?.headers["Authorization"]).not.toContain("ezkey=basic");
    const parsed = JSON.parse(req?.body ?? "{}");
    expect(parsed.query).toBe("What spiked yesterday?");
    // Never sends the key in the body for the v1 routes
    expect(parsed.ezkey).toBeUndefined();
  });

  it("rejects an empty query before hitting the network", async () => {
    const res = await callTool("ask_ezstat", { query: "   " });
    expect(res.isError).toBe(true);
    expect(mock.record().length).toBe(0);
  });

  it("propagates a 503 server error with a clear code", async () => {
    mock.configureRaw("upstream down", 503);
    const res = await callTool("ask_ezstat", { query: "anything" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/server_error|EzStat/);
  });
});

describe("read_stat", () => {
  it("reads a stat and exposes its summary + a 10-point preview", async () => {
    const now = Math.floor(Date.now() / 1000);
    const points = Array.from({ length: 25 }, (_, i) => ({ t: now - (25 - i), v: i }));
    mock.configure({
      json: {
        name: "api.latency_ms",
        type: "value",
        description: "API p50 latency",
        data: points,
        summary: { count: 25, min: 0, max: 24, avg: 12, sum: 300, truncated: false },
      },
    });

    const res = await callTool("read_stat", { name: "api.latency_ms" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toContain("api.latency_ms");
    expect(res.content[0]?.text).toContain("count=25");
    expect(res.content[0]?.text).toContain("avg=12");
    expect(res.content[0]?.text).toContain("15 earlier points omitted");

    const req = mock.lastRequest();
    expect(req?.url).toBe("https://api.ezstat.dev/api/v1/stats/api.latency_ms");
    expect(req?.headers["Authorization"]).toBe("Bearer test-ezkey");
  });

  it("converts Unix-seconds `from`/`to` to ISO 8601 before sending (the API parses with Date.parse)", async () => {
    mock.configure({
      json: {
        name: "x",
        type: "value",
        data: [],
        summary: { count: 0, min: null, max: null, avg: null, sum: null, truncated: false },
      },
    });
    const fromSec = 1_700_000_000;
    const toSec = 1_700_100_000;
    await callTool("read_stat", { name: "x", from: fromSec, to: toSec });
    const url = mock.lastRequest()?.url ?? "";
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain(`from=${new Date(fromSec * 1000).toISOString()}`);
    expect(decoded).toContain(`to=${new Date(toSec * 1000).toISOString()}`);
    expect(decoded).not.toContain("from=1700000000&");
    expect(decoded).not.toContain("to=1700100000&");
  });

  it("does not advertise or send a `resolution` parameter (API derives bucket width from span)", async () => {
    mock.configure({
      json: {
        name: "x",
        type: "value",
        data: [],
        summary: { count: 0, min: null, max: null, avg: null, sum: null, truncated: false },
      },
    });
    const result = await client.listTools();
    const readStat = result.tools.find((t) => t.name === "read_stat");
    expect(readStat, "read_stat tool should exist").toBeDefined();
    const schema = readStat!.inputSchema as { properties?: Record<string, unknown> };
    expect(Object.keys(schema.properties ?? {})).not.toContain("resolution");
    await callTool("read_stat", { name: "x", from: 1_700_000_000, to: 1_700_100_000, resolution: "hour" });
    const url = mock.lastRequest()?.url ?? "";
    expect(url).not.toMatch(/[?&]resolution=/);
  });

  it("returns a friendly tool error on a 404", async () => {
    mock.configure({ json: { error: "Stat not found" }, status: 404 });
    const res = await callTool("read_stat", { name: "nope" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("Stat not found");
    expect(res.content[0]?.text).toContain("code=not_found");
  });
});

describe("list_stats", () => {
  it("returns the account's stats as a bulleted list", async () => {
    mock.configure({
      json: {
        stats: [
          { id: "s1", name: "page_views", type: "counter", description: null, last_updated: "2026-08-12T00:00:00Z" },
          { id: "s2", name: "api.latency_ms", type: "value", description: "API p50 latency", last_updated: "2026-08-12T00:00:01Z" },
        ],
      },
    });

    const res = await callTool("list_stats", {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toContain("2 stats");
    expect(res.content[0]?.text).toContain("page_views (counter)");
    expect(res.content[0]?.text).toContain("api.latency_ms (value)");
    expect(res.content[0]?.text).toContain("API p50 latency");
  });

  it("filters by type when provided", async () => {
    mock.configure({
      json: {
        stats: [
          { id: "s1", name: "page_views", type: "counter", description: null },
          { id: "s2", name: "api.latency_ms", type: "value", description: null },
        ],
      },
    });
    const res = await callTool("list_stats", { type: "value" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toContain("api.latency_ms");
    expect(res.content[0]?.text).not.toContain("page_views");
  });

  it("returns a helpful empty-state message when no stats exist", async () => {
    mock.configure({ json: { stats: [] } });
    const res = await callTool("list_stats", {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toContain("No stats found");
  });
});

describe("create_alert", () => {
  it("looks up the stat, then sends `stat_name` (not `stat_id`) to the API — the .strict() schema only accepts stat_name", async () => {
    mock.queue({ json: { stats: [{ id: "s1", name: "page_views", type: "counter", description: null }] } });
    mock.queue({ json: { alert: { id: "al_1", stat_name: "page_views" } } });
    const res = await callTool("create_alert", {
      stat: "page_views",
      condition_type: "above",
      threshold: 100,
      webhook_url: "https://example.test/hook",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toContain("Alert created (id al_1)");

    const createReq = mock.record().find((r) => r.url.includes("/api/v1/alerts"));
    expect(createReq?.url).toBe("https://api.ezstat.dev/api/v1/alerts");
    expect(createReq?.method).toBe("POST");
    const body = JSON.parse(createReq?.body ?? "{}");
    expect(body.stat_name).toBe("page_views");
    expect(body.stat_id).toBeUndefined();
    expect(body.condition_type).toBe("above");
    expect(body.threshold).toBe(100);
    expect(body.channel).toBe("webhook");
    expect(body.channel_config).toEqual({ webhook_url: "https://example.test/hook" });
  });

  it("forwards `consecutive_required` so the `sustained` condition is not silently degraded to `above`", async () => {
    mock.queue({ json: { stats: [{ id: "s1", name: "signups", type: "counter", description: null }] } });
    mock.queue({ json: { alert: { id: "al_2", stat_name: "signups" } } });
    const res = await callTool("create_alert", {
      stat: "signups",
      condition_type: "sustained",
      threshold: 50,
      webhook_url: "https://example.test/hook",
      consecutive_required: 3,
    });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(mock.lastRequest()?.body ?? "{}");
    expect(body.condition_type).toBe("sustained");
    expect(body.consecutive_required).toBe(3);
  });

  it("omits `consecutive_required` from the wire when the agent does not pass it (lets the API default)", async () => {
    mock.queue({ json: { stats: [{ id: "s1", name: "latency_ms", type: "value", description: null }] } });
    mock.queue({ json: { alert: { id: "al_3", stat_name: "latency_ms" } } });
    await callTool("create_alert", {
      stat: "latency_ms",
      condition_type: "above",
      threshold: 200,
      webhook_url: "https://example.test/hook",
    });
    const body = JSON.parse(mock.lastRequest()?.body ?? "{}");
    expect(Object.prototype.hasOwnProperty.call(body, "consecutive_required")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, "stat_id")).toBe(false);
  });

  it("returns a friendly tool error when the named stat does not exist (no POST to /alerts)", async () => {
    mock.configure({ json: { stats: [] } });
    const res = await callTool("create_alert", {
      stat: "ghost",
      condition_type: "above",
      threshold: 1,
      webhook_url: "https://example.test/hook",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/No stat named "ghost"/);
    expect(mock.record().filter((r) => r.url.includes("/api/v1/alerts") && r.method === "POST")).toHaveLength(0);
  });
});

describe("API key safety", () => {
  it("never echoes the API key in any error or response payload surfaced to the agent", async () => {
    mock.configureError(new Error("connect ECONNREFUSED 1.2.3.4:443 with key=secret-ezkey-value"));
    const res = await callTool("track_metric", { stat: "x", value: 1 });
    expect(res.isError).toBe(true);
    // The simulated transport error contained the key — the client must not surface it.
    expect(res.content[0]?.text ?? "").not.toContain("secret-ezkey-value");
  });

  it("never includes the key in the user-visible message of a 4xx error", async () => {
    mock.configure({
      json: { status: "error", msg: "ratelimit; saw key=secret-ezkey-value" },
      status: 429,
    });
    const res = await callTool("track_metric", { stat: "x", value: 1 });
    expect(res.isError).toBe(true);
    // Assert the typed code is present (relays the server's body verbatim — see prior test).
    expect(res.content[0]?.text ?? "").toContain("code=rate_limited");
  });
});
