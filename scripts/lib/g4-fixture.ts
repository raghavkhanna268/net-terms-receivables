/**
 * G4 reminder delivery fixture (seed-tagged, throwaway INR e2e store only).
 *
 * This module is the source of truth for the G4 fixture: the recipient env
 * name, the pre-flight guards, and the single-transaction write / cleanup
 * database operations. The send path is unchanged; the only app module used is
 * the leaf recipient-allowlist parser.
 *
 * OUTPUT HYGIENE: every exported helper returns counts/enums only. Callers must
 * never print amounts, emails, domains, ids, or tokens. Errors are thrown with
 * a fixed `g4_*` code string and no interpolated values.
 *
 * @module
 */

import { DateTime } from "luxon";
import type postgres from "postgres";
// Leaf module (no imports of its own); parses RESEND_TEST_RECIPIENTS the same way.
import { parseRecipientAllowlist } from "../../app/services/recipient-allowlist.server";

type Sql = ReturnType<typeof postgres>;

/** GitHub repo secret that carries the fixture recipient (never a workflow input). */
export const G4_RECIPIENT_ENV = "G4_TEST_RECIPIENT" as const;

/** Fixed line printed on write: cleanup must run the same day before this UTC time. */
export const G4_CLEANUP_DUE_BEFORE = "02:00Z" as const;

/**
 * UTC minute at which the reminder enqueue runs every hour.
 *
 * The enqueue is a pg_cron job scheduled '15 * * * *' (UTC) and only enqueues
 * when the shop-local hour is 09..18. Both facts live in the migration
 * prisma/migrations/20261030000000_s18_payment_reminders/migration.sql (the
 * latest revision of s18_enqueue_reminders() is
 * prisma/migrations/20261122000000_s18_catchup_amount_ordering/migration.sql).
 * The guards below are derived from this one constant, not from the box clock.
 */
export const REMINDER_ENQUEUE_UTC_MINUTE = 15;

/** Shop-local hours during which the enqueue fires (s18_enqueue_reminders: 09..18). */
const SEND_WINDOW_FIRST_HOUR = 9;
const SEND_WINDOW_LAST_HOUR = 18;

/**
 * Cleanup blackout, in UTC minutes, bracketing the :15 enqueue so a reminder
 * enqueued at that run cannot still fire after cleanup disables reminders.
 * Same -1/+5 bracket the old shop-local rule used around its hourly run.
 */
const CLEANUP_BLACKOUT_FIRST_UTC_MINUTE = REMINDER_ENQUEUE_UTC_MINUTE - 1; // 14
const CLEANUP_BLACKOUT_LAST_UTC_MINUTE = REMINDER_ENQUEUE_UTC_MINUTE + 5; // 20

/** A single plain address, matching the shape an allowlist entry may take. */
const SIMPLE_EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

/** Extract the lowercased domain part of an address, or "" when absent. */
export function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : email.trim().toLowerCase();
}

/**
 * Reserved documentation/test domains (RFC 2606 / RFC 6761). The real recipient
 * allowlist is a Worker secret CI cannot read, so an address in one of these
 * domains is treated as non-deliverable (the allowlist will skip it):
 *   example.com / example.org / example.net (and their subdomains),
 *   the .example TLD, and the .test / .invalid TLDs.
 */
export function isReservedTestDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase();
  if (d === "example.com" || d === "example.org" || d === "example.net") return true;
  if (d.endsWith(".example.com") || d.endsWith(".example.org") || d.endsWith(".example.net")) {
    return true;
  }
  if (d === "example" || d.endsWith(".example")) return true;
  if (d === "test" || d.endsWith(".test")) return true;
  if (d === "invalid" || d.endsWith(".invalid")) return true;
  return false;
}

/**
 * Whether a non-fixture recipient should be treated as a real, deliverable
 * address. Fails safe: anything that is NOT a reserved test domain counts as
 * sendable, so any real-looking address makes the pre-flight abort.
 */
export function isSendableRecipient(email: string): boolean {
  return !isReservedTestDomain(domainOf(email));
}

/**
 * Resolve the single fixture recipient from the G4 repo secret.
 *
 * Parsed exactly like RESEND_TEST_RECIPIENTS (split on ",", trim, lowercase,
 * drop empties); the first entry wins. Fails closed with the fixed string
 * `g4_recipient_unavailable` when the value is empty, whitespace/commas-only,
 * or the first entry is not a single plain address. The value is never logged.
 */
export function resolveG4Recipient(env: Record<string, string | undefined> = process.env): string {
  const set = parseRecipientAllowlist(env[G4_RECIPIENT_ENV]);
  const first = set.values().next().value as string | undefined;
  if (!first || !SIMPLE_EMAIL.test(first)) {
    throw new Error("g4_recipient_unavailable");
  }
  return first;
}

/**
 * Strip `//` line and `/* *\/` block comments from JSONC while preserving any
 * occurrences inside string literals (e.g. URLs), then drop trailing commas.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Read `vars.RESEND_RECIPIENT_ALLOWLIST_ENFORCED` from wrangler.jsonc text.
 * Returns undefined when the key (or the vars block) is absent.
 */
export function readAllowlistEnforcedFromWrangler(wranglerText: string): string | undefined {
  const parsed = JSON.parse(stripJsonComments(wranglerText)) as {
    vars?: Record<string, unknown>;
  };
  const value = parsed.vars?.RESEND_RECIPIENT_ALLOWLIST_ENFORCED;
  return typeof value === "string" ? value : undefined;
}

/**
 * Allowlist guard: the enforcement flag must be absent or exactly "true".
 * Any other value (including "false") fails closed. Throws the fixed code
 * `g4_allowlist_not_enforced`.
 */
