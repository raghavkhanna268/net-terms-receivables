/**
 * Sentry live check (synthetic smoke event).
 *
 * Sends ONE synthetic event to the project in SENTRY_DSN, then polls the Sentry
 * API (SENTRY_AUTH_TOKEN) for it. Used by .github/workflows/sentry-smoke.yml.
 *
 * Safety invariants (the Actions logs of this repo are public):
 * - The event carries only the fixed message "ntr-sentry-smoke", a fixed
 *   environment, and the tag smoke_id=<github.run_id>. No PII, no shop data,
 *   no request data, no user, no server_name.
 * - Output is ONE line of booleans/counts/enums:
 *     sent=<bool> ingest_ok=<bool> event_id_returned=<bool> api_read=unavailable
 *     sent=<bool> ingest_ok=<bool> event_id_returned=<bool> api_read=ok arrived=<bool> event_count=<n>
 *   plus api_error=<enum> on failures. The DSN, its host, key, org/project ids
 *   and the event id are never printed (only whether an id was returned).
 *   Errors are reported as fixed enums only (no error messages, no URLs).
 * - When the auth token cannot read events (401/403), delivery is confirmed
 *   from the ingest response only (HTTP 200 + returned event id). That is NOT
 *   an API-side read confirmation.
 *
 * Exit codes: 0 when ingest returned 200 with an event id and the API read
 * either confirmed arrival or is unavailable; 1 otherwise.
 *
 * Usage:
 *   node --experimental-strip-types scripts/ops/sentry-smoke.ts
 *
 * Environment:
 *   SENTRY_DSN, SENTRY_AUTH_TOKEN, SMOKE_ID (digits, e.g. github.run_id)
 *   SENTRY_ORG (default "termwise"), SENTRY_API_BASE (default EU region)
 */

export const SMOKE_MESSAGE = "ntr-sentry-smoke";
export const SMOKE_ENVIRONMENT = "ci-smoke";
export const DEFAULT_ORG = "termwise";
export const DEFAULT_API_BASE = "https://de.sentry.io";
export const POLL_ATTEMPTS = 12;
export const POLL_INTERVAL_MS = 10_000;

export interface ParsedDsn {
  protocol: string;
  publicKey: string;
  host: string;
  projectId: string;
}

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json: () => Promise<unknown> }>;

export interface RunDeps {
  env: Record<string, string | undefined>;
  fetch: FetchLike;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  randomId: () => string;
  now: () => Date;
}

