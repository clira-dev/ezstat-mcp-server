/**
 * Runtime configuration for the EzStat MCP server.
 *
 * Source of truth for the EzStat API key ("ezkey") is the environment variable
 * `EZSTAT_API_KEY` — the value is NEVER hardcoded, never logged, never printed,
 * and never included in error messages returned to the agent.
 */

export interface EzStatConfig {
  /** API key used as `ezkey` for ingest and as `Authorization: Bearer` for read paths. */
  readonly apiKey: string;
  /** Base URL without trailing slash. */
  readonly baseUrl: string;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Path for the EZ ingest endpoint. Defaults to /api/ez. */
  readonly ingestPath: string;
  /** Path for Ask-Your-Data. Defaults to /api/v1/query. */
  readonly queryPath: string;
  /** Path for listing stats. Defaults to /api/v1/stats. */
  readonly statsListPath: string;
}

export const DEFAULT_BASE_URL = "https://api.ezstat.dev";
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_INGEST_PATH = "/api/ez";
export const DEFAULT_QUERY_PATH = "/api/v1/query";
export const DEFAULT_STATS_LIST_PATH = "/api/v1/stats";

/** Strip a trailing slash so we can safely concatenate paths. */
function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Resolve config from environment. Throws a clear error if the API key is missing —
 * the message is generic (never echoes the key, even if the user set it).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): EzStatConfig {
  const apiKey = (env.EZSTAT_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new EzStatConfigError(
      "EZSTAT_API_KEY is not set. Set it to your EzStat API key (the ezkey) from https://ezstat.dev.",
    );
  }

  const baseUrl = stripTrailingSlash(
    (env.EZSTAT_BASE_URL ?? DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL,
  );

  const timeoutRaw = (env.EZSTAT_TIMEOUT_MS ?? "").trim();
  const timeoutMs = timeoutRaw ? Math.max(1_000, parseInt(timeoutRaw, 10) || DEFAULT_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;

  return {
    apiKey,
    baseUrl,
    timeoutMs,
    ingestPath: (env.EZSTAT_INGEST_PATH ?? DEFAULT_INGEST_PATH).trim() || DEFAULT_INGEST_PATH,
    queryPath: (env.EZSTAT_QUERY_PATH ?? DEFAULT_QUERY_PATH).trim() || DEFAULT_QUERY_PATH,
    statsListPath: (env.EZSTAT_STATS_LIST_PATH ?? DEFAULT_STATS_LIST_PATH).trim() || DEFAULT_STATS_LIST_PATH,
  };
}

/** Distinct error type so callers can branch on configuration problems. */
export class EzStatConfigError extends Error {
  override readonly name = "EzStatConfigError";
  constructor(message: string) {
    super(message);
  }
}
