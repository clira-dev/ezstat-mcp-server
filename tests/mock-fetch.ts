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
  /** Reset the mock to a sensible default (200 OK with empty JSON). */
  reset: () => void;
  record: () => RecordedRequest[];
  /** The most recent request, or null if none. */
  lastRequest: () => RecordedRequest | null;
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
  let throwError: Error | null = null;
  let hangForever = false;

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

    const text = nextResponse.body;
    return {
      ok: nextResponse.status >= 200 && nextResponse.status < 300,
      status: nextResponse.status,
      statusText: nextResponse.statusText,
      headers: new Headers(nextResponse.headers),
      async text() {
        return text;
      },
      async json() {
        return JSON.parse(text);
      },
    };
  };

  const mock: MockFetchHandle = {
    configure({ json, status = 200, statusText = "OK", headers = {} } = {}) {
      nextResponse = {
        status,
        statusText,
        body: json === undefined ? "" : JSON.stringify(json),
        headers,
      };
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
    reset() {
      nextResponse = { status: 200, statusText: "OK", body: "{}", headers: {} };
      throwError = null;
      hangForever = false;
    },
    record() {
      return recorded.slice();
    },
    lastRequest() {
      return recorded.length === 0 ? null : (recorded[recorded.length - 1] ?? null);
    },
  };

  return { deps: { fetch: fakeFetch }, mock };
}
