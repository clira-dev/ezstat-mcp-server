#!/usr/bin/env node
/**
 * EzStat MCP server entry point.
 *
 * Transport: stdio (the standard for Claude Desktop / Claude Code / Cursor).
 * Reads config from environment, builds the server, connects stdio, and waits
 * for the parent process (the AI client) to drive the JSON-RPC conversation.
 *
 * Logs go to STDERR (stdout is reserved for the MCP protocol).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { EzStatClient } from "./ezstat-client.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[ezstat-mcp] ${message}\n`);
    process.exit(2);
  }

  const client = new EzStatClient(config);
  const server = buildServer({ client });
  const transport = new StdioServerTransport();

  try {
    await server.connect(transport);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[ezstat-mcp] failed to start stdio transport: ${message}\n`);
    process.exit(1);
  }

  // Graceful shutdown — close the transport on SIGINT/SIGTERM so the parent
  // process gets a clean EOF on stdout.
  const shutdown = (signal: NodeJS.Signals): void => {
    process.stderr.write(`[ezstat-mcp] received ${signal}, shutting down\n`);
    server.close().catch(() => undefined).finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[ezstat-mcp] fatal: ${message}\n`);
  process.exit(1);
});
