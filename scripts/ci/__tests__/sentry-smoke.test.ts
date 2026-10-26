/**
 * Tests for scripts/ops/sentry-smoke.ts and .github/workflows/sentry-smoke.yml
 *
 * Verifies that:
 * - The synthetic event carries only the fixed message, environment and smoke_id tag
 * - Output is a single line of booleans/counts/enums (no DSN, host, key, ids)
 * - Delivery is confirmed from the ingest response (200 + event id), id never printed
 * - A 401/403 on the events read is reported as api_read=unavailable
 * - The workflow is workflow_dispatch-only, has no inputs, contents: read, pinned actions
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  parseDsn,
  buildEvent,
  buildEnvelope,
  eventsSearchUrl,
  formatResult,
  hasReturnedEventId,
  run,
  SMOKE_MESSAGE,
  type RunDeps,
} from "../../ops/sentry-smoke.js";

const FAKE_KEY = "abcdef0123456789abcdef0123456789";
const FAKE_HOST = "o999999.ingest.de.sentry.io";
const FAKE_PROJECT = "4500000000000001";
const FAKE_DSN = `https://${FAKE_KEY}@${FAKE_HOST}/${FAKE_PROJECT}`;
const FAKE_TOKEN = "sntrys_faketoken_value";
const FAKE_EVENT_ID = "0123456789abcdef0123456789abcdef";
const SMOKE_ID = "40300000001";

const OUTPUT_RE =
  /^sent=(true|false) ingest_ok=(true|false) event_id_returned=(true|false) api_read=(ok|unavailable|error|skipped)( arrived=(true|false) event_count=\d+)?( api_error=[a-z_0-9]+)?$/;
const INGEST_OK = { status: 200, body: { id: FAKE_EVENT_ID } };

type Resp = { status: number; body?: unknown } | "throw";

function makeDeps(responses: Resp[], env: Record<string, string | undefined> = {}) {
  const lines: string[] = [];
  const calls: { url: string; init?: { headers?: Record<string, string>; body?: string } }[] = [];
  let i = 0;
  const deps: RunDeps = {
    env: { SENTRY_DSN: FAKE_DSN, SENTRY_AUTH_TOKEN: FAKE_TOKEN, SMOKE_ID, ...env },
    fetch: async (url, init) => {
      calls.push({ url, init });
      const r = responses[Math.min(i++, responses.length - 1)];
      if (r === "throw") throw new Error(`network failure for ${url}`);
      return { status: r.status, json: async () => r.body ?? {} };
    },
    log: (l) => lines.push(l),
    sleep: async () => {},
    randomId: () => FAKE_EVENT_ID,
    now: () => new Date("2026-10-26T10:00:00Z"),
  };
  return { deps, lines, calls };
}

function expectSafeOutput(lines: string[]) {
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(OUTPUT_RE);
  for (const secret of [FAKE_KEY, FAKE_HOST, FAKE_PROJECT, FAKE_TOKEN, FAKE_EVENT_ID, "termwise", "net-terms-app", "sentry.io"]) {
    expect(lines[0]).not.toContain(secret);
  }
}

describe("sentry-smoke: DSN parsing", () => {
  it("parses a valid DSN", () => {
    expect(parseDsn(FAKE_DSN)).toEqual({ protocol: "https", publicKey: FAKE_KEY, host: FAKE_HOST, projectId: FAKE_PROJECT });
  });
  it("rejects empty, malformed or keyless DSNs", () => {
    expect(parseDsn(undefined)).toBeNull();
    expect(parseDsn("not a url")).toBeNull();
    expect(parseDsn(`https://${FAKE_HOST}/${FAKE_PROJECT}`)).toBeNull();
    expect(parseDsn(`https://${FAKE_KEY}@${FAKE_HOST}/abc`)).toBeNull();
  });
});

describe("sentry-smoke: synthetic event has no PII", () => {
  it("contains only the allowlisted keys", () => {
    const ev = buildEvent(FAKE_EVENT_ID, SMOKE_ID, new Date());
    expect(Object.keys(ev).sort()).toEqual(
      ["environment", "event_id", "level", "logger", "message", "platform", "tags", "timestamp"].sort(),
    );
    expect(ev.message).toBe(SMOKE_MESSAGE);
    expect(ev.tags).toEqual({ smoke_id: SMOKE_ID });
    expect(ev).not.toHaveProperty("user");
    expect(ev).not.toHaveProperty("request");
    expect(ev).not.toHaveProperty("server_name");
  });
  it("envelope has 3 JSON lines and no DSN in the header", () => {
    const env = buildEnvelope(FAKE_EVENT_ID, SMOKE_ID, new Date());
    const parts = env.trim().split("\n").map((l) => JSON.parse(l));
    expect(parts).toHaveLength(3);
    expect(parts[1].type).toBe("event");
    expect(env).not.toContain(FAKE_KEY);
    expect(env).not.toContain(FAKE_HOST);
  });
  it("search query filters by message and smoke_id tag", () => {
    const u = new URL(eventsSearchUrl("https://de.sentry.io", "termwise", FAKE_PROJECT, SMOKE_ID));
    expect(u.searchParams.get("query")).toBe(`message:"${SMOKE_MESSAGE}" smoke_id:${SMOKE_ID}`);
    expect(u.searchParams.get("project")).toBe(FAKE_PROJECT);
  });
});

describe("sentry-smoke: run() output is booleans/counts only", () => {
  it("api read ok: arrived=true with event_count", async () => {
    const { deps, lines, calls } = makeDeps([INGEST_OK, { status: 200, body: { data: [] } }, { status: 200, body: { data: [{ id: "x" }] } }]);
    expect(await run(deps)).toBe(0);
    expect(lines).toEqual(["sent=true ingest_ok=true event_id_returned=true api_read=ok arrived=true event_count=1"]);
    expectSafeOutput(lines);
    expect(calls[0].init?.headers?.["X-Sentry-Auth"]).toContain(`sentry_key=${FAKE_KEY}`);
  });
  it("403 on read -> api_read=unavailable, delivery from ingest, exit 0", async () => {
    const { deps, lines } = makeDeps([INGEST_OK, { status: 403 }]);
    expect(await run(deps)).toBe(0);
    expect(lines).toEqual(["sent=true ingest_ok=true event_id_returned=true api_read=unavailable"]);
    expectSafeOutput(lines);
  });
  it("401 on read -> api_read=unavailable, exit 0", async () => {
    const { deps, lines } = makeDeps([INGEST_OK, { status: 401 }]);
    expect(await run(deps)).toBe(0);
    expect(lines[0]).toBe("sent=true ingest_ok=true event_id_returned=true api_read=unavailable");
  });
  it("ingest 200 without an event id -> event_id_returned=false, exit 1", async () => {
    const { deps, lines } = makeDeps([{ status: 200, body: {} }, { status: 403 }]);
    expect(await run(deps)).toBe(1);
    expect(lines).toEqual(["sent=true ingest_ok=true event_id_returned=false api_read=unavailable"]);
  });
  it("no auth token -> api_read=unavailable, ingest decides", async () => {
    const { deps, lines, calls } = makeDeps([INGEST_OK], { SENTRY_AUTH_TOKEN: "" });
    expect(await run(deps)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(lines).toEqual(["sent=true ingest_ok=true event_id_returned=true api_read=unavailable"]);
  });
  it("api read ok but never found -> arrived=false event_count=0, exit 1", async () => {
    const { deps, lines } = makeDeps([INGEST_OK, { status: 200, body: { data: [] } }]);
    expect(await run(deps)).toBe(1);
    expect(lines).toEqual(["sent=true ingest_ok=true event_id_returned=true api_read=ok arrived=false event_count=0"]);
  });
  it("ingest rejected -> ingest_ok=false, exit 1", async () => {
    const { deps, lines } = makeDeps([{ status: 401 }]);
    expect(await run(deps)).toBe(1);
    expect(lines).toEqual(["sent=true ingest_ok=false event_id_returned=false api_read=skipped api_error=ingest_http_401"]);
    expectSafeOutput(lines);
  });
  it("network errors never leak the URL", async () => {
    const { deps, lines } = makeDeps(["throw"]);
    expect(await run(deps)).toBe(1);
    expect(lines).toEqual(["sent=false ingest_ok=false event_id_returned=false api_read=skipped api_error=ingest_network"]);
    expectSafeOutput(lines);
  });
  it("invalid DSN or smoke id fails closed without sending", async () => {
    const a = makeDeps([INGEST_OK], { SENTRY_DSN: "garbage" });
    expect(await run(a.deps)).toBe(1);
    expect(a.calls).toHaveLength(0);
    const b = makeDeps([INGEST_OK], { SMOKE_ID: "abc; rm" });
    expect(await run(b.deps)).toBe(1);
    expect(b.calls).toHaveLength(0);
    expectSafeOutput(a.lines);
    expectSafeOutput(b.lines);
  });
  it("hasReturnedEventId accepts only a 32-hex id", () => {
    expect(hasReturnedEventId({ id: FAKE_EVENT_ID })).toBe(true);
    expect(hasReturnedEventId({ id: "" })).toBe(false);
    expect(hasReturnedEventId({ id: "<script>" })).toBe(false);
    expect(hasReturnedEventId(null)).toBe(false);
  });
  it("formatResult never includes the event id", () => {
    const l = formatResult({ sent: true, ingestOk: true, eventIdReturned: true, apiRead: "unavailable" });
    expect(l).toMatch(OUTPUT_RE);
    expect(l).not.toContain(FAKE_EVENT_ID);
  });
});

describe("sentry-smoke: workflow file", () => {
  const wf = fs.readFileSync(path.join(__dirname, "..", "..", "..", ".github", "workflows", "sentry-smoke.yml"), "utf8");

  it("is workflow_dispatch-only with no inputs", () => {
    const on = wf.split(/^on:\s*$/m)[1].split(/^\S/m)[0];
    expect(on.trim()).toBe("workflow_dispatch:");
    expect(wf).not.toMatch(/inputs:/);
  });
  it("has contents: read permissions only", () => {
    expect(wf).toMatch(/^permissions:\n {2}contents: read\n\n/m);
  });
  it("pins every action to a full commit SHA", () => {
    const uses = [...wf.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });
  it("does not echo secret values", () => {
    expect(wf).not.toMatch(/echo\s+["']?\$\{?SENTRY_(DSN|AUTH_TOKEN)/);
    expect(wf).not.toMatch(/set -x/);
  });
});
