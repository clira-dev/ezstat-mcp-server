# EzStat MCP Server

A standalone [Model Context Protocol](https://modelcontextprotocol.io) server for
[EzStat](https://ezstat.dev). Let Claude / Cursor / any MCP-compatible agent **push and read your
metrics natively** — no copy-paste, no dashboard hop. This is the product behind the
"metrics your agents write and read themselves" positioning: every agent that touches your
code can also touch your observability.

The server speaks **stdio** (the standard transport for local agent runners) and exposes
four focused tools. Each tool description is written for an agent audience so the model
knows when to call it.

## Tools

| Tool           | What it does                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `track_metric` | Record a metric point your app "produced" — counter (+N, default +1) or gauge (e.g. 42.5 ms).      |
| `ask_ezstat`   | Ask a natural-language question about your metrics (the agent-read path).                         |
| `read_stat`    | Structured read of a stat: latest value + series + summary (count/min/max/avg/sum) for a window.   |
| `list_stats`   | List the account's metrics (names + types + description).                                         |

Tool descriptions are tuned for agent reasoning — see `src/server.ts`.

## Install (Claude Desktop / Claude Code / Cursor)

### One-line install (npm/pnpm)

```bash
# pnpm
pnpm add -g ezstat-mcp-server

# npm
npm install -g ezstat-mcp-server
```

### Configure the MCP client

**Claude Desktop** (`~/.config/Claude/claude_desktop_config.json` on macOS/Linux,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "ezstat": {
      "command": "ezstat-mcp-server",
      "env": {
        "EZSTAT_API_KEY": "ezkey_your_api_key_here"
      }
    }
  }
}
```

**Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "ezstat": {
      "command": "ezstat-mcp-server",
      "env": {
        "EZSTAT_API_KEY": "ezkey_your_api_key_here"
      }
    }
  }
}
```

Get your API key from <https://ezstat.dev> (it's the "ezkey").

### Smithery

```bash
npx -y @smithery/cli install ezstat-mcp-server --client claude
```

Or visit <https://smithery.ai/server/ezstat-mcp-server> and click **Install**.

## About EzStat

[EzStat](https://ezstat.dev) is a dead-simple hosted metrics service: **one HTTP POST in,
a live chart out**. No SDK, no collector daemon, no YAML, no dashboard builder. Counters
and value/gauge stats auto-create on first POST; charts, share/embed, and CSV/JSON export
are built in, and **Ask-Your-Data** (live) answers plain-English questions from your own
metrics, with every number verified against the retrieved data before it reaches you.

Flat monthly pricing by tracked stats — **$19 / $49 / $149** — plus a card-gated free tier
(no charge; see your data live before paying). Your data is yours: export any time, cancel
any time. Features that are not shipped yet (alerts, weekly digest, anomaly detection) are
marked *coming soon* on the site rather than sold — what you see live is what works.

### Coming from StatHat?

If your `api.stathat.com` calls stopped and your dashboards went dark: EzStat speaks
**StatHat's wire format** — the same `/ez`, `/c`, `/v` endpoints, same params, same
response. The migration is usually one line:

```bash
# before
curl -X POST https://api.stathat.com/ez -d "stat=messages sent" -d "ezkey=KEY" -d "count=1"
# after — change the host, use your EzStat key; stats auto-create
curl -X POST https://api.ezstat.dev/ez -d "stat=messages sent" -d "ezkey=EZSTAT_KEY" -d "count=1"
```

Most StatHat client libraries take a base-URL override in one line. Saved a StatHat
CSV/JSON export? The importer recreates your stats and backfills history (8 MB / 500k
points per file). Full guide: [docs/stathat-migration.md](docs/stathat-migration.md) ·
[ezstat.dev/migrate/stathat](https://ezstat.dev/migrate/stathat) — including the migrator
deal: free tier to see it live first, a 12-month price-lock, and white-glove import for
the first 25 migrations.

### Why agent-native metrics

Your coding agent deploys, tests, and ships — it should also be the one tracking and
reading the numbers. That's this server: metrics your agents write and read themselves.
The reasoning: [docs/agent-native-metrics.md](docs/agent-native-metrics.md) · comparison
with StatHat/StatFlow/Datadog: [ezstat.dev/vs](https://ezstat.dev/vs).

## Environment variables

| Variable               | Required | Default                       | Notes                                                          |
| ---------------------- | -------- | ----------------------------- | -------------------------------------------------------------- |
| `EZSTAT_API_KEY`       | **yes**  | —                             | Your EzStat API key (the "ezkey"). Never hardcode. Never log. |
| `EZSTAT_BASE_URL`      | no       | `https://api.ezstat.dev`      | Override for staging / self-hosted.                            |
| `EZSTAT_TIMEOUT_MS`    | no       | `10000`                       | Per-request timeout in milliseconds.                           |
| `EZSTAT_INGEST_PATH`   | no       | `/api/ez`                     | Override if you proxy the EZ endpoint.                         |
| `EZSTAT_QUERY_PATH`    | no       | `/api/v1/query`               | Ask-Your-Data path.                                            |
| `EZSTAT_STATS_LIST_PATH` | no     | `/api/v1/stats`               | Stats list path.                                               |

A starter `.env.example` is shipped.

## How it talks to EzStat

The four tools map to four real EzStat API routes (all auth by EzStat API key):

| Tool           | Method | Path                       | Auth                                  |
| -------------- | ------ | -------------------------- | ------------------------------------- |
| `track_metric` | POST   | `/api/ez`                  | `ezkey` in JSON body                  |
| `ask_ezstat`   | POST   | `/api/v1/query`            | `Authorization: Bearer <ezkey>`       |
| `read_stat`    | GET    | `/api/v1/stats/:name`      | `Authorization: Bearer <ezkey>`       |
| `list_stats`   | GET    | `/api/v1/stats`            | `Authorization: Bearer <ezkey>`       |

- `track_metric` calls the StatHat-compatible EZ ingest (`{"ezkey","stat","count"?,"value"?,"t"?}`).
  Counter semantics: omit both `count` and `value` to record `count=1` (counter +1).
- `ask_ezstat` calls Ask-Your-Data (`{"query":"..."}` → `{answer, data, intent, ...}`).
  This is the agent read path — count it as an agent read for usage tracking.
- `read_stat` returns the stat's recent series + summary; pass `from`/`to` (Unix seconds) to
  bound the window. `resolution` rolls up to `minute`/`hour`/`day`.
- `list_stats` returns the account's stats; pass `type` to filter to `counter` or `value`.

## Build & run locally

```bash
pnpm install
pnpm build       # tsc → dist/
pnpm start       # node dist/index.js  (stdio MCP server)
pnpm test        # vitest run  — fully mocked network, no real HTTP
pnpm dev         # tsx watch src/index.ts
```

`pnpm start` requires `EZSTAT_API_KEY` to be set; the server exits with a clear error
otherwise (and never logs the key).

## Security

- The API key is read **only** from `EZSTAT_API_KEY` — never hardcoded, never printed.
- All error messages are scrubbed: the API key is never included in tool results.
- HTTP errors carry a stable machine-readable `code` (`unauthorized`, `rate_limited`,
  `timeout`, `not_found`, `server_error`, ...) and a human-readable `message` safe to relay.
- Tests mock the network — no real HTTP leaves the test process.

## Registry metadata

For Smithery / mcp.so / Glama listings:

- **Name**: `ezstat-mcp-server`
- **Display name**: EzStat
- **Description**: Push and read metrics with EzStat from any AI agent. Track counters and
  values, then ask natural-language questions over your production telemetry.
- **Homepage**: <https://ezstat.dev>
- **Version**: `0.6.0`
- **Transport**: `stdio`
- **License**: MIT
- **Repository**: this package's source

The `mcp` block in `package.json` carries the same metadata so registry crawlers pick it up.

## Listing steps (what to submit, where)

1. **Smithery**: push the repo to GitHub, then run
   `npx -y @smithery/cli publish` (or submit via the web UI). The shipped
   `smithery.yaml` provides the install schema.
2. **mcp.so**: submit at <https://mcp.so/submit> with the metadata above + the GitHub URL.
3. **Glama**: submit at <https://glama.ai/mcp/submit>.

The package is **not** published to npm automatically — publish manually after a release
review.

## License

MIT.
