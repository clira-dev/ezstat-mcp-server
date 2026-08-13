# Pattern: an agent that tracks its own work

Give your coding agent the EzStat MCP server and one instruction:

> After every deploy you perform, call `track_metric` with stat `deploys` (counter).
> After every test run, track `tests.failed` with the failure count.
> When I ask "how are we doing", call `ask_ezstat` with my question.

That's the whole integration. The agent now writes its own ops metrics and answers
questions about them — no SDK, no dashboard clicking, no copy-paste.

Works with Claude Desktop, Claude Code, Cursor, and any MCP-compatible runner.
Get a key at https://ezstat.dev (free tier available — card-gated, no charge).