export function assertAllowlistEnforced(value: string | undefined): void {
  if (value === undefined || value === "true") {
    return;
  }
  throw new Error("g4_allowlist_not_enforced");
}

/** Format a luxon zone offset (minutes east of UTC) as a signed "+HH:MM" string. */
function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

/** The first enqueue run (UTC :15) strictly after `now`. */
function nextEnqueueUtc(now: Date): DateTime {
  const nowUtc = DateTime.fromJSDate(now, { zone: "utc" });
  let run = nowUtc.set({ minute: REMINDER_ENQUEUE_UTC_MINUTE, second: 0, millisecond: 0 });
  if (run <= nowUtc) {
    run = run.plus({ hours: 1 });
  }
  return run;
}

/**
 * The last enqueue run (UTC :15) that lands on `now`'s shop-local date with a
 * shop-local hour in the send window, or null when the day has none. DST-safe:
 * every candidate run is converted through the zone with luxon.
 */
function lastEnqueueLocalToday(now: Date, tz: string): DateTime | null {
  const nowLocal = DateTime.fromJSDate(now, { zone: tz });
  let run = DateTime.fromJSDate(now, { zone: "utc" })
    .set({ minute: REMINDER_ENQUEUE_UTC_MINUTE, second: 0, millisecond: 0 })
    .minus({ hours: 30 });
  let best: DateTime | null = null;
  for (let i = 0; i < 60; i++) {
    const local = run.setZone(tz);
    if (
      local.hasSame(nowLocal, "day") &&
      local.hour >= SEND_WINDOW_FIRST_HOUR &&
      local.hour <= SEND_WINDOW_LAST_HOUR &&
      (!best || local > best)
    ) {
      best = local;
    }
    run = run.plus({ hours: 1 });
  }
  return best;
}

/** Fixed-key, PII-free description of the write window (times and offsets only). */
export interface G4WriteWindow {
  /** Shop UTC offset at `now`, e.g. "+05:30" or "-04:00". */
  shopTzOffset: string;
  /** Next enqueue run in UTC, "HH:mm" (always the :15 run). */
  nextEnqueueUtc: string;
  /** That same run in shop-local time, "HH:mm". */
  nextEnqueueLocal: string;
  /** Latest in-window enqueue today in shop-local time, or null. */
  lastEnqueueLocalToday: string | null;
  /** Whether the write window is open now (see assertWithinWriteWindow). */
  writeWindowOk: boolean;
}

/**
 * Compute the write window from an instant and the shop timezone. A write is
 * allowed only when the shop-local time is at or after 09:00 AND the next UTC
 * :15 enqueue run (strictly after `now`) lands on the same shop-local date with
 * a shop-local hour of 09..18 — i.e. that run would still enqueue today's
 * offset-0 reminder. Pure and timezone-correct for any zone (luxon).
 */
export function computeG4WriteWindow(now: Date, tz: string): G4WriteWindow {
  const nowLocal = DateTime.fromJSDate(now, { zone: tz });
  const runUtc = nextEnqueueUtc(now);
  const runLocal = runUtc.setZone(tz);

  const afterOpen = nowLocal.hour >= SEND_WINDOW_FIRST_HOUR;
  const sameLocalDate = runLocal.hasSame(nowLocal, "day");
  const runHourInWindow =
    runLocal.hour >= SEND_WINDOW_FIRST_HOUR && runLocal.hour <= SEND_WINDOW_LAST_HOUR;

  const last = lastEnqueueLocalToday(now, tz);

  return {
    shopTzOffset: formatOffset(nowLocal.offset),
    nextEnqueueUtc: runUtc.toFormat("HH:mm"),
    nextEnqueueLocal: runLocal.toFormat("HH:mm"),
    lastEnqueueLocalToday: last ? last.toFormat("HH:mm") : null,
    writeWindowOk: afterOpen && sameLocalDate && runHourInWindow,
  };
}

/**
 * Write-window guard: offset-0 reminders can only fire today when the write
 * lands inside the window computed by computeG4WriteWindow. Throws
 * `g4_outside_send_window` otherwise.
 */
export function assertWithinWriteWindow(now: Date, tz: string): void {
  if (!computeG4WriteWindow(now, tz).writeWindowOk) {
    throw new Error("g4_outside_send_window");
  }
}

/** Fixed-key, PII-free description of the cleanup window (UTC minute only). */
export interface G4CleanupWindow {
  /** Current UTC minute (00..59). */
  utcMinute: number;
  /** Whether cleanup is blocked now (see assertNotCleanupBlackout). */
  blocked: boolean;
}

/**
 * Compute the cleanup window from an instant. Cleanup is blocked when the
 * current UTC minute brackets the :15 enqueue (14..20 inclusive), regardless of
 * the shop timezone. Pure.
 */
export function computeG4CleanupWindow(now: Date): G4CleanupWindow {
  const utcMinute = now.getUTCMinutes();
  return {
    utcMinute,
    blocked:
      utcMinute >= CLEANUP_BLACKOUT_FIRST_UTC_MINUTE &&
      utcMinute <= CLEANUP_BLACKOUT_LAST_UTC_MINUTE,
  };
}

/**
 * Cleanup blackout guard: a reminder enqueued at the :15 run still sends after
 * cleanup disables reminders, so refuse to clean up while the current UTC minute
 * is in the blackout bracket. Throws `g4_cleanup_wait`.
 */
export function assertNotCleanupBlackout(now: Date): void {
  if (computeG4CleanupWindow(now).blocked) {
    throw new Error("g4_cleanup_wait");
  }
}

