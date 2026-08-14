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

## Check the response BODY, not the status code

This is the one place drop-in compatibility can bite you, so do it on the first write of
the migration rather than after.

Because `/ez`, `/c` and `/v` mirror StatHat's original wire behaviour, a **rejected** write
— a stale key, the wrong key, a quota you have hit — still comes back **HTTP 200**. The
verdict is in the body:

```bash
# The HTTP code is 200 either way. The BODY is the verdict.
curl -s -X POST https://api.ezstat.dev/ez \
  -d "ezkey=YOUR_EZSTAT_KEY" -d "stat=signups" -d "count=1"

# → {"status":200,"msg":"ok"}                   recorded
# → {"status":"error","msg":"invalid ezkey"}    NOT recorded — and still HTTP 200

# Make it fail loudly in a script:
curl -s -X POST https://api.ezstat.dev/ez \
  -d "ezkey=YOUR_EZSTAT_KEY" -d "stat=signups" -d "count=1" \
  | jq -e '.status == 200' >/dev/null || { echo "EzStat DROPPED the point"; exit 1; }
```

StatHat behaved this way and its official client libraries do not read the body, so a
client you did not modify reports those rejections to you as successes — while your charts
keep rendering the history you already have. Nothing looks broken.

**Writing new code instead of reusing a StatHat client?** Send `X-EzStat-Strict: 1` on
`/ez` and every rejection comes back with a real HTTP status (401 bad key, 429 quota, 400
malformed), so ordinary error handling is enough. That is the recommended default for
anything new. Full contract: [ezstat.dev/docs#wire-responses](https://ezstat.dev/docs#wire-responses).

This server does the check for you: `src/ezstat-client.ts` treats a `{"status":"error"}`
body as a failure regardless of the HTTP code, so `track_metric` reports a dropped point as
an error rather than a success.

## Confirm the points are arriving — not just accepted

A 200 tells you the request reached EzStat, not that a point was stored under your account.
After switching a real writer over, prove the round trip:

```bash
curl -fsSL https://ezstat.dev/tools/ezstat-verify.py -o ezstat-verify.py
python3 ezstat-verify.py --key YOUR_EZSTAT_KEY
```

One Python file, standard library only, no `pip install` — read it before you run it. It
writes a known sequence to a single stat, reads it back through the CSV export and the API,
and exits non-zero if the numbers disagree. Exit `0` = every surface reconciles; exit `1` =
they disagree; exit `2` = the run could not complete (no key, network, a 401) and is
deliberately not reported as disagreement. What it proves and what it does not:
[ezstat.dev/docs#verify](https://ezstat.dev/docs#verify).

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
- **No lock-in** — CSV + JSON export any time; anomaly detection and correlations are live; alerts / weekly digest
  are on the roadmap and marked coming-soon until they actually ship.

## The migrator deal

Switching is the risk, so EzStat removes it instead of discounting: see it live before
your first dollar (free tier), a 12-month price-lock from the day you join, white-glove
migration for the first 25 StatHat imports, monthly billing you can cancel anytime.

Details: [ezstat.dev/migrate/stathat](https://ezstat.dev/migrate/stathat) ·
comparison: [ezstat.dev/vs](https://ezstat.dev/vs)
