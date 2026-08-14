/**
 * Build the MCP server with the four EzStat tools.
 *
 * Tool surface (the model reads each `description` to decide when to call it):
 *   - track_metric  : record a metric point your app "produced".
 *   - ask_ezstat    : ask a natural-language question about your production metrics.
 *   - read_stat     : structured read of a stat (latest / series / summary) for a time range.
 *   - list_stats    : list the account's stats (names + types).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { EzStatClient } from "./ezstat-client.js";
import type { TrackMetricInput } from "./ezstat-client.js";

const STAT_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

const trackMetricSchema = {
  stat: z
    .string()
    .min(1)
    .max(128)
    .describe(
      "Name of the metric to record (e.g. \"page_views\", \"api.latency_ms\", \"checkout.success\"). Allowed chars: letters, numbers, underscores, hyphens, dots. Auto-created on first use.",
    ),
  count: z
    .number()
    .int()
    .positive()
    .max(1_000_000)
    .optional()
    .describe(
      "For COUNTER stats: how much to increment by. Omit (or set with `value`) for a gauge/measurement stat. If both `count` and `value` are omitted, this defaults to +1.",
    ),
  value: z
    .number()
    .finite()
    .optional()
    .describe(
      "For VALUE/gauge stats: the measurement to record (e.g. 42.5 for \"load time ms\"). Omit for a counter increment.",
    ),
  timestamp: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional Unix-seconds timestamp for back-dated datapoints. Omit for \"now\"."),
};

const askSchema = {
  query: z
    .string()
    .min(1)
    .max(2_000)
    .describe(
      "Natural-language question about your metrics. Examples: \"What was my peak request rate yesterday?\", \"Top 5 fastest growing stats this week\", \"Compare signups vs cancellations last 7 days\".",
    ),
};

const readStatSchema = {
  name: z
    .string()
    .min(1)
    .max(128)
    .describe("Exact stat name to read."),
  from: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Unix-seconds lower bound (inclusive). Omit for \"last 24 hours\"."),
  to: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Unix-seconds upper bound (inclusive). Omit for \"now\"."),
  resolution: z
    .enum(["minute", "hour", "day"])
    .optional()
    .describe("Optional rollup resolution. Omit for raw points."),
};

const listStatsSchema = {
  type: z
    .enum(["counter", "value"])
    .optional()
    .describe("Optional filter by stat type (\"counter\" for monotonically increasing, \"value\" for gauges)."),
};

export interface BuildServerDeps {
  client: EzStatClient;
}

/**
 * Build the MCP server with all four tools wired to the supplied EzStat client.
 * Pure factory — does NOT connect any transport. The caller picks the transport
 * (we always use stdio for Claude/Cursor compatibility).
 */
const createAlertSchema = {
  stat: z.string().min(1).max(128).describe("Name of the stat to alert on (as shown by list_stats)."),
  condition_type: z
    .enum(["above", "below", "pct_change", "heartbeat", "missing_data", "sustained"])
    .describe("above/below: value crosses threshold. pct_change: % move over window_minutes. heartbeat/missing_data: no data for window_minutes. sustained: above threshold for consecutive evaluations."),
  threshold: z.number().finite().describe("The boundary value (for heartbeat/missing_data use 0)."),
  window_minutes: z.number().int().positive().max(10080).optional()
    .describe("Staleness window for heartbeat/missing_data, lookback for pct_change (minutes)."),
  webhook_url: z.string().url().max(500)
    .describe("Public HTTPS receiver for the alert payload (private/internal targets are refused). Email delivery is coming soon — webhook/Slack only for now."),
  cooldown_minutes: z.number().int().positive().max(10080).optional()
    .describe("Minimum minutes between repeat fires (default 60)."),
};

const listAlertsSchema = {};

const deleteAlertSchema = {
  alert_id: z.string().min(1).describe("Alert id (as shown by list_alerts)."),
};