/** Deterministic, seed-tagged, shop-scoped fixture ids. */
export function g4FixtureIds(shopId: string) {
  return {
    account: `seed-g4-fixture-${shopId}`,
    company: `ntr-seed-g4-company-${shopId}`,
    location: "ntr-seed-g4-fixture",
    invoice: `seed-g4-fixture-inv-${shopId}`,
    order: `ntr-seed-g4-order-${shopId}`,
    rule: `seed-g4-rule0-${shopId}`,
    prior: `seed-g4-fixture-prior-${shopId}`,
  } as const;
}

type RemindersSetting = "on" | "off" | "absent";

interface StoreRow {
  id: string;
  tz: string;
  currency: string;
  /** The DB clock (now()) captured at store resolution; the guards' single clock. */
  dbNow: Date;
  remindersSetting: RemindersSetting;
}

/**
 * Resolve the seed-marked shop by domain and lock it.
 * The shop must carry an existing seed marker (seed-shop id or a ntr-seed tag
 * rule); otherwise `g4_store_not_found`.
 */
async function resolveStore(
  tx: Sql,
  domain: string,
  requireInstalled: boolean,
  lockForUpdate: boolean
): Promise<StoreRow> {
  const rows = await tx<
    {
      id: string;
      tz: string;
      currency: string;
      db_now: Date;
      reminders_setting: string | null;
    }[]
  >`
    SELECT
      s.id,
      public.s18_safe_timezone(s.timezone) AS tz,
      s.currency,
      now() AS db_now,
      (SELECT CASE WHEN enabled THEN 'on' ELSE 'off' END
         FROM s18_shop_reminder_settings WHERE shop_id = s.id) AS reminders_setting
    FROM "Shop" s
    WHERE s.domain = ${domain}
      ${requireInstalled ? tx`AND s."uninstalledAt" IS NULL` : tx``}
      AND (
        s.id LIKE 'seed-shop-%'
        OR EXISTS (SELECT 1 FROM "AccountSource" a WHERE a."shopId" = s.id AND a.tag LIKE 'ntr-seed-%')
      )
    ${lockForUpdate ? tx`FOR UPDATE` : tx``}
  `;
  const row = rows[0];
  if (!row) {
    throw new Error("g4_store_not_found");
  }
  return {
    id: row.id,
    tz: row.tz,
    currency: row.currency,
    dbNow: row.db_now,
    remindersSetting: (row.reminders_setting ?? "absent") as RemindersSetting,
  };
}

export interface G4SideEffects {
  /** Distinct non-fixture invoices that would fire today (any enabled rule). */
  otherDueToday: number;
  /** Distinct non-fixture invoices due today whose recipient looks deliverable. */
  otherSendableToday: number;
  /**
   * Distinct OTHER (non-fixture) GATED buyers' open invoices that would match an
   * enabled email rule today (counts only). These are excluded from the enqueue
   * (and from otherDueToday/otherSendableToday) because they are gated; this key
   * reports them separately. When no enabled offset-0 email rule exists yet the
   * would-be offset-0 rule (the one the live write creates) is folded in too.
   */
  otherGatedDueToday: number;
  /** Non-fixture (invoice,rule) reminders the enqueue would create when ON. */
  wouldEnqueueNonFixture: number;
  /** Of those, how many we expect the allowlist to skip (reserved domains). */
  wouldEnqueueExpectedSkip: number;
  /** Of those, how many look deliverable (these are what trigger the abort). */
  wouldEnqueueExpectedSend: number;
  /** Existing non-fixture ReminderLog rows, grouped by status. */
  existingLogsByStatus: Record<string, number>;
}

/**
 * Read-only lookup of the offset-0 email ReminderRule the fixture would reuse:
 * the oldest enabled offset-0 email rule for the shop, or null when none exists
 * (in which case the live write creates seed-g4-rule0-<shop>).
 *
 * This is the single source of truth shared by BOTH the dry run (which reports
 * rule="would_reuse"/"would_create") and the live write (which reports
 * "reused"/"created" and performs the insert), so the two paths cannot diverge.
 * The SELECT is identical to the one the live write used before this helper.
 */
async function findReusableOffsetZeroEmailRule(
  tx: Sql,
  shopId: string
): Promise<{ id: string } | null> {
  const [row] = await tx<{ id: string }[]>`
    SELECT id FROM "ReminderRule"
    WHERE "shopId" = ${shopId} AND "offsetDays" = 0 AND channel = 'email' AND enabled
    ORDER BY "createdAt" LIMIT 1
  `;
  return row ?? null;
}

/** Options controlling how far the dry-run side-effect counts look ahead. */
interface G4SideEffectOptions {
  /**
   * Dry-run would_create only: fold non-gated invoices due TODAY (which no
   * existing enabled email rule matches yet) into otherDueToday/otherSendableToday
   * and the wouldEnqueue counts. The live write leaves this false so its counts
   * and the g4_other_buyers_due abort stay exactly as before.
   */
  includeWouldBeOffset0NonGated: boolean;
  /**
   * No existing enabled offset-0 email rule: fold the would-be offset-0 rule
   * (the one the live write creates) into the otherGatedDueToday count, so it
   * reflects the post-write rule set. Only ever changes a reported count.
   */
  includeWouldBeOffset0Gated: boolean;
}

/**
 * Collect the non-fixture reminder side effects for the shop: the rows the run
 * could create OUTSIDE the fixture when reminders turn ON, plus existing log
 * counts. Recipient deliverability is classified by the pure isSendableRecipient
 * (CI cannot read the Worker allowlist). Addresses are never returned, only counts.
 */
