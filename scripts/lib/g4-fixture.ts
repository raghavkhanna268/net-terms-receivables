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

import type postgres from "postgres";
// Leaf module (no imports of its own); parses RESEND_TEST_RECIPIENTS the same way.
import { parseRecipientAllowlist } from "../../app/services/recipient-allowlist.server";

type Sql = ReturnType<typeof postgres>;

/** GitHub repo secret that carries the fixture recipient (never a workflow input). */
export const G4_RECIPIENT_ENV = "G4_TEST_RECIPIENT" as const;

/** Fixed line printed on write: cleanup must run the same day before this UTC time. */
export const G4_CLEANUP_DUE_BEFORE = "02:00Z" as const;

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

/**
 * Write-window guard (shop-local): offset-0 reminders can only fire today when
 * the write lands between 09:00 and 18:45 shop-local. Throws
 * `g4_outside_send_window` otherwise.
 */
export function assertWithinWriteWindow(localHour: number, localMinute: number): void {
  const minutes = localHour * 60 + localMinute;
  const start = 9 * 60; // 09:00
  const end = 18 * 60 + 45; // 18:45
  if (minutes < start || minutes > end) {
    throw new Error("g4_outside_send_window");
  }
}

/**
 * Cleanup blackout guard (shop-local): a reminder enqueued at the last :45 run
 * still sends after cleanup disables reminders, so refuse to clean up during
 * the XX:44–XX:50 shop-local block. Throws `g4_cleanup_wait`.
 */
