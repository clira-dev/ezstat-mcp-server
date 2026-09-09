/**
 * Lightweight fetch double for tests. Mocks one URL at a time.
 * - configure({ json, status }): the mock will respond with that JSON / status.
 * - configureRaw(text): respond with raw text + 200.
 * - configureError(throw): throw a network error.
 * - record(): a record of every request the mock saw (for assertions).
 */

import type { EzStatClientDeps } from "../src/ezstat-client.js";

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface MockFetchHandle {
  configure: (opts: { json?: unknown; status?: number; statusText?: string; headers?: Record<string, string> }) => void;
  configureRaw: (text: string, status?: number) => void;
  configureError: (err: Error) => void;
  configureTimeout: () => void;
  /** Queue a response to be consumed in order. Each call dequeues one entry. */
  queue: (opts: { json?: unknown; status?: number; statusText?: string; headers?: Record<string, string> }) => void;
  /** Reset the mock to a sensible default (200 OK with empty JSON). */
  reset: () => void;
  record: () => RecordedRequest[];
  /** The most recent request, or null if none. */
  lastRequest: () => RecordedRequest | null;
  /** The request at index i in record() order. */
  requestAt: (i: number) => RecordedRequest | null;
}

export function makeMockFetch(): { deps: EzStatClientDeps; mock: MockFetchHandle } {
  const recorded: RecordedRequest[] = [];
  let nextResponse: {
    status: number;
    statusText: string;
    body: string;
    headers: Record<string, string>;
    delayMs?: number;
  } = { status: 200, statusText: "OK", body: "{}", headers: {} };
  const queuedResponses: Array<typeof nextResponse> = [];
  let throwError: Error | null = null;
  let hangForever = false;
  function responseFromOpts(opts: { json?: unknown; status?: number; statusText?: string; headers?: Record<string, string> }): typeof nextResponse {
    const status = opts.status ?? 200;
    return {
      status,
      statusText: opts.statusText ?? (status >= 200 && status < 300 ? "OK" : "ERR"),
      body: opts.json === undefined ? "" : JSON.stringify(opts.json),
      headers: opts.headers ?? {},
    };
  }
  function dequeueResponse(): typeof nextResponse {
    const next = queuedResponses.shift();
    return next ?? nextResponse;
  }

  const fakeFetch: NonNullable<EzStatClientDeps["fetch"]> = async (url, init) => {
    const method = init?.method ?? "GET";
    recorded.push({
      url: String(url),
      method,
      headers: { ...(init?.headers ?? {}) },
      body: init?.body,
    });

    if (throwError) {
      const e = throwError;
      throwError = null;
      throw e;
    }
    if (hangForever) {
      await new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("aborted")), 5_000);
        // surface abort cleanly
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          const abortErr = new Error("aborted");
          abortErr.name = "AbortError";
          reject(abortErr);
        });
      });
    }

    const resp = dequeueResponse();
    const text = resp.body;
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      statusText: resp.statusText,
      headers: new Headers(resp.headers),
      async text() {
        return text;
      },
      async json() {
        return JSON.parse(text);
      },
    };
  };

  const mock: MockFetchHandle = {
    configure(opts = {}) {
      nextResponse = responseFromOpts(opts);
    },
    configureRaw(text, status = 200) {
      nextResponse = { status, statusText: status === 200 ? "OK" : "ERR", body: text, headers: {} };
    },
    configureError(err: Error) {
      throwError = err;
    },
    configureTimeout() {
      hangForever = true;
      setTimeout(() => (hangForever = false), 30_000);
    },
    queue(opts = {}) {
      queuedResponses.push(responseFromOpts(opts));
    },
    reset() {
      nextResponse = { status: 200, statusText: "OK", body: "{}", headers: {} };
      queuedResponses.length = 0;
      throwError = null;
      hangForever = false;
    },
    record() {
      return recorded.slice();
    },
    lastRequest() {
      return recorded.length === 0 ? null : (recorded[recorded.length - 1] ?? null);
    },
    requestAt(i: number) {
      return recorded[i] ?? null;
    },
  };

  return { deps: { fetch: fakeFetch }, mock };
}