async function collectG4SideEffects(
  tx: Sql,
  shopId: string,
  fixtureInvoiceId: string,
  tz: string,
  opts: G4SideEffectOptions
): Promise<G4SideEffects> {
  // One row per (invoice, enabled email rule) pair the enqueue would pick today,
  // mirroring s18_enqueue_reminders (gated accounts excluded, no existing log).
  // Email filter mirrors the migration: COMPANY uses mainContactEmail; otherwise
  // if customerId is set, s8_tagged_customers.email; otherwise no email (excluded).
  const pairs = await tx<{ invoice_id: string; email: string | null; opted_out: boolean }[]>`
    SELECT
      i.id AS invoice_id,
      lower(COALESCE(NULLIF(trim(ba."mainContactEmail"), ''), tc.email)) AS email,
      (ba."reminderOptOutAt" IS NOT NULL) AS opted_out
    FROM "Invoice" i
    JOIN "BuyerAccount" ba ON ba.id = i."buyerAccountId" AND ba."shopId" = i."shopId"
    LEFT JOIN s8_tagged_customers tc
      ON ba.kind = 'TAGGED_CUSTOMER' AND tc.shop_id = ba."shopId" AND tc.customer_id = ba."customerId"
    JOIN "ReminderRule" r ON r."shopId" = i."shopId" AND r.enabled AND r.channel = 'email'
    WHERE i."shopId" = ${shopId} AND i.id <> ${fixtureInvoiceId}
      AND ba.gated_at IS NULL
      AND i.status = 'open' AND i."dueAt" IS NOT NULL AND i.outstanding > 0
      AND ((i."dueAt" AT TIME ZONE ${tz})::date + r."offsetDays") = (now() AT TIME ZONE ${tz})::date
      AND NOT EXISTS (
        SELECT 1 FROM "ReminderLog" rl WHERE rl."ruleId" = r.id AND rl."invoiceId" = i.id
      )
      AND (
        CASE
          WHEN ba.kind = 'COMPANY' THEN btrim(COALESCE(ba."mainContactEmail", '')) <> ''
          WHEN ba."customerId" IS NOT NULL THEN EXISTS (
            SELECT 1 FROM s8_tagged_customers tc2
            WHERE tc2.shop_id = i."shopId" AND tc2.customer_id = ba."customerId"
              AND btrim(COALESCE(tc2.email, '')) <> ''
          )
          ELSE false
        END
      )
  `;

  const dueInvoices = new Set<string>();
  const sendableInvoices = new Set<string>();
  let expectedSend = 0;
  let wouldEnqueue = pairs.length;
  for (const row of pairs) {
    dueInvoices.add(row.invoice_id);
    const sendable = !row.opted_out && row.email !== null && isSendableRecipient(row.email);
    if (sendable) {
      sendableInvoices.add(row.invoice_id);
      expectedSend += 1;
    }
  }

  if (opts.includeWouldBeOffset0NonGated) {
    // would_create gap: with no enabled offset-0 email rule, the pairs query
    // above matches NO non-gated invoice due TODAY (an offset-0 match needs an
    // offset-0 rule). The live write creates seed-g4-rule0-<shop>, after which
    // the enqueue WOULD pick those invoices up. A dry run folds them in here so
    // other_due_today / other_sendable_today describe the post-write state. The
    // NOT EXISTS keeps this disjoint from the pairs above, so there is no double
    // count. The live write passes false, leaving its counts and abort unchanged.
    // Email filter mirrors the migration (same as pairs query).
    const extra = await tx<{ invoice_id: string; email: string | null; opted_out: boolean }[]>`
      SELECT
        i.id AS invoice_id,
        lower(COALESCE(NULLIF(trim(ba."mainContactEmail"), ''), tc.email)) AS email,
        (ba."reminderOptOutAt" IS NOT NULL) AS opted_out
      FROM "Invoice" i
      JOIN "BuyerAccount" ba ON ba.id = i."buyerAccountId" AND ba."shopId" = i."shopId"
      LEFT JOIN s8_tagged_customers tc
        ON ba.kind = 'TAGGED_CUSTOMER' AND tc.shop_id = ba."shopId" AND tc.customer_id = ba."customerId"
      WHERE i."shopId" = ${shopId} AND i.id <> ${fixtureInvoiceId}
        AND ba.gated_at IS NULL
        AND i.status = 'open' AND i."dueAt" IS NOT NULL AND i.outstanding > 0
        AND (i."dueAt" AT TIME ZONE ${tz})::date = (now() AT TIME ZONE ${tz})::date
        AND NOT EXISTS (
          SELECT 1 FROM "ReminderRule" r
          WHERE r."shopId" = i."shopId" AND r.enabled AND r.channel = 'email'
            AND ((i."dueAt" AT TIME ZONE ${tz})::date + r."offsetDays") = (now() AT TIME ZONE ${tz})::date
        )
        AND (
          CASE
            WHEN ba.kind = 'COMPANY' THEN btrim(COALESCE(ba."mainContactEmail", '')) <> ''
            WHEN ba."customerId" IS NOT NULL THEN EXISTS (
              SELECT 1 FROM s8_tagged_customers tc2
              WHERE tc2.shop_id = i."shopId" AND tc2.customer_id = ba."customerId"
                AND btrim(COALESCE(tc2.email, '')) <> ''
            )
            ELSE false
          END
        )
    `;
    for (const row of extra) {
      dueInvoices.add(row.invoice_id);
      wouldEnqueue += 1;
      const sendable = !row.opted_out && row.email !== null && isSendableRecipient(row.email);
      if (sendable) {
        sendableInvoices.add(row.invoice_id);
        expectedSend += 1;
      }
    }
  }

  // OTHER (non-fixture) GATED buyers' open invoices due today (counts only). The
  // enqueue skips gated accounts, so these never appear in the counts above; this
  // separate key reports them. When no enabled offset-0 email rule exists the
  // would-be offset-0 rule is folded in (second disjunct) to match the post-write
  // rule set. Uses the same date expression as the pairs query.
  // Email filter: buyers without email wouldn't be enqueued anyway; exclude them.
  const gatedRows = await tx<{ invoice_id: string }[]>`
    SELECT DISTINCT i.id AS invoice_id
    FROM "Invoice" i
    JOIN "BuyerAccount" ba ON ba.id = i."buyerAccountId" AND ba."shopId" = i."shopId"
    WHERE i."shopId" = ${shopId} AND i.id <> ${fixtureInvoiceId}
      AND ba.gated_at IS NOT NULL
      AND i.status = 'open' AND i."dueAt" IS NOT NULL AND i.outstanding > 0
      AND (
        EXISTS (
          SELECT 1 FROM "ReminderRule" r
          WHERE r."shopId" = i."shopId" AND r.enabled AND r.channel = 'email'
            AND ((i."dueAt" AT TIME ZONE ${tz})::date + r."offsetDays") = (now() AT TIME ZONE ${tz})::date
        )
        OR (
          ${opts.includeWouldBeOffset0Gated}::boolean
          AND (i."dueAt" AT TIME ZONE ${tz})::date = (now() AT TIME ZONE ${tz})::date
        )
      )
      AND (
        CASE
          WHEN ba.kind = 'COMPANY' THEN btrim(COALESCE(ba."mainContactEmail", '')) <> ''
          WHEN ba."customerId" IS NOT NULL THEN EXISTS (
            SELECT 1 FROM s8_tagged_customers tc2
            WHERE tc2.shop_id = i."shopId" AND tc2.customer_id = ba."customerId"
              AND btrim(COALESCE(tc2.email, '')) <> ''
          )
          ELSE false
        END
      )
  `;
  const otherGatedDueToday = gatedRows.length;

  const logRows = await tx<{ status: string; c: number }[]>`
    SELECT status::text AS status, count(*)::int AS c
    FROM "ReminderLog"
    WHERE "shopId" = ${shopId} AND "invoiceId" <> ${fixtureInvoiceId}
    GROUP BY status
  `;
  const existingLogsByStatus: Record<string, number> = {};
  for (const row of logRows) existingLogsByStatus[row.status] = row.c;

  return {
    otherDueToday: dueInvoices.size,
    otherSendableToday: sendableInvoices.size,
    otherGatedDueToday,
    wouldEnqueueNonFixture: wouldEnqueue,
    wouldEnqueueExpectedSkip: wouldEnqueue - expectedSend,
    wouldEnqueueExpectedSend: expectedSend,
    existingLogsByStatus,
  };
}

