/**
 * Typed EzStat HTTP client.
 *
 * - `fetchJson` is the only place that talks HTTP — everything else (tools) builds on top.
 * - All errors are typed (`EzStatApiError`, `EzStatHttpError`, `EzStatTimeoutError`).
 * - No error message includes the API key. Internal errors are wrapped; the agent receives
 *   a safe, descriptive message it can show the user without leaking credentials.
 * - AbortController-driven timeouts are wired into every request.
 */

import type { EzStatConfig } from "./config.js";

export interface EzStatErrorShape {
  /** HTTP status code if available (0 for network/abort). */
  status: number;
  /** Stable machine-readable code so tools / agents can branch. */
  code: string;
  /** Human-readable message safe to surface to the user. Never includes the API key. */
  message: string;
  /** Underlying transport / parse detail, NOT included in the user-facing message. */
  cause?: string;
}

export class EzStatApiError extends Error {
  override readonly name = "EzStatApiError";
  public readonly shape: EzStatErrorShape;
  constructor(shape: EzStatErrorShape) {
    super(shape.message);
    this.shape = shape;
  }
  toJSON(): EzStatErrorShape {
    return { ...this.shape };
  }
}

/** Detect a minimal fetch implementation without depending on Node's typings too tightly. */
type MinimalFetch = (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

/** Injectable fetch + URL encoder seam for tests. */
export interface EzStatClientDeps {
  fetch?: MinimalFetch;
  /** Stringify a params object. Defaults to URLSearchParams. */
  encodeQuery?: (params: Record<string, string | number | undefined | null>) => string;
}

export class EzStatClient {
  private readonly config: EzStatConfig;
  private readonly fetch: MinimalFetch;
  private readonly encodeQuery: (params: Record<string, string | number | undefined | null>) => string;

  constructor(config: EzStatConfig, deps: EzStatClientDeps = {}) {
    this.config = config;
    this.fetch =
      deps.fetch ?? (globalThis.fetch as unknown as MinimalFetch);
    this.encodeQuery =
      deps.encodeQuery ??
      ((params) => {
        const usp = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) {
          if (v === undefined || v === null) continue;
          usp.set(k, String(v));
        }
        return usp.toString();
      });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Public API methods — each maps to one tool.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Track a metric point (StatHat-compatible EZ ingest).
   *
   * - `stat` is required.
   * - Exactly one of `count` (counter) or `value` (gauge) should be provided.
   *   If neither is provided, the API interprets it as `count=1` (counter +1).
   * - Returns `{ok: true, kind: "counter"|"value"}` on success.
   */
  async trackMetric(input: TrackMetricInput): Promise<TrackMetricResult> {
    if (!input.stat || !input.stat.trim()) {
      throw new EzStatApiError({
        status: 0,
        code: "invalid_input",
        message: "track_metric requires a non-empty `stat` name.",
      });
    }
    const body: Record<string, unknown> = {
      ezkey: this.config.apiKey,
      stat: input.stat,
    };
    if (input.count !== undefined && input.count !== null) body.count = input.count;
    if (input.value !== undefined && input.value !== null) body.value = input.value;
    if (input.timestamp !== undefined && input.timestamp !== null) body.t = input.timestamp;

    const hasCount = input.count !== undefined && input.count !== null;
    const hasValue = input.value !== undefined && input.value !== null;
    // EZ semantics: `count` ⇒ counter; `value` ⇒ gauge; neither ⇒ counter +1.
    const kind: "counter" | "value" = hasValue && !hasCount ? "value" : "counter";
    await this.postJson<unknown>(this.config.ingestPath, body, { allowStatuses: new Set([200, 429]) });
    return { ok: true, kind };
  }

  /**
   * Ask a natural-language question over the account's metrics (Ask-Your-Data).
   * Returns the server's answer text plus structured data the model can use.
   */
  async ask(query: string): Promise<AskResult> {
    const trimmed = (query ?? "").trim();
    if (!trimmed) {
      throw new EzStatApiError({
        status: 0,
        code: "invalid_input",
        message: "ask_ezstat requires a non-empty `query` string.",
      });
    }
    const raw = await this.postJson<AskRawResponse>(
      this.config.queryPath,
      { query: trimmed },
      { bearer: true },
    );
    return {
      answer: typeof raw.answer === "string" ? raw.answer : "",
      intent: typeof raw.intent === "string" ? raw.intent : null,
      source: typeof raw.source === "string" ? raw.source : null,
      llmUsed: raw.llm_used === true,
      remainingQueries: typeof raw.remaining_queries === "number" ? raw.remaining_queries : null,
      data: Array.isArray(raw.data) ? raw.data : [],
    };
  }

  /** List the account's stats (names + types + description). */
  async listStats(): Promise<ListedStat[]> {
    const raw = await this.getJson<{ stats?: unknown[] }>(this.config.statsListPath, { bearer: true });
    const list = Array.isArray(raw.stats) ? raw.stats : [];
    return list.flatMap((row): ListedStat[] => {
      if (!row || typeof row !== "object") return [];
      const r = row as Record<string, unknown>;
      const name = typeof r.name === "string" ? r.name : null;
      if (!name) return [];
      return [
        {
          name,
          type: typeof r.type === "string" ? r.type : "unknown",
          description: typeof r.description === "string" ? r.description : null,
          lastUpdated: typeof r.last_updated === "string" ? r.last_updated : null,
          id: typeof r.id === "string" ? r.id : null,
        },
      ];
    });
  }

  /**
   * Read a single stat (latest value / series / summary) for an optional time range.
   * `from`/`to` are Unix seconds (StatHat-style) — when omitted, the server defaults to last 24h.
   */
  async readStat(input: ReadStatInput): Promise<ReadStatResult> {
    if (!input.name || !input.name.trim()) {
      throw new EzStatApiError({
        status: 0,
        code: "invalid_input",
        message: "read_stat requires a non-empty `name`.",
      });
    }
    const encoded = encodeURIComponent(input.name);
    const qs = this.encodeQuery({
      from: input.from,
      to: input.to,
      resolution: input.resolution,
    });
    const path = `/api/v1/stats/${encoded}${qs ? `?${qs}` : ""}`;
    const raw = await this.getJson<unknown>(path, { bearer: true });

    if (!raw || typeof raw !== "object") {
      throw new EzStatApiError({
        status: 0,
        code: "invalid_response",
        message: "EzStat returned an unreadable response for this stat.",
      });
    }
    const r = raw as Record<string, unknown>;

    if (typeof r.error === "string") {
      // Server returned an error JSON; surface it without leaking the key.
      throw new EzStatApiError({
        status: 404,
        code: "stat_not_found",
        message: `Stat "${input.name}" could not be read: ${r.error}`,
      });
    }

    const dataRaw = Array.isArray(r.data) ? r.data : [];
    const dataPoints: DataPoint[] = dataRaw.flatMap((row): DataPoint[] => {
      if (!row || typeof row !== "object") return [];
      const rr = row as Record<string, unknown>;
      const t = typeof rr.t === "number" ? rr.t : Number(rr.t);
      const v = typeof rr.v === "number" ? rr.v : Number(rr.v);
      if (!Number.isFinite(t) || !Number.isFinite(v)) return [];
      return [{ t, v }];
    });

    const summaryRaw = r.summary && typeof r.summary === "object" ? (r.summary as Record<string, unknown>) : null;
    const summary: StatSummary | null = summaryRaw
      ? {
          count: typeof summaryRaw.count === "number" ? summaryRaw.count : null,
          min: typeof summaryRaw.min === "number" ? summaryRaw.min : null,
          max: typeof summaryRaw.max === "number" ? summaryRaw.max : null,
          avg: typeof summaryRaw.avg === "number" ? summaryRaw.avg : null,
          sum: typeof summaryRaw.sum === "number" ? summaryRaw.sum : null,
          truncated: summaryRaw.truncated === true,
        }
      : null;

    return {
      name: typeof r.name === "string" ? r.name : input.name,
      type: typeof r.type === "string" ? r.type : null,
      description: typeof r.description === "string" ? r.description : null,
      dataPoints,
      summary,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // HTTP plumbing.
  // ───────────────────────────────────────────────────────────────────────────

  async listAlerts(): Promise<AlertRow[]> {
    const res = await this.getJson<{ alerts?: AlertRow[] }>("/api/v1/alerts", { bearer: true });
    return res.alerts ?? [];
  }

  async createAlert(input: CreateAlertInput): Promise<AlertRow> {
    const res = await this.postJson<{ alert?: AlertRow }>("/api/v1/alerts", input, { bearer: true });
    if (!res.alert) {
      throw new EzStatApiError({ status: 0, code: "bad_response", message: "EzStat did not return the created alert." });
    }
    return res.alert;
  }

  async deleteAlert(id: string): Promise<void> {
    const url = this.resolveUrl(`/api/v1/alerts/${encodeURIComponent(id)}`);
    await this.run<unknown>("DELETE", url, {
      Accept: "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
    }, undefined);
  }

  private async getJson<T>(path: string, opts: { bearer: boolean }): Promise<T> {
    const url = this.resolveUrl(path);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.bearer) headers.Authorization = `Bearer ${this.config.apiKey}`;
    return this.run<T>("GET", url, headers, undefined);
  }

  private async postJson<T>(
    path: string,
    body: unknown,
    opts: { bearer?: boolean; allowStatuses?: Set<number> } = {},
  ): Promise<T> {
    const url = this.resolveUrl(path);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (opts.bearer) headers.Authorization = `Bearer ${this.config.apiKey}`;
    return this.run<T>("POST", url, headers, JSON.stringify(body), opts.allowStatuses);
  }

  private resolveUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    const p = path.startsWith("/") ? path : `/${path}`;
    return `${this.config.baseUrl}${p}`;
  }

  private async run<T>(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: string | undefined,
    allowStatuses?: Set<number>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    let res: Awaited<ReturnType<MinimalFetch>>;
    try {
      res = await this.fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const isAbort = controller.signal.aborted;
      const rawMessage = safeErrorMessage(err);
      const message = isAbort
        ? `Request to EzStat timed out after ${this.config.timeoutMs}ms.`
        : `Network error talking to EzStat: ${scrubKeyLike(rawMessage)}`;
      throw new EzStatApiError({
        status: 0,
        code: isAbort ? "timeout" : "network_error",
        message,
        cause: isAbort ? undefined : scrubKeyLike(rawMessage),
      });
    }
    clearTimeout(timer);

    const text = await res.text().catch(() => "");

    if (!res.ok && !(allowStatuses && allowStatuses.has(res.status))) {
      throw new EzStatApiError({
        status: res.status,
        code: statusToCode(res.status),
        message: parseServerErrorMessage(text) ?? `EzStat API returned HTTP ${res.status} ${res.statusText || ""}`.trim(),
      });
    }

    if (!text) return undefined as unknown as T;

    // The EZ endpoint surfaces application errors as HTTP 200/429 + `{status:"error",msg:"..."}` —
    // indistinguishable from success at the HTTP layer — so we translate that body into a typed error here.
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        if (obj.status === "error" && typeof obj.msg === "string") {
          throw new EzStatApiError({
            status: res.status,
            code: res.status === 429 ? "rate_limited" : "api_error",
            message: obj.msg,
          });
        }
      }
      return parsed as T;
    } catch (err) {
      if (err instanceof EzStatApiError) throw err;
      throw new EzStatApiError({
        status: res.status,
        code: "invalid_response",
        message: "EzStat returned a non-JSON response.",
        cause: safeErrorMessage(err),
      });
    }
  }
}