export function parseDsn(dsn: string | undefined): ParsedDsn | null {
  if (!dsn) return null;
  let u: URL;
  try {
    u = new URL(dsn.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const projectId = u.pathname.replace(/^\/+|\/+$/g, "").split("/").pop() ?? "";
  if (!u.username || !u.hostname || !/^\d+$/.test(projectId)) return null;
  return {
    protocol: u.protocol.slice(0, -1),
    publicKey: u.username,
    host: u.host,
    projectId,
  };
}

export function isValidSmokeId(id: string | undefined): id is string {
  return typeof id === "string" && /^\d{1,20}$/.test(id);
}

/** The full synthetic event. Only these keys are ever sent. */
export function buildEvent(eventId: string, smokeId: string, now: Date) {
  return {
    event_id: eventId,
    timestamp: now.toISOString(),
    platform: "other",
    level: "info",
    logger: "ntr-sentry-smoke",
    environment: SMOKE_ENVIRONMENT,
    message: SMOKE_MESSAGE,
    tags: { smoke_id: smokeId },
  };
}

export function buildEnvelope(eventId: string, smokeId: string, now: Date): string {
  const event = buildEvent(eventId, smokeId, now);
  return (
    JSON.stringify({ event_id: eventId, sent_at: now.toISOString() }) +
    "\n" +
    JSON.stringify({ type: "event", content_type: "application/json" }) +
    "\n" +
    JSON.stringify(event) +
    "\n"
  );
}

export function envelopeUrl(d: ParsedDsn): string {
  return `${d.protocol}://${d.host}/api/${d.projectId}/envelope/`;
}

export function eventsSearchUrl(apiBase: string, org: string, projectId: string, smokeId: string): string {
  const q = new URLSearchParams({
    project: projectId,
    field: "id",
    query: `message:"${SMOKE_MESSAGE}" smoke_id:${smokeId}`,
    statsPeriod: "1h",
    per_page: "10",
  });
  return `${apiBase.replace(/\/+$/, "")}/api/0/organizations/${encodeURIComponent(org)}/events/?${q.toString()}`;
}

export type ApiRead = "ok" | "unavailable" | "error" | "skipped";

export interface SmokeResult {
  sent: boolean;
  ingestOk: boolean;
  eventIdReturned: boolean;
  apiRead: ApiRead;
  arrived?: boolean;
  eventCount?: number;
  apiError?: string;
}

/**
 * One line of booleans/counts/enums only. The event id is NEVER printed;
 * only whether one came back.
 */
export function formatResult(r: SmokeResult): string {
  let line =
    `sent=${r.sent} ingest_ok=${r.ingestOk} event_id_returned=${r.eventIdReturned} api_read=${r.apiRead}`;
  if (r.apiRead === "ok") line += ` arrived=${r.arrived ?? false} event_count=${r.eventCount ?? 0}`;
  if (r.apiError) line += ` api_error=${r.apiError}`;
  return line;
}

/** True when the ingest response body is {"id": "<32 hex>"}. */
export function hasReturnedEventId(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const id = (body as { id?: unknown }).id;
  return typeof id === "string" && /^[0-9a-f]{32}$/i.test(id.replace(/-/g, ""));
}

function countRows(body: unknown): number {
  if (body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)) {
    return (body as { data: unknown[] }).data.length;
  }
  return 0;
}

export async function run(deps: RunDeps): Promise<number> {
  const dsn = parseDsn(deps.env.SENTRY_DSN);
  const token = deps.env.SENTRY_AUTH_TOKEN?.trim();
  const smokeId = deps.env.SMOKE_ID?.trim();
  const org = deps.env.SENTRY_ORG?.trim() || DEFAULT_ORG;
  const apiBase = deps.env.SENTRY_API_BASE?.trim() || DEFAULT_API_BASE;
  const base = { sent: false, ingestOk: false, eventIdReturned: false, apiRead: "skipped" as ApiRead };

  if (!dsn) {
    deps.log(formatResult({ ...base, apiError: "dsn_invalid" }));
    return 1;
  }
  if (!isValidSmokeId(smokeId)) {
    deps.log(formatResult({ ...base, apiError: "smoke_id_invalid" }));
    return 1;
  }

  // 1) Send. Delivery is confirmed from the ingest response: HTTP 200 plus a
  //    returned event id (never printed).
  const eventId = deps.randomId();
  let ingestOk = false;
  let eventIdReturned = false;
  try {
    const res = await deps.fetch(envelopeUrl(dsn), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=ntr-sentry-smoke/1.0, sentry_key=${dsn.publicKey}`,
      },
      body: buildEnvelope(eventId, smokeId, deps.now()),
    });
    ingestOk = res.status === 200;
    if (ingestOk) {
      try {
        eventIdReturned = hasReturnedEventId(await res.json());
      } catch {
        eventIdReturned = false;
      }
    }
    if (!ingestOk) {
      deps.log(formatResult({ ...base, sent: true, apiError: `ingest_http_${res.status}` }));
      return 1;
    }
  } catch {
    deps.log(formatResult({ ...base, apiError: "ingest_network" }));
    return 1;
  }

  const sentOk = { sent: true, ingestOk, eventIdReturned };
  const deliveryCode = eventIdReturned ? 0 : 1;

  if (!token) {
    deps.log(formatResult({ ...sentOk, apiRead: "unavailable" }));
    return deliveryCode;
  }

  // 2) Optional API-side read. If the token cannot read events (401/403),
  //    report api_read=unavailable and rely on the ingest confirmation.
  const url = eventsSearchUrl(apiBase, org, dsn.projectId, smokeId);
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    await deps.sleep(POLL_INTERVAL_MS);
    let status: number;
    let body: unknown = null;
    try {
      const res = await deps.fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      status = res.status;
      if (status === 200) body = await res.json();
    } catch {
      continue; // transient network error; retry
    }
    if (status === 401 || status === 403) {
      deps.log(formatResult({ ...sentOk, apiRead: "unavailable" }));
      return deliveryCode;
    }
    if (status === 200) {
      const n = countRows(body);
      if (n > 0) {
        deps.log(formatResult({ ...sentOk, apiRead: "ok", arrived: true, eventCount: n }));
        return 0;
      }
      continue;
    }
    if (status === 429 || status >= 500) continue;
    deps.log(formatResult({ ...sentOk, apiRead: "error", apiError: `search_http_${status}` }));
    return 1;
  }

  deps.log(formatResult({ ...sentOk, apiRead: "ok", arrived: false, eventCount: 0 }));
  return 1;
}

const isMain = process.argv[1]?.endsWith("sentry-smoke.ts") ||
  process.argv[1]?.endsWith("sentry-smoke");

if (isMain) {
  run({
    env: process.env,
    fetch: (url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>,
    log: (line) => console.log(line),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    randomId: () => crypto.randomUUID().replace(/-/g, ""),
    now: () => new Date(),
  }).then(
    (code) => process.exit(code),
    () => {
      console.log("sent=false ingest_ok=false event_id_returned=false api_read=skipped api_error=unexpected");
      process.exit(1);
    },
  );
}