async function countQueuedReminders(tx: Sql, shopId: string): Promise<number> {
  const [row] = await tx<{ c: number }[]>`
    SELECT count(*)::int AS c FROM pgmq.q_s6_sync
    WHERE message->>'shopId' = ${shopId}
      AND message->>'topic' IN ('REMINDER_SEND', 'REMINDER_CATCHUP')
  `;
  return row.c;
}

async function countFixtureLogs(tx: Sql, fixtureInvoiceId: string): Promise<number> {
  const [row] = await tx<{ c: number }[]>`
    SELECT count(*)::int AS c FROM "ReminderLog" WHERE "invoiceId" = ${fixtureInvoiceId}
  `;
  return row.c;
}

/**
 * Whether a foreign row already holds the fixture's (shop, location) slot.
 * Read-only mirror of the live buyer upsert's conflict guard: the upsert only
 * adopts our own id, so a different id on that slot makes the live write throw
 * g4_fixture_slot_taken. Used so a dry run can report the slot without writing.
 */
async function isFixtureSlotTaken(
  tx: Sql,
  shopId: string,
  companyLocationId: string,
  accountId: string
): Promise<boolean> {
  const [row] = await tx<{ c: number }[]>`
    SELECT count(*)::int AS c FROM "BuyerAccount"
    WHERE "shopId" = ${shopId} AND "companyLocationId" = ${companyLocationId}
      AND id <> ${accountId}
  `;
  return row.c > 0;
}

/** Non-fixture ReminderLog rows on the shop (invoiceId <> fixture), grouped by status. */
async function nonFixtureReminderLogByStatus(
  tx: Sql,
  shopId: string,
  fixtureInvoiceId: string
): Promise<Record<string, number>> {
  const rows = await tx<{ status: string; c: number }[]>`
    SELECT status::text AS status, count(*)::int AS c
    FROM "ReminderLog"
    WHERE "shopId" = ${shopId} AND "invoiceId" <> ${fixtureInvoiceId}
    GROUP BY status
  `;
  const byStatus: Record<string, number> = {};
  for (const row of rows) byStatus[row.status] = row.c;
  return byStatus;
}

/** Non-fixture reminder queue messages on the shop (invoiceId <> fixture). */
async function countNonFixtureQueued(
  tx: Sql,
  shopId: string,
  fixtureInvoiceId: string
): Promise<number> {
  const [row] = await tx<{ c: number }[]>`
    SELECT count(*)::int AS c FROM pgmq.q_s6_sync
    WHERE message->>'shopId' = ${shopId}
      AND message->>'topic' IN ('REMINDER_SEND', 'REMINDER_CATCHUP')
      AND COALESCE(message->>'invoiceId', '') <> ${fixtureInvoiceId}
  `;
  return row.c;
}

/**
 * Fixed-key, PII-free result of the write pre-checks. A dry run always reports
 * these (never aborting on a failed check); a live write enforces them instead,
 * throwing the matching existing `g4_*` code.
 */