// ─── Types / helpers ─────────────────────────────────────────────────────────

export interface TrackMetricInput {
  stat: string;
  count?: number | null;
  value?: number | null;
  /** Unix seconds (StatHat-style). */
  timestamp?: number | null;
}

export interface TrackMetricResult {
  ok: true;
  kind: "counter" | "value";
}

export interface AskRawResponse {
  answer?: unknown;
  intent?: unknown;
  source?: unknown;
  llm_used?: unknown;
  remaining_queries?: unknown;
  data?: unknown;
}

export interface AskResult {
  answer: string;
  intent: string | null;
  source: string | null;
  llmUsed: boolean;
  remainingQueries: number | null;
  data: unknown[];
}

export interface ListedStat {
  id: string | null;
  name: string;
  type: string;
  description: string | null;
  lastUpdated: string | null;
}

export interface ReadStatInput {
  name: string;
  /** Unix seconds, inclusive. */
  from?: number;
  /** Unix seconds, inclusive. */
  to?: number;
  /** Optional rollup resolution: minute | hour | day. */
  resolution?: "minute" | "hour" | "day";
}

export interface DataPoint {
  /** Unix seconds. */
  t: number;
  v: number;
}

export interface StatSummary {
  count: number | null;
  min: number | null;
  max: number | null;
  avg: number | null;
  sum: number | null;
  truncated: boolean;
}

