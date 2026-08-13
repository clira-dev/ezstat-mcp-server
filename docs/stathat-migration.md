# Migrating from StatHat to EzStat

> **TL;DR** — EzStat ([ezstat.dev](https://ezstat.dev)) speaks StatHat's wire format.
> Change one base URL (`api.stathat.com` → `api.ezstat.dev`), use your EzStat API key,
> and your existing instrumentation keeps working. Stats auto-create on first POST.

## The situation with StatHat

If your calls to `api.stathat.com` stopped working and your dashboards went dark, you are
not alone — the StatHat API is offline / not accepting data. Your instrumentation code,
however, is fine: the EZ / Classic wire format lives on in EzStat as a compatible
implementation of the same `/ez`, `/c`, `/v` endpoints — same params, same response shape.

## The migration (usually one line)

Before:

```bash
curl -X POST https://api.stathat.com/ez \
  -d "stat=messages sent" -d "ezkey=YOUR_KEY" -d "count=1"
```

After:

```bash
curl -X POST https://api.ezstat.dev/ez \
  -d "stat=messages sent" -d "ezkey=YOUR_EZSTAT_KEY" -d "count=1"
```

Most StatHat client libraries (Go, Python, Ruby, Node, Java, …) let you override the base
URL in one line; hardcoded hosts need a find-and-replace:

```bash
grep -rl "api.stathat.com" your-code/ | xargs sed -i 's#api.stathat.com#api.ezstat.dev#g'
```

Counters (`count=N`) and value/gauge stats (`value=X`) both work; stats auto-create on the
first POST, so there is nothing to pre-register. You can backfill historical points by
passing a unix `t` timestamp on ingest.

## Importing your StatHat history

If you saved your StatHat CSV or JSON export before it closed, upload it to the importer
and EzStat recreates each stat and backfills its points within your plan quota
(limits: 8 MB / 500,000 points per file, quota-trimmed). A live token-pull is not possible
because StatHat's API is offline — the export you already downloaded is the source.

## What you get on the other side

- **Live charts in ~30 seconds** — one HTTP POST in, chart out. No SDK, no collector
  daemon, no YAML.
- **Ask-Your-Data (live)** — ask a plain-English question ("which stat spiked this
  week?") and get an answer computed and verified against your own data.
- **MCP-native** — this repo! Your AI agents (Claude, Cursor, any MCP runner) can track
  and query metrics themselves.
- **Flat pricing** — $19 / $49 / $149 per month by tracked stats, every currency shown
  up front. A card-gated free tier exists to see your data live before paying anything.
- **No lock-in** — CSV + JSON export any time; alerts / weekly digest / anomaly detection
  are on the roadmap and marked coming-soon until they actually ship.

## The migrator deal

Switching is the risk, so EzStat removes it instead of discounting: see it live before
your first dollar (free tier), a 12-month price-lock from the day you join, white-glove
migration for the first 25 StatHat imports, monthly billing you can cancel anytime.

Details: [ezstat.dev/migrate/stathat](https://ezstat.dev/migrate/stathat) ·
comparison: [ezstat.dev/vs](https://ezstat.dev/vs)
