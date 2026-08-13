# Agent-native metrics: why your AI agents should own observability

Classic metrics workflows assume a human in the loop: a developer instruments code, a
human opens a dashboard, a human notices the spike. In an AI-agent development loop, that
model breaks — the agent deploys, the agent tests, and the agent is the one who should
notice the spike.

The [Model Context Protocol](https://modelcontextprotocol.io) makes the fix trivial: give
the agent a metrics tool. This server exposes EzStat to any MCP runner in four verbs:

| verb | what the agent does with it |
| --- | --- |
| `track_metric` | "I deployed → `deploys` +1"; "test run finished → `tests.failed` = 3" |
| `ask_ezstat` | "Which of my services degraded this week?" — plain English, answered from real data |
| `read_stat` | structured series/summary reads for the agent's own reasoning |
| `list_stats` | discover what's already being tracked before inventing a new name |

The ingest side stays trivially simple on purpose — one HTTP POST, StatHat-compatible
wire format, stats auto-create — so an agent (or a human) can start tracking from any
language, script, or CI job without an SDK.

Pattern write-up: [`examples/agent-selftracking.md`](../examples/agent-selftracking.md) ·
Product: [ezstat.dev](https://ezstat.dev)