export interface ReadStatResult {
  name: string;
  type: string | null;
  description: string | null;
  dataPoints: DataPoint[];
  summary: StatSummary | null;
}

function statusToCode(status: number): string {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 413) return "payload_too_large";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return `http_${status}`;
}

function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Defense-in-depth: scrub anything in `s` that resembles an API key (`ezkey=`, `key=`, `apikey=`,
 * bearer headers, `ss_live_*`/`ezkey_*` tokens, long high-entropy strings) so a hostile transport
 * echo never turns a leaked key into a leaked key in our error messages.
 */
function scrubKeyLike(s: string): string {
  if (!s) return s;
  return s
    .replace(/\b(?:ezkey|apikey|api_key|api-key|authorization|bearer|key)\s*[=:]\s*[\w._\-]+/gi, (m) => redact(m))
    .replace(/\bss_live_[A-Za-z0-9]{16,}/g, (m) => redact(m))
    .replace(/\bss_[A-Za-z0-9_]{20,}/g, (m) => redact(m))
    .replace(/\bezkey_[A-Za-z0-9_]{16,}/g, (m) => redact(m))
    .replace(/[A-Za-z0-9._\-]{40,}/g, (m) => (/[\-_]/.test(m) ? redact(m) : m));
}

function redact(s: string): string {
  if (s.length <= 6) return "[REDACTED]";
  return `${s.slice(0, 4)}…[REDACTED]…${s.slice(-2)}`;
}

/**
 * Try to extract a server-provided message from a response body without leaking the API key.
 * Recognises the EZ endpoint's `{status: "error", msg: "..."}` shape and `{error: "..."}`.
 */
function parseServerErrorMessage(text: string): string | null {
  if (!text) return null;
  // Cheap: try JSON parse, but cap the text length first to avoid pathological input.
  if (text.length > 8_192) return null;
  try {
    const j: unknown = JSON.parse(text);
    if (j && typeof j === "object") {
      const obj = j as Record<string, unknown>;
      if (typeof obj.msg === "string") return obj.msg;
      if (typeof obj.error === "string") return obj.error;
    }
    return null;
  } catch {
    return null;
  }
}

export interface AlertRow {
  id: string;
  stat_id?: string;
  stat_name?: string | null;
  condition_type?: string;
  threshold?: number;
  channel?: string;
  enabled?: boolean;
  last_triggered_at?: string | null;
}

export interface CreateAlertInput {
  stat_id: string;
  condition_type: string;
  threshold: number;
  window_minutes?: number;
  channel: string;
  channel_config?: { webhook_url?: string; slack_channel?: string };
  cooldown_minutes?: number;
}