export function assertNotCleanupBlackout(localMinute: number): void {
  if (localMinute >= 44 && localMinute <= 50) {
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
  localHour: number;
  localMinute: number;
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
      local_hour: number;
      local_minute: number;
      reminders_setting: string | null;
    }[]
  >`
    SELECT
      s.id,
      public.s18_safe_timezone(s.timezone) AS tz,
      s.currency,
      EXTRACT(HOUR FROM (now() AT TIME ZONE public.s18_safe_timezone(s.timezone)))::int AS local_hour,
      EXTRACT(MINUTE FROM (now() AT TIME ZONE public.s18_safe_timezone(s.timezone)))::int AS local_minute,
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
    localHour: row.local_hour,
    localMinute: row.local_minute,
    remindersSetting: (row.reminders_setting ?? "absent") as RemindersSetting,
  };
}

export interface G4SideEffects {
  /** Distinct non-fixture invoices that would fire today (any enabled rule). */
  otherDueToday: number;
  /** Distinct non-fixture invoices due today whose recipient looks deliverable. */
  otherSendableToday: number;
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
 * Collect the non-fixture reminder side effects for the shop: the rows the run
 * could create OUTSIDE the fixture when reminders turn ON, plus existing log
 * counts. Recipient deliverability is classified by the pure isSendableRecipient
 * (CI cannot read the Worker allowlist). Addresses are never returned, only counts.
 */
async function collectG4SideEffects(
  tx: Sql,
  shopId: string,
  fixtureInvoiceId: string,
  tz: string
): Promise<G4SideEffects> {
  // One row per (invoice, enabled email rule) pair the enqueue would pick today,
  // mirroring s18_enqueue_reminders (gated accounts excluded, no existing log).
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
  `;

  const dueInvoices = new Set<string>();
  const sendableInvoices = new Set<string>();
  let expectedSend = 0;
  for (const row of pairs) {
    dueInvoices.add(row.invoice_id);
    const sendable = !row.opted_out && row.email !== null && isSendableRecipient(row.email);
    if (sendable) {
      sendableInvoices.add(row.invoice_id);
      expectedSend += 1;
    }
  }

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
    wouldEnqueueNonFixture: pairs.length,
    wouldEnqueueExpectedSkip: pairs.length - expectedSend,
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

export interface G4WriteResult {
  mode: "write";
  dryRun: boolean;
  store: "resolved";
  prior: RemindersSetting;
  rule: "reused" | "created";
  fixture: "written" | "would_write";
  reminders: "on" | "unchanged";
  queued: number;
  sideEffects: G4SideEffects;
}

export interface G4WriteParams {
  shopDomain: string;
  recipient: string;
  dryRun: boolean;
}

/**
 * Write the G4 fixture in a single transaction (or a READ ONLY dry run).
 * Order: capture prior setting, buyer, rule, invoice, reminders ON last.
 * Refuses outside the write window and when other sendable buyers are due today
 * or the fixture was already used.
 */
export async function runG4Write(sql: Sql, params: G4WriteParams): Promise<G4WriteResult> {
  const { shopDomain, recipient, dryRun } = params;
  const work = async (tx: Sql): Promise<G4WriteResult> => {
    const store = await resolveStore(tx, shopDomain, true, !dryRun);
    if (store.currency !== "INR") {
      throw new Error("g4_store_not_inr");
    }
    assertWithinWriteWindow(store.localHour, store.localMinute);

    const ids = g4FixtureIds(store.id);
    const sideEffects = await collectG4SideEffects(tx, store.id, ids.invoice, store.tz);
    const queued = await countQueuedReminders(tx, store.id);
    const fixtureLogs = await countFixtureLogs(tx, ids.invoice);

    // Abort ONLY when a non-fixture due-today recipient looks deliverable.
    if (sideEffects.otherSendableToday > 0) {
      throw new Error("g4_other_buyers_due");
    }
    if (fixtureLogs > 0) {
      throw new Error("g4_fixture_already_used");
    }

    if (dryRun) {
      return {
        mode: "write",
        dryRun: true,
        store: "resolved",
        prior: store.remindersSetting,
        rule: "reused",
        fixture: "would_write",
        reminders: "unchanged",
        queued,
        sideEffects,
      } satisfies G4WriteResult;
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

    // (3) rule: reuse an enabled offset-0 email rule, else create a seed rule
    const existingRule = await tx<{ id: string }[]>`
      SELECT id FROM "ReminderRule"
      WHERE "shopId" = ${store.id} AND "offsetDays" = 0 AND channel = 'email' AND enabled
      ORDER BY "createdAt" LIMIT 1
    `;
    let ruleOutcome: "reused" | "created";
    if (existingRule.length > 0) {
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
}

export interface G4CleanupParams {
  shopDomain: string;
  dryRun: boolean;
}

/**
 * Clean up the G4 fixture: restore the previous reminder setting FIRST, then
 * delete only the fixture's own seed-tagged rows. Refuses during the
 * XX:44–XX:50 shop-local blackout and when a Match blocks invoice deletion.
 */
export async function runG4Cleanup(sql: Sql, params: G4CleanupParams): Promise<G4CleanupResult> {
  const { shopDomain, dryRun } = params;
  const work = async (tx: Sql): Promise<G4CleanupResult> => {
    const store = await resolveStore(tx, shopDomain, false, !dryRun);
    assertNotCleanupBlackout(store.localMinute);

    const ids = g4FixtureIds(store.id);
    const queued = await countQueuedReminders(tx, store.id);

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
    `g4_sideeffects other_due_today=${s.otherDueToday} other_sendable_today=${s.otherSendableToday}`,
    `g4_sideeffects nonfixture_would_enqueue=${s.wouldEnqueueNonFixture} ` +
      `expected_skip=${s.wouldEnqueueExpectedSkip} expected_send=${s.wouldEnqueueExpectedSend}`,
    `g4_sideeffects nonfixture_reminderlog ${logLine}`,
  ];
}

/** Format a write result as fixed-key, PII-free output lines. */
export function formatG4WriteOutput(r: G4WriteResult): string[] {
  return [
    `g4_fixture mode=write dry_run=${r.dryRun} store=${r.store} prior=${r.prior} ` +
      `rule=${r.rule} fixture=${r.fixture} reminders=${r.reminders} queued=${r.queued}`,
    `cleanup_due_before=${G4_CLEANUP_DUE_BEFORE}`,
    ...formatG4SideEffects(r.sideEffects),
  ];
}

/** Format a cleanup result as fixed-key, PII-free output lines. */
export function formatG4CleanupOutput(r: G4CleanupResult): string[] {
  return [
    `g4_fixture mode=cleanup dry_run=${r.dryRun} store=${r.store} prior=${r.prior} ` +
      `fixture=${r.fixture} queued=${r.queued}`,
  ];
}
