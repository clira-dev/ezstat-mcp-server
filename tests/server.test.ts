import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { EzStatClient } from "../src/ezstat-client.js";
import { makeMockFetch } from "./mock-fetch.js";

describe("MCP server — tools list", () => {
  let mock: ReturnType<typeof makeMockFetch>["mock"];
  let client: Client;

  beforeEach(async () => {
    const { deps, mock: m } = makeMockFetch();
    mock = m;
    const ezClient = new EzStatClient(
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

  it("lists exactly the 7 EzStat tools", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
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

  it("every tool has a non-empty description and a typed inputSchema", async () => {
    const result = await client.listTools();
    for (const t of result.tools) {
      expect(t.description, `tool ${t.name} missing description`).toBeTruthy();
      expect(t.inputSchema.type, `tool ${t.name} bad schema type`).toBe("object");
      expect(t.inputSchema.properties, `tool ${t.name} missing properties`).toBeDefined();
    }
  });

  it("tool schemas declare the expected properties", async () => {
    const result = await client.listTools();
    const byName: Record<string, (typeof result.tools)[number]> = Object.fromEntries(
      result.tools.map((t) => [t.name, t]),
    );

    const props = (toolName: string): string[] => {
      const t = byName[toolName];
      if (!t) throw new Error(`missing tool ${toolName}`);
      const schema = t.inputSchema as { properties?: Record<string, unknown> };
      return Object.keys(schema.properties ?? {});
    };

    expect(props("track_metric").sort()).toEqual(["count", "stat", "timestamp", "value"].sort());
    expect(props("ask_ezstat").sort()).toEqual(["query"]);
    expect(props("read_stat").sort()).toEqual(["from", "name", "resolution", "to"].sort());
    expect(props("list_stats").sort()).toEqual(["type"]);
  });
});