export function buildServer(deps: BuildServerDeps): McpServer {
  const { client } = deps;
  const server = new McpServer(
    {
      name: "ezstat",
      version: "0.8.0",
    },
    {
      instructions:
        "EzStat lets an agent push and read production metrics. " +
        "Use `track_metric` to record a counter or gauge your code \"produced\". " +
        "Use `list_stats` to see what exists in this account. " +
        "Use `read_stat` for a structured recent-value/series/summary read of one stat. " +
        "Use `ask_ezstat` for natural-language questions over the account's metrics. " +
        "Use `create_alert`/`list_alerts`/`delete_alert` to get a webhook when a metric crosses a threshold, moves too fast, or goes quiet.",
    },
  );

  server.tool(
    "track_metric",
    "Record a metric point your app \"produced\". Use this whenever the surrounding code emits a counter or gauge — e.g. on a page view, a successful checkout, or a measured latency. Counters are +N (default +1), values are gauges (e.g. 42.5 ms).",
    trackMetricSchema,
    async (args) => {
      try {
        if (!STAT_NAME_PATTERN.test(args.stat)) {
          return errorResult(
            new Error(`Stat name \"${args.stat}\" is invalid: only letters, numbers, underscores, hyphens, or dots are allowed.`),
            "Invalid stat name",
          );
        }
        const input: TrackMetricInput = {
          stat: args.stat,
          count: args.count ?? null,
          value: args.value ?? null,
          timestamp: args.timestamp ?? null,
        };
        const result = await client.trackMetric(input);
        const text =
          result.kind === "counter"
            ? `Recorded counter \"${args.stat}\" (${args.count ?? 1}).`
            : `Recorded value \"${args.stat}\" = ${args.value}.`;
        return okResult(text);
      } catch (err) {
        return errorResult(err, "Failed to track metric");
      }
    },
  );

  server.tool(
    "ask_ezstat",
    "Ask a natural-language question about the account's metrics. This is the agent-read path: send a question like \"what spiked yesterday?\" or \"compare signups vs cancellations last 7 days\" and EzStat returns a grounded answer plus the underlying data it used.",
    askSchema,
    async (args) => {
      try {
        const result = await client.ask(args.query);
        const dataBlock =
          result.data.length > 0
            ? `\n\nData (${result.data.length} rows):\n${JSON.stringify(result.data, null, 2)}`
            : "";
        const meta: string[] = [];
        if (result.intent) meta.push(`intent=${result.intent}`);
        if (result.source) meta.push(`source=${result.source}`);
        if (result.llmUsed) meta.push("llm=on");
        if (result.remainingQueries !== null) meta.push(`remaining=${result.remainingQueries}`);
        const metaLine = meta.length > 0 ? `\n[${meta.join(", ")}]` : "";
        return okResult(`${result.answer}${dataBlock}${metaLine}`);
      } catch (err) {
        return errorResult(err, "EzStat could not answer the question");
      }
    },
  );

  server.tool(
    "read_stat",
    "Read a single stat: latest value, recent series, and basic summary (count/min/max/avg/sum). Use this for a structured read of one metric — prefer `ask_ezstat` for free-form questions over many stats.",
    readStatSchema,
    async (args) => {
      try {
        const result = await client.readStat({
          name: args.name,
          from: args.from,
          to: args.to,
          resolution: args.resolution,
        });
        const lines: string[] = [];
        lines.push(`Stat: ${result.name}${result.type ? ` (${result.type})` : ""}`);
        if (result.description) lines.push(`Description: ${result.description}`);
        if (result.summary) {
          const s = result.summary;
          lines.push(
            `Summary: count=${s.count ?? "n/a"}, min=${s.min ?? "n/a"}, max=${s.max ?? "n/a"}, avg=${s.avg ?? "n/a"}, sum=${s.sum ?? "n/a"}${s.truncated ? " (truncated)" : ""}`,
          );
        }
        lines.push(`Points returned: ${result.dataPoints.length}`);
        if (result.dataPoints.length > 0) {
          const preview = result.dataPoints.slice(-10);
          lines.push("Last points (t=unix seconds, v=value):");
          for (const p of preview) {
            lines.push(`  t=${p.t} v=${p.v}`);
          }
          if (result.dataPoints.length > preview.length) {
            lines.push(`  ... (${result.dataPoints.length - preview.length} earlier points omitted)`);
          }
        }
        return okResult(lines.join("\n"));
      } catch (err) {
        return errorResult(err, `Failed to read stat \"${args.name}\"`);
      }
    },
  );

  server.tool(
    "list_stats",
    "List the account's metrics — names and types. Call this first when you don't know what stats exist in the account.",
    listStatsSchema,
    async (args) => {
      try {
        let stats = await client.listStats();
        if (args.type) {
          stats = stats.filter((s) => s.type === args.type);
        }
        if (stats.length === 0) {
          return okResult(
            args.type
              ? `No stats of type \"${args.type}\" found in this account.`
              : "No stats found in this account yet. Use `track_metric` to create one.",
          );
        }
        const lines = stats.map((s) => {
          const desc = s.description ? ` — ${s.description}` : "";
          return `- ${s.name} (${s.type})${desc}`;
        });
        return okResult(`${stats.length} stat${stats.length === 1 ? "" : "s"}:\n${lines.join("\n")}`);
      } catch (err) {
        return errorResult(err, "Failed to list stats");
      }
    },
  );

  server.tool(
    "create_alert",
    "Create an alert on a stat: webhook fires when the condition is met (above/below threshold, % change, heartbeat/missing data, sustained). Deliveries retry with backoff and carry a stable idempotency_key so receivers can dedup. The stat is referenced by NAME; it must already exist.",
    createAlertSchema,
    async (args) => {
      try {
        const stats = await client.listStats();
        const match = stats.find((st) => st.name === args.stat);
        if (!match || !match.id) {
          return errorResult(
            new Error(`No stat named "${args.stat}" in this account. Use list_stats to see what exists.`),
            "Unknown stat",
          );
        }
        const alert = await client.createAlert({
          stat_id: match.id,
          condition_type: args.condition_type,
          threshold: args.threshold,
          window_minutes: args.window_minutes,
          channel: "webhook",
          channel_config: { webhook_url: args.webhook_url },
          cooldown_minutes: args.cooldown_minutes,
        });
        return okResult(
          `Alert created (id ${alert.id}): "${args.stat}" ${args.condition_type} ${args.threshold} -> webhook. It is evaluated about every 2 minutes.`,
        );
      } catch (err) {
        return errorResult(err, "Failed to create alert");
      }
    },
  );

  server.tool(
    "list_alerts",
    "List the account's alerts: id, stat, condition, channel, enabled, last trigger time.",
    listAlertsSchema,
    async () => {
      try {
        const alerts = await client.listAlerts();
        if (alerts.length === 0) return okResult("No alerts configured.");
        const lines = alerts.map((a) =>
          `${a.id} | ${a.stat_name ?? a.stat_id ?? "?"} | ${a.condition_type ?? "?"} ${a.threshold ?? ""} | ${a.channel ?? "?"} | ${a.enabled ? "enabled" : "disabled"} | last: ${a.last_triggered_at ?? "never"}`,
        );
        return okResult(`Alerts (${alerts.length}):\n${lines.join("\n")}`);
      } catch (err) {
        return errorResult(err, "Failed to list alerts");
      }
    },
  );

  server.tool(
    "delete_alert",
    "Delete an alert by id (see list_alerts).",
    deleteAlertSchema,
    async (args) => {
      try {
        await client.deleteAlert(args.alert_id);
        return okResult(`Alert ${args.alert_id} deleted.`);
      } catch (err) {
        return errorResult(err, "Failed to delete alert");
      }
    },
  );

  return server;
}

/**
 * Turn an error into a structured MCP tool result. The MESSAGE is safe to relay
 * to the user; we never echo the API key or internal transport detail.
 */
function errorResult(err: unknown, prefix: string): CallToolResult {
  if (err instanceof Error && "shape" in err) {
    const shape = (err as { shape: { code: string; status: number; message: string } }).shape;
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `${prefix}: ${shape.message} [code=${shape.code}${shape.status ? `, http=${shape.status}` : ""}]`,
        },
      ],
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `${prefix}: ${message}`,
      },
    ],
  };
}

function okResult(text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
  };
}