export interface G4WriteChecks {
  /** Write window open now (false ⇒ live write throws g4_outside_send_window). */
  writeWindowOk: boolean;
  /** No other deliverable buyer due today (false ⇒ live throws g4_other_buyers_due). */
  otherSendableOk: boolean;
  /**
   * Whether the fixture slot is free. "taken" when a foreign row holds the
   * (shop, location) slot (live ⇒ g4_fixture_slot_taken) or the fixture invoice
   * already has a ReminderLog (live ⇒ g4_fixture_already_used).
   */
  fixtureSlot: "free" | "taken";
}

export interface G4WriteResult {
  mode: "write";
  dryRun: boolean;
  store: "resolved";
  prior: RemindersSetting;
  /**
   * Live write: "reused" (an enabled offset-0 email rule already existed) or
   * "created" (the fixture created seed-g4-rule0-<shop>). Dry run: the read-only
   * prediction of the same decision, "would_reuse" / "would_create".
   */
  rule: "reused" | "created" | "would_reuse" | "would_create";
  fixture: "written" | "would_write";
  reminders: "on" | "unchanged";
  queued: number;
  sideEffects: G4SideEffects;
  /** The pre-check outcomes (reported on a dry run, enforced on a live write). */
  checks: G4WriteChecks;
  /** The write window (times/offsets only) used to gate this run. */
  window: G4WriteWindow;
}

export interface G4WriteParams {
  shopDomain: string;
  recipient: string;
  dryRun: boolean;
  /** Test seam: overrides the guard clock. Defaults to the DB now() (one clock). */
  now?: Date;
}

/**
 * Write the G4 fixture in a single transaction (or a READ ONLY dry run).
 * Order: capture prior setting, buyer, rule, invoice, reminders ON last.
 *
 * A live write still aborts, with the existing `g4_*` codes, outside the write
 * window, when another deliverable buyer is due today, or when the fixture slot
 * is taken/already used. A dry run never aborts on those pre-checks: it reports
 * each as a fixed-key enum/boolean (G4WriteChecks) and returns, so only a real
 * error (store not resolving, not INR, or a DB error) makes a dry run fail.
 */
export async function runG4Write(sql: Sql, params: G4WriteParams): Promise<G4WriteResult> {
  const { shopDomain, recipient, dryRun } = params;
  const work = async (tx: Sql): Promise<G4WriteResult> => {
    const store = await resolveStore(tx, shopDomain, true, !dryRun);
    if (store.currency !== "INR") {
      throw new Error("g4_store_not_inr");
    }
    const now = params.now ?? store.dbNow;
    const window = computeG4WriteWindow(now, store.tz);

    // A real write aborts immediately when outside the window, before any reads
    // or writes. A dry run keeps going so it can still report the window check.
    if (!dryRun && !window.writeWindowOk) {
      throw new Error("g4_outside_send_window");
    }

    const ids = g4FixtureIds(store.id);

    // Shared, read-only rule lookup so the dry run's prediction and the live
    // write's action cannot diverge. null => no enabled offset-0 email rule, so
    // the live write would CREATE seed-g4-rule0-<shop>.
    const reusableRule = await findReusableOffsetZeroEmailRule(tx, store.id);
    const offsetZeroWouldBeCreated = reusableRule === null;

    const sideEffects = await collectG4SideEffects(tx, store.id, ids.invoice, store.tz, {
      // Only a dry run folds the would-be offset-0 rule into other_due_today /
      // other_sendable_today; the live write keeps its counts and abort unchanged.
      includeWouldBeOffset0NonGated: dryRun && offsetZeroWouldBeCreated,
      includeWouldBeOffset0Gated: offsetZeroWouldBeCreated,
    });
    const queued = await countQueuedReminders(tx, store.id);
    const fixtureLogs = await countFixtureLogs(tx, ids.invoice);
    const slotTaken = await isFixtureSlotTaken(tx, store.id, ids.location, ids.account);

    const checks: G4WriteChecks = {
      writeWindowOk: window.writeWindowOk,
      otherSendableOk: sideEffects.otherSendableToday === 0,
      fixtureSlot: slotTaken || fixtureLogs > 0 ? "taken" : "free",
    };

    if (dryRun) {
      // READ ONLY: report every pre-check without aborting. Only real errors
      // (handled above / by the DB) make a dry run fail.
      return {
        mode: "write",
        dryRun: true,
        store: "resolved",
        prior: store.remindersSetting,
        rule: offsetZeroWouldBeCreated ? "would_create" : "would_reuse",
        fixture: "would_write",
        reminders: "unchanged",
        queued,
        sideEffects,
        checks,
        window,
      } satisfies G4WriteResult;
    }

    // Live write: enforce the remaining pre-checks with the existing codes.
    // Abort ONLY when a non-fixture due-today recipient looks deliverable.
    if (sideEffects.otherSendableToday > 0) {
      throw new Error("g4_other_buyers_due");
    }
    if (fixtureLogs > 0) {
      throw new Error("g4_fixture_already_used");
    }

    // (1) record prior setting once (ON CONFLICT keeps the first capture)
    await tx`
      INSERT INTO "AuditEvent" (id, "shopId", actor, type, data, at)
      VALUES (
        ${ids.prior}, ${store.id}, 'seed', 'seed.g4_fixture.prior_settings',
        jsonb_build_object('prior', ${store.remindersSetting}::text),
        now()
      )
      ON CONFLICT (id) DO NOTHING
    `;

    // (2) buyer (COMPANY); clear both opt-out columns together (CHECK). Only
    // ever adopts our own row; a foreign row holding the slot aborts.
    const buyer = await tx<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "mainContactEmail",
        "holdState", gated_at, "reminderOptOutAt", "reminderOptOutSource", "createdAt", "updatedAt"
      )
      VALUES (
        ${ids.account}, ${store.id}, 'COMPANY', ${ids.company}, ${ids.location},
        'NTR Seed G4 Fixture', ${recipient},
        'OK', NULL, NULL, NULL, now(), now()
      )
      ON CONFLICT ("shopId", "companyLocationId") DO UPDATE
        SET "mainContactEmail" = EXCLUDED."mainContactEmail", gated_at = NULL,
            "reminderOptOutAt" = NULL, "reminderOptOutSource" = NULL
      WHERE "BuyerAccount".id = EXCLUDED.id
      RETURNING id
    `;
    if (buyer.length === 0) {
      throw new Error("g4_fixture_slot_taken");
    }

    // (3) rule: reuse an enabled offset-0 email rule, else create a seed rule.
    // Reuses the shared read-only lookup above (same SELECT, same ordering).
    let ruleOutcome: "reused" | "created";
    if (reusableRule) {
      ruleOutcome = "reused";
    } else {
      await tx`
        INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
        VALUES (${ids.rule}, ${store.id}, 0, 'email', true, now(), now())
        ON CONFLICT (id) DO UPDATE SET enabled = true
      `;
      ruleOutcome = "created";
    }

    // (4) invoice: OPEN, 1000.00, due today 12:00 shop-local; synthetic orderId
    // satisfies Invoice_order_xor_draft
    await tx`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        "issuedAt", "dueAt", "dueSource", "dueBasis", status, "createdAt", "updatedAt"
      )
      VALUES (
        ${ids.invoice}, ${store.id}, ${ids.account}, ${ids.order}, 'NTR-SEED-G4-1', 1000.00, 1000.00,
        now() - interval '30 days',
        (((now() AT TIME ZONE ${store.tz})::date + time '12:00') AT TIME ZONE ${store.tz}),
        'none', 'ntr-seed-g4', 'open', now(), now()
      )
      ON CONFLICT (id) DO UPDATE
        SET status = 'open', total = 1000.00, outstanding = 1000.00,
            "dueAt" = EXCLUDED."dueAt", "orderId" = EXCLUDED."orderId"
    `;

    // (5) LAST: reminders ON
    await tx`
      INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
      VALUES (${store.id}, true, now(), now())
      ON CONFLICT (shop_id) DO UPDATE SET enabled = true
    `;

    return {
      mode: "write",
      dryRun: false,
      store: "resolved",
      prior: store.remindersSetting,
      rule: ruleOutcome,
      fixture: "written",
      reminders: "on",
      queued,
      sideEffects,
      checks,
      window,
    } satisfies G4WriteResult;
  };
  return dryRun ? sql.begin("READ ONLY", work) : sql.begin(work);
}

export interface G4CleanupResult {
  mode: "cleanup";
  dryRun: boolean;
  store: "resolved";
  prior: RemindersSetting | "unknown";
  fixture: "deleted" | "would_delete";
  queued: number;
  /** Non-fixture ReminderLog rows on the shop (invoiceId <> fixture), by status. */
  nonfixtureReminderLogByStatus: Record<string, number>;
  /** Non-fixture reminder queue messages on the shop (invoiceId <> fixture). */
  nonfixtureQueued: number;
  /** The cleanup window (UTC minute only) used to gate this run. */
  window: G4CleanupWindow;
}

export interface G4CleanupParams {
  shopDomain: string;
  dryRun: boolean;
  /** Test seam: overrides the guard clock. Defaults to the DB now() (one clock). */
  now?: Date;
}

/**
 * Clean up the G4 fixture: restore the previous reminder setting FIRST, then
 * delete only the fixture's own seed-tagged rows. Refuses during the UTC-minute
 * blackout around the :15 enqueue and when a Match blocks invoice deletion.
 */
export async function runG4Cleanup(sql: Sql, params: G4CleanupParams): Promise<G4CleanupResult> {
  const { shopDomain, dryRun } = params;
  const work = async (tx: Sql): Promise<G4CleanupResult> => {
    const store = await resolveStore(tx, shopDomain, false, !dryRun);
    const now = params.now ?? store.dbNow;
    assertNotCleanupBlackout(now);
    const window = computeG4CleanupWindow(now);

    const ids = g4FixtureIds(store.id);
    const queued = await countQueuedReminders(tx, store.id);

    // (b) Non-fixture side effects to REPORT (never delete). Read before any
    // delete; the deletes only touch fixture rows, so these counts describe the
    // rows that remain in place.
    const nonfixtureReminderLogByStatus = await nonFixtureReminderLogByStatus(tx, store.id, ids.invoice);
    const nonfixtureQueued = await countNonFixtureQueued(tx, store.id, ids.invoice);

    // (1) read prior setting from the DB record
    const [priorRow] = await tx<{ prior: string | null }[]>`
      SELECT data->>'prior' AS prior FROM "AuditEvent" WHERE id = ${ids.prior} AND "shopId" = ${store.id}
    `;
    const prior: RemindersSetting | "unknown" = priorRow
      ? ((priorRow.prior ?? "unknown") as RemindersSetting | "unknown")
      : "unknown";

    // (3) blockers: a Match on the fixture invoice would block deletion (FK NoAction)
    const [matchRow] = await tx<{ c: number }[]>`
      SELECT count(*)::int AS c FROM "Match" WHERE "invoiceId" = ${ids.invoice}
    `;
    if (matchRow.c > 0) {
      throw new Error("g4_cleanup_blocked");
    }

    if (dryRun) {
      return {
        mode: "cleanup",
        dryRun: true,
        store: "resolved",
        prior,
        fixture: "would_delete",
        queued,
        nonfixtureReminderLogByStatus,
        nonfixtureQueued,
        window,
      } satisfies G4CleanupResult;
    }

    // (1) restore prior reminder setting FIRST
    if (prior === "on") {
      await tx`UPDATE s18_shop_reminder_settings SET enabled = true WHERE shop_id = ${store.id}`;
    } else if (prior === "off") {
      await tx`UPDATE s18_shop_reminder_settings SET enabled = false WHERE shop_id = ${store.id}`;
    } else if (prior === "absent") {
      await tx`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${store.id}`;
    } else {
      // no prior record: fail safe by stopping sends
      await tx`
        INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
        VALUES (${store.id}, false, now(), now())
        ON CONFLICT (shop_id) DO UPDATE SET enabled = false
      `;
    }

    // (4) delete only the fixture rows, FK-safe order
    await tx`DELETE FROM "ReminderLog" WHERE "invoiceId" = ${ids.invoice} AND "shopId" = ${store.id}`;
    await tx`
      DELETE FROM "Invoice"
      WHERE id = ${ids.invoice} AND "shopId" = ${store.id}
        AND "orderId" = ${ids.order} AND "dueBasis" = 'ntr-seed-g4'
    `;
    await tx`
      DELETE FROM "ReminderRule" r
      WHERE r.id = ${ids.rule} AND r."shopId" = ${store.id}
        AND NOT EXISTS (SELECT 1 FROM "ReminderLog" rl WHERE rl."ruleId" = r.id)
    `;
    await tx`
      DELETE FROM "BuyerAccount" b
      WHERE b.id = ${ids.account} AND b."shopId" = ${store.id} AND b."companyLocationId" = ${ids.location}
        AND NOT EXISTS (SELECT 1 FROM "Invoice" i WHERE i."buyerAccountId" = b.id)
    `;
    await tx`DELETE FROM "AuditEvent" WHERE id = ${ids.prior} AND "shopId" = ${store.id}`;

    return {
      mode: "cleanup",
      dryRun: false,
      store: "resolved",
      prior,
      fixture: "deleted",
      queued,
      nonfixtureReminderLogByStatus,
      nonfixtureQueued,
      window,
    } satisfies G4CleanupResult;
  };
  return dryRun ? sql.begin("READ ONLY", work) : sql.begin(work);
}

/** Render the non-fixture side effects as fixed-key, PII-free lines (counts only). */
function formatG4SideEffects(s: G4SideEffects): string[] {
  const statuses = Object.keys(s.existingLogsByStatus).sort();
  const logLine =
    statuses.length > 0
      ? statuses.map((k) => `${k}=${s.existingLogsByStatus[k]}`).join(" ")
      : "none";
  return [
    `g4_sideeffects other_due_today=${s.otherDueToday} other_sendable_today=${s.otherSendableToday} ` +
      `other_gated_due_today=${s.otherGatedDueToday}`,
    `g4_sideeffects nonfixture_would_enqueue=${s.wouldEnqueueNonFixture} ` +
      `expected_skip=${s.wouldEnqueueExpectedSkip} expected_send=${s.wouldEnqueueExpectedSend}`,
    `g4_sideeffects nonfixture_reminderlog ${logLine}`,
  ];
}

/** Format the write window as a fixed-key, PII-free line (times and offsets only). */
export function formatG4WindowLine(w: G4WriteWindow): string {
  return (
    `g4_window shop_tz_offset=${w.shopTzOffset} ` +
    `next_enqueue_utc=${w.nextEnqueueUtc}Z ` +
    `next_enqueue_local=${w.nextEnqueueLocal} ` +
    `last_enqueue_local_today=${w.lastEnqueueLocalToday ?? "none"} ` +
    `write_window_ok=${w.writeWindowOk}`
  );
}

/** Format the dry-run pre-checks as a fixed-key, PII-free line (enums/booleans only). */
export function formatG4ChecksLine(c: G4WriteChecks): string {
  return (
    `g4_checks write_window_ok=${c.writeWindowOk} ` +
    `other_sendable_ok=${c.otherSendableOk} ` +
    `fixture_slot=${c.fixtureSlot}`
  );
}

/** Format the cleanup window as a fixed-key, PII-free line (UTC minute only). */
export function formatG4CleanupWindowLine(w: G4CleanupWindow): string {
  return `g4_cleanup_window utc_minute=${String(w.utcMinute).padStart(2, "0")} blocked=${w.blocked}`;
}

/** Format a write result as fixed-key, PII-free output lines. */
export function formatG4WriteOutput(r: G4WriteResult): string[] {
  return [
    formatG4WindowLine(r.window),
    `g4_fixture mode=write dry_run=${r.dryRun} store=${r.store} prior=${r.prior} ` +
      `rule=${r.rule} fixture=${r.fixture} reminders=${r.reminders} queued=${r.queued}`,
    `cleanup_due_before=${G4_CLEANUP_DUE_BEFORE}`,
    formatG4ChecksLine(r.checks),
    ...formatG4SideEffects(r.sideEffects),
  ];
}

/** Format a cleanup result as fixed-key, PII-free output lines (counts only). */
export function formatG4CleanupOutput(r: G4CleanupResult): string[] {
  const statuses = Object.keys(r.nonfixtureReminderLogByStatus).sort();
  const logLine =
    statuses.length > 0
      ? statuses.map((k) => `${k}=${r.nonfixtureReminderLogByStatus[k]}`).join(" ")
      : "none";
  return [
    `g4_fixture mode=cleanup dry_run=${r.dryRun} store=${r.store} prior=${r.prior} ` +
      `fixture=${r.fixture} queued=${r.queued}`,
    formatG4CleanupWindowLine(r.window),
    `g4_cleanup_sideeffects nonfixture_reminderlog ${logLine}`,
    `g4_cleanup_sideeffects nonfixture_queued=${r.nonfixtureQueued}`,
  ];
}
