/**
 * DB-backed integration tests for the G4 reminder delivery fixture.
 *
 * Uses real Postgres + pgmq. All data is synthetic: test-*.myshopify.com
 * domains and example.com addresses only; no gid:// strings, amounts aside
 * from the fixture's own, and no real recipients.
 *
 * The write guard derives its window from the DB clock (now()), so the shop
 * timezone is chosen from the DB instant to put the shop-local hour in 09-18.
 * The cleanup guard is gated on the UTC minute (blocked at :14-:20 around the
 * :15 enqueue), independent of the shop timezone; cleanup tests inject a fixed
 * `now` with a safe UTC minute rather than trying to dodge the block via a zone.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { assertNoQueueLeftovers } from "../../tests/helpers/queue-leftovers";
import {
  formatG4CleanupOutput,
  formatG4WriteOutput,
  g4FixtureIds,
  runG4Cleanup,
  runG4Write,
} from "../lib/g4-fixture";

const RESEND_URL = "https://api.resend.com/emails";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

type Sql = ReturnType<typeof postgres>;

/** An Etc/GMT zone that maps the DB instant to a given local hour. */
function etcZoneForLocalHour(dbNow: Date, targetHour: number): string {
  const utcHour = dbNow.getUTCHours();
  for (let n = -14; n <= 12; n++) {
    const localHour = (((utcHour - n) % 24) + 24) % 24;
    if (localHour === targetHour) {
      if (n === 0) return "Etc/GMT";
      return n > 0 ? `Etc/GMT+${n}` : `Etc/GMT${n}`;
    }
  }
  throw new Error("no zone for target hour");
}

/**
 * A fixed instant whose UTC minute (30) is safely outside the cleanup blackout
 * (:14-:20). The cleanup guard only reads the UTC minute, so cleanup tests pass
 * this as `now`; the shop timezone no longer affects whether cleanup is blocked.
 */
const SAFE_CLEANUP_NOW = new Date("2026-10-27T12:30:00Z");

describeWithDb("G4 reminder fixture (DB)", () => {
  let sql: Sql;
  const domains: string[] = [];

  beforeAll(() => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    for (const domain of domains) {
      await cleanupByDomain(sql, domain);
    }
    if (domains.length > 0) {
      await assertNoQueueLeftovers(sql, domains, "g4-fixture-db.test.ts");
    }
    await sql.end();
  });

  async function dbNow(): Promise<Date> {
    const [row] = await sql<{ now: Date }[]>`SELECT now() AS now`;
    return row.now;
  }

  let counter = 0;
  function freshSuffix(): string {
    counter += 1;
    return `${Date.now().toString(36)}-g4-${counter}`;
  }

  async function insertShop(opts: {
    suffix: string;
    timezone: string;
    currency?: string;
    seedMarked?: boolean;
  }): Promise<{ shopId: string; domain: string }> {
    const { suffix, timezone, currency = "INR", seedMarked = true } = opts;
    const shopId = seedMarked ? `seed-shop-${suffix}` : `installed-shop-${suffix}`;
    const domain = `test-${suffix}.myshopify.com`;
    await sql`
      INSERT INTO "Shop" (id, domain, currency, plan, timezone, "createdAt", "updatedAt")
      VALUES (${shopId}, ${domain}, ${currency}, 'development', ${timezone}, NOW(), NOW())
    `;
    domains.push(domain);
    return { shopId, domain };
  }

  async function countFixtureRows(shopId: string): Promise<number> {
    const ids = g4FixtureIds(shopId);
    const [row] = await sql<{ c: number }[]>`
      SELECT (
        (SELECT count(*) FROM "BuyerAccount" WHERE id = ${ids.account}) +
        (SELECT count(*) FROM "Invoice" WHERE id = ${ids.invoice}) +
        (SELECT count(*) FROM "AuditEvent" WHERE id = ${ids.prior})
      )::int AS c
    `;
    return row.c;
  }

  it("resolves the seed-marked INR store, writes the fixture, and enqueues exactly one", async () => {
    const suffix = freshSuffix();
    const { shopId, domain } = await insertShop({
      suffix,
      timezone: etcZoneForLocalHour(await dbNow(), 12),
    });

    const result = await runG4Write(sql, {
      shopDomain: domain,
      recipient: "qa-fixture@example.com",
      dryRun: false,
    });

    expect(result.store).toBe("resolved");
    expect(result.fixture).toBe("written");
    expect(result.reminders).toBe("on");
    expect(result.rule).toBe("created");
    // Fresh shop: no non-fixture side effects, and nothing looks deliverable.
    expect(result.sideEffects.otherSendableToday).toBe(0);
    expect(result.sideEffects.wouldEnqueueExpectedSend).toBe(0);
    // Output is counts/enums only (no addresses) and carries the cleanup deadline.
    const output = formatG4WriteOutput(result).join("\n");
    expect(output).toContain("cleanup_due_before=02:00Z");
    expect(output).toContain("g4_sideeffects");
    expect(output).not.toContain("@");

    const ids = g4FixtureIds(shopId);
    const [settings] = await sql<{ enabled: boolean }[]>`
      SELECT enabled FROM s18_shop_reminder_settings WHERE shop_id = ${shopId}
    `;
    expect(settings.enabled).toBe(true);

    const [buyer] = await sql<{ opt: Date | null; gated: Date | null }[]>`
      SELECT "reminderOptOutAt" AS opt, gated_at AS gated FROM "BuyerAccount" WHERE id = ${ids.account}
    `;
    expect(buyer.opt).toBeNull();
    expect(buyer.gated).toBeNull();

    // The enqueue picks up exactly one message for the fixture invoice.
    await sql`SELECT public.s18_enqueue_reminders()`;
    const [enq] = await sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM pgmq.q_s6_sync
      WHERE message->>'shopId' = ${shopId} AND message->>'invoiceId' = ${ids.invoice}
    `;
    expect(enq.c).toBe(1);

    await cleanupByDomain(sql, domain);
  });

  it("dry run writes nothing", async () => {
    const suffix = freshSuffix();
    const { shopId, domain } = await insertShop({
      suffix,
      timezone: etcZoneForLocalHour(await dbNow(), 12),
    });

    const result = await runG4Write(sql, {
      shopDomain: domain,
      recipient: "qa-fixture@example.com",
      dryRun: true,
    });
    expect(result.fixture).toBe("would_write");
    expect(result.reminders).toBe("unchanged");

    expect(await countFixtureRows(shopId)).toBe(0);
    const settings = await sql`SELECT 1 FROM s18_shop_reminder_settings WHERE shop_id = ${shopId}`;
    expect(settings.length).toBe(0);

    await cleanupByDomain(sql, domain);
  });

  // A dry run never aborts on a failed pre-check: it reports each as a fixed-key
  // enum/boolean, writes nothing, and succeeds (exit 0). Only real errors throw.
  it("dry run outside the window reports the closed check and writes nothing", async () => {
    const suffix = freshSuffix();
    const { shopId, domain } = await insertShop({
      suffix,
      timezone: etcZoneForLocalHour(await dbNow(), 3), // 03:xx shop-local
    });

    const result = await runG4Write(sql, {
      shopDomain: domain,
      recipient: "qa-fixture@example.com",
      dryRun: true,
    });

    expect(result.fixture).toBe("would_write");
    expect(result.checks.writeWindowOk).toBe(false);
    expect(result.window.writeWindowOk).toBe(false);
    const output = formatG4WriteOutput(result).join("\n");
    expect(output).toContain("write_window_ok=false");
    expect(output).toContain("g4_checks write_window_ok=false");
    expect(output).not.toContain("@");

    expect(await countFixtureRows(shopId)).toBe(0);
    const settings = await sql`SELECT 1 FROM s18_shop_reminder_settings WHERE shop_id = ${shopId}`;
    expect(settings.length).toBe(0);
    await cleanupByDomain(sql, domain);
  });

  it("dry run with a sendable other buyer reports the check and writes nothing", async () => {
    const suffix = freshSuffix();
    const tz = etcZoneForLocalHour(await dbNow(), 12);
    const { shopId, domain } = await insertShop({ suffix, timezone: tz });

    // A myshopify.com-based address is synthetic yet NOT a reserved test domain,
    // so the pre-flight treats it as deliverable.
    const otherAccount = `other-acct-${suffix}`;
    const otherInvoice = `other-inv-${suffix}`;
    const otherOrder = `free-order-${suffix}`;
    const otherRule = `other-rule-${suffix}`;
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "mainContactEmail", "holdState", "createdAt", "updatedAt")
      VALUES (${otherAccount}, ${shopId}, 'COMPANY', ${`company-${suffix}`}, ${`loc-${suffix}`}, 'Other Buyer', ${`buyer@${domain}`}, 'OK', NOW(), NOW())
    `;
    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${otherRule}, ${shopId}, 0, 'email', true, NOW(), NOW())
    `;
    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, "issuedAt", "dueAt", "dueSource", status, "createdAt", "updatedAt")
      VALUES (
        ${otherInvoice}, ${shopId}, ${otherAccount}, ${otherOrder}, 'OTHER-1', 500.00, 500.00,
        now() - interval '10 days',
        (((now() AT TIME ZONE ${tz})::date + time '12:00') AT TIME ZONE ${tz}),
        'none', 'open', NOW(), NOW()
      )
    `;

    const result = await runG4Write(sql, {
      shopDomain: domain,
      recipient: "qa-fixture@example.com",
      dryRun: true,
    });

    expect(result.fixture).toBe("would_write");
    expect(result.checks.otherSendableOk).toBe(false);
    expect(result.sideEffects.otherSendableToday).toBe(1);
    const output = formatG4WriteOutput(result).join("\n");
    expect(output).toContain("g4_checks write_window_ok=true other_sendable_ok=false fixture_slot=free");
    expect(output).not.toContain("@");

    expect(await countFixtureRows(shopId)).toBe(0);
    await cleanupByDomain(sql, domain);
  });

  it("dry run with a taken fixture slot reports the check and writes nothing", async () => {
    const suffix = freshSuffix();
    const tz = etcZoneForLocalHour(await dbNow(), 12);
    const { shopId, domain } = await insertShop({ suffix, timezone: tz });
    const ids = g4FixtureIds(shopId);

    // A foreign row (different id) already holds the fixture's (shop, location)
    // slot. Its recipient is a reserved test domain, so it is not sendable.
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "mainContactEmail", "holdState", "createdAt", "updatedAt")
      VALUES (${`foreign-acct-${suffix}`}, ${shopId}, 'COMPANY', ${`company-${suffix}`}, ${ids.location}, 'Foreign Holder', 'holder@example.com', 'OK', NOW(), NOW())
    `;

    const result = await runG4Write(sql, {
      shopDomain: domain,
      recipient: "qa-fixture@example.com",
      dryRun: true,
    });

    expect(result.fixture).toBe("would_write");
    expect(result.checks.fixtureSlot).toBe("taken");
    const output = formatG4WriteOutput(result).join("\n");
    expect(output).toContain("g4_checks write_window_ok=true other_sendable_ok=true fixture_slot=taken");
    expect(output).not.toContain("@");

    // Nothing written: the fixture's own rows do not exist.
    expect(await countFixtureRows(shopId)).toBe(0);
    await cleanupByDomain(sql, domain);
  });

  async function countReminderRules(shopId: string): Promise<number> {
    const [row] = await sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM "ReminderRule" WHERE "shopId" = ${shopId}
    `;
    return row.c;
  }

  // Rule reporting: the dry run predicts the live write's reuse/create decision
  // from the shared read-only lookup. Reverting it (dry run hard-codes "reused")
  // makes the would_create case below fail.
  it("dry run with an existing enabled offset-0 email rule reports would_reuse", async () => {
    const suffix = freshSuffix();
    const { shopId, domain } = await insertShop({
      suffix,
      timezone: etcZoneForLocalHour(await dbNow(), 12),
    });
    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${`existing-rule-${suffix}`}, ${shopId}, 0, 'email', true, NOW(), NOW())
    `;

    const result = await runG4Write(sql, {
      shopDomain: domain,
      recipient: "qa-fixture@example.com",
      dryRun: true,
    });

    expect(result.rule).toBe("would_reuse");
    expect(result.fixture).toBe("would_write");
    const output = formatG4WriteOutput(result).join("\n");
    expect(output).toContain("rule=would_reuse");
    expect(output).not.toContain("@");

    // READ ONLY: nothing written and the existing rule is the only one present.
    expect(await countFixtureRows(shopId)).toBe(0);
    expect(await countReminderRules(shopId)).toBe(1);
    await cleanupByDomain(sql, domain);
  });

  it("dry run with no offset-0 email rule reports would_create and writes nothing", async () => {
    const suffix = freshSuffix();
    const { shopId, domain } = await insertShop({
      suffix,
      timezone: etcZoneForLocalHour(await dbNow(), 12),
    });
    const before = await countReminderRules(shopId);

    const result = await runG4Write(sql, {
      shopDomain: domain,
      recipient: "qa-fixture@example.com",
      dryRun: true,
    });

    expect(result.rule).toBe("would_create");
    expect(result.fixture).toBe("would_write");
    const output = formatG4WriteOutput(result).join("\n");
    expect(output).toContain("rule=would_create");

    // READ ONLY: no fixture rows and the rule count is unchanged (none created).
    expect(await countFixtureRows(shopId)).toBe(0);
    expect(await countReminderRules(shopId)).toBe(before);
    expect(await countReminderRules(shopId)).toBe(0);
    await cleanupByDomain(sql, domain);
  });

  // Gated count: an OTHER (non-fixture) gated buyer with an open invoice due
  // today is reported via other_gated_due_today (the would-be offset-0 rule is
  // folded in, since this fresh shop has no offset-0 email rule). The buyer is
  // gated, so it never appears in other_due_today/other_sendable_today. Reverting
  // the gated count makes the otherGatedDueToday assertion fail.
  it("counts a gated other buyer with an invoice due today", async () => {
    const suffix = freshSuffix();
    const tz = etcZoneForLocalHour(await dbNow(), 12);
    const { shopId, domain } = await insertShop({ suffix, timezone: tz });

    const gatedAccount = `gated-acct-${suffix}`;
    const gatedInvoice = `gated-inv-${suffix}`;
    const gatedOrder = `gated-order-${suffix}`;
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "mainContactEmail", "holdState", gated_at, "createdAt", "updatedAt")
      VALUES (${gatedAccount}, ${shopId}, 'COMPANY', ${`company-${suffix}`}, ${`loc-${suffix}`}, 'Gated Buyer', 'gated@example.com', 'OK', now(), NOW(), NOW())
    `;
    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, "issuedAt", "dueAt", "dueSource", status, "createdAt", "updatedAt")
      VALUES (
        ${gatedInvoice}, ${shopId}, ${gatedAccount}, ${gatedOrder}, 'GATED-1', 500.00, 500.00,
        now() - interval '10 days',
        (((now() AT TIME ZONE ${tz})::date + time '12:00') AT TIME ZONE ${tz}),
        'none', 'open', NOW(), NOW()
      )
    `;

    const result = await runG4Write(sql, {
      shopDomain: domain,
      recipient: "qa-fixture@example.com",
      dryRun: true,
    });

    expect(result.sideEffects.otherGatedDueToday).toBe(1);
    // The gated buyer is excluded from the non-gated due/sendable counts.
    expect(result.sideEffects.otherDueToday).toBe(0);
    expect(result.sideEffects.otherSendableToday).toBe(0);
    const output = formatG4WriteOutput(result).join("\n");
    expect(output).toContain("other_gated_due_today=1");
    expect(output).not.toContain("@");

    expect(await countFixtureRows(shopId)).toBe(0);
    await cleanupByDomain(sql, domain);
  });

  it("reports other_gated_due_today=0 when there is no gated buyer due today", async () => {
    const suffix = freshSuffix();
    const { shopId, domain } = await insertShop({
      suffix,
      timezone: etcZoneForLocalHour(await dbNow(), 12),
    });

    const result = await runG4Write(sql, {
      shopDomain: domain,
      recipient: "qa-fixture@example.com",
      dryRun: true,
    });

    expect(result.sideEffects.otherGatedDueToday).toBe(0);
    expect(formatG4WriteOutput(result).join("\n")).toContain("other_gated_due_today=0");

    expect(await countFixtureRows(shopId)).toBe(0);
    await cleanupByDomain(sql, domain);
  });

  // Email filter tests: buyers without email are not counted in wouldEnqueue
  // (matches s18_enqueue_reminders Part 3 filter from #568).

  it("COMPANY with email: counted in wouldEnqueueNonFixture", async () => {
    const suffix = freshSuffix();
    const tz = etcZoneForLocalHour(await dbNow(), 12);
    const { shopId, domain } = await insertShop({ suffix, timezone: tz });

    const otherAccount = `company-with-email-${suffix}`;
    const otherInvoice = `inv-company-email-${suffix}`;
    const otherOrder = `order-company-email-${suffix}`;
    const otherRule = `rule-company-email-${suffix}`;
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "mainContactEmail", "holdState", "createdAt", "updatedAt")
      VALUES (${otherAccount}, ${shopId}, 'COMPANY', ${`company-${suffix}`}, ${`loc-${suffix}`}, 'Company With Email', 'buyer@example.com', 'OK', NOW(), NOW())
    `;
    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${otherRule}, ${shopId}, 0, 'email', true, NOW(), NOW())
    `;
    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, "issuedAt", "dueAt", "dueSource", status, "createdAt", "updatedAt")
      VALUES (
        ${otherInvoice}, ${shopId}, ${otherAccount}, ${otherOrder}, 'INV-1', 500.00, 500.00,
        now() - interval '10 days',
        (((now() AT TIME ZONE ${tz})::date + time '12:00') AT TIME ZONE ${tz}),
        'none', 'open', NOW(), NOW()
      )
    `;

    const result = await runG4Write(sql, {
      shopDomain: domain,
      recipient: "qa-fixture@example.com",
      dryRun: true,
    });

    expect(result.sideEffects.wouldEnqueueNonFixture).toBe(1);
    expect(result.sideEffects.otherDueToday).toBe(1);
    await cleanupByDomain(sql, domain);
  });

  it("COMPANY with NULL email: not counted in wouldEnqueueNonFixture", async () => {
    const suffix = freshSuffix();
    const tz = etcZoneForLocalHour(await dbNow(), 12);
    const { shopId, domain } = await insertShop({ suffix, timezone: tz });

    const otherAccount = `company-null-email-${suffix}`;
    const otherInvoice = `inv-company-null-${suffix}`;
    const otherOrder = `order-company-null-${suffix}`;
    const otherRule = `rule-company-null-${suffix}`;
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "mainContactEmail", "holdState", "createdAt", "updatedAt")
      VALUES (${otherAccount}, ${shopId}, 'COMPANY', ${`company-${suffix}`}, ${`loc-${suffix}`}, 'Company Null Email', NULL, 'OK', NOW(), NOW())
    `;
    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${otherRule}, ${shopId}, 0, 'email', true, NOW(), NOW())
    `;
    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, "issuedAt", "dueAt", "dueSource", status, "createdAt", "updatedAt")
      VALUES (
        ${otherInvoice}, ${shopId}, ${otherAccount}, ${otherOrder}, 'INV-1', 500.00, 500.00,
        now() - interval '10 days',
        (((now() AT TIME ZONE ${tz})::date + time '12:00') AT TIME ZONE ${tz}),
        'none', 'open', NOW(), NOW()
      )
    `;

    const result = await runG4Write(sql, {
      shopDomain: domain,
      recipient: "qa-fixture@example.com",
      dryRun: true,
    });

    expect(result.sideEffects.wouldEnqueueNonFixture).toBe(0);
    expect(result.sideEffects.otherDueToday).toBe(0);
    await cleanupByDomain(sql, domain);
  });

  it("COMPANY with empty string email: not counted in wouldEnqueueNonFixture", async () => {
    const suffix = freshSuffix();
    const tz = etcZoneForLocalHour(await dbNow(), 12);
    const { shopId, domain } = await insertShop({ suffix, timezone: tz });

    const otherAccount = `company-empty-email-${suffix}`;
    const otherInvoice = `inv-company-empty-${suffix}`;
    const otherOrder = `order-company-empty-${suffix}`;
    const otherRule = `rule-company-empty-${suffix}`;
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "mainContactEmail", "holdState", "createdAt", "updatedAt")
      VALUES (${otherAccount}, ${shopId}, 'COMPANY', ${`company-${suffix}`}, ${`loc-${suffix}`}, 'Company Empty Email', '', 'OK', NOW(), NOW())
    `;
    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${otherRule}, ${shopId}, 0, 'email', true, NOW(), NOW())
    `;
    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, "issuedAt", "dueAt", "dueSource", status, "createdAt", "updatedAt")
      VALUES (
        ${otherInvoice}, ${shopId}, ${otherAccount}, ${otherOrder}, 'INV-1', 500.00, 500.00,
        now() - interval '10 days',
        (((now() AT TIME ZONE ${tz})::date + time '12:00') AT TIME ZONE ${tz}),
        'none', 'open', NOW(), NOW()
      )
    `;

    const result = await runG4Write(sql, {
      shopDomain: domain,
      recipient: "qa-fixture@example.com",
      dryRun: true,
    });

    expect(result.sideEffects.wouldEnqueueNonFixture).toBe(0);
    expect(result.sideEffects.otherDueToday).toBe(0);
    await cleanupByDomain(sql, domain);
  });

  it("COMPANY with whitespace-only email: not counted in wouldEnqueueNonFixture", async () => {
    const suffix = freshSuffix();
    const tz = etcZoneForLocalHour(await dbNow(), 12);
    const { shopId, domain } = await insertShop({ suffix, timezone: tz });

    const otherAccount = `company-ws-email-${suffix}`;
    const otherInvoice = `inv-company-ws-${suffix}`;
    const otherOrder = `order-company-ws-${suffix}`;
    const otherRule = `rule-company-ws-${suffix}`;
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "mainContactEmail", "holdState", "createdAt", "updatedAt")
      VALUES (${otherAccount}, ${shopId}, 'COMPANY', ${`company-${suffix}`}, ${`loc-${suffix}`}, 'Company Whitespace Email', '   ', 'OK', NOW(), NOW())
    `;
    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${otherRule}, ${shopId}, 0, 'email', true, NOW(), NOW())
    `;
    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, "issuedAt", "dueAt", "dueSource", status, "createdAt", "updatedAt")
      VALUES (
        ${otherInvoice}, ${shopId}, ${otherAccount}, ${otherOrder}, 'INV-1', 500.00, 500.00,
        now() - interval '10 days',
        (((now() AT TIME ZONE ${tz})::date + time '12:00') AT TIME ZONE ${tz}),
        'none', 'open', NOW(), NOW()
      )
    `;

    const result = await runG4Write(sql, {
      shopDomain: domain,
      recipient: "qa-fixture@example.com",
      dryRun: true,
    });

    expect(result.sideEffects.wouldEnqueueNonFixture).toBe(0);
    expect(result.sideEffects.otherDueToday).toBe(0);
    await cleanupByDomain(sql, domain);
  });

  it("TAGGED_CUSTOMER with email in s8_tagged_customers: counted in wouldEnqueueNonFixture", async () => {
    const suffix = freshSuffix();
    const tz = etcZoneForLocalHour(await dbNow(), 12);
    const { shopId, domain } = await insertShop({ suffix, timezone: tz });

    const otherAccount = `tc-with-email-${suffix}`;
    const otherInvoice = `inv-tc-email-${suffix}`;
    const otherOrder = `order-tc-email-${suffix}`;
    const otherRule = `rule-tc-email-${suffix}`;
    const customerId = `cust-id-${suffix}`;
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "customerId", "companyId", "companyLocationId", name, "mainContactEmail", "holdState", "createdAt", "updatedAt")
      VALUES (${otherAccount}, ${shopId}, 'TAGGED_CUSTOMER', ${customerId}, NULL, NULL, 'Tagged Customer', NULL, 'OK', NOW(), NOW())
    `;
    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, email, created_at)
      VALUES (${shopId}, ${customerId}, 'customer@example.com', NOW())
    `;
    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${otherRule}, ${shopId}, 0, 'email', true, NOW(), NOW())
    `;
    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, "issuedAt", "dueAt", "dueSource", status, "createdAt", "updatedAt")
      VALUES (
        ${otherInvoice}, ${shopId}, ${otherAccount}, ${otherOrder}, 'INV-1', 500.00, 500.00,
        now() - interval '10 days',
        (((now() AT TIME ZONE ${tz})::date + time '12:00') AT TIME ZONE ${tz}),
        'none', 'open', NOW(), NOW()
      )
    `;

    const result = await runG4Write(sql, {
      shopDomain: domain,
      recipient: "qa-fixture@example.com",
      dryRun: true,
    });

    expect(result.sideEffects.wouldEnqueueNonFixture).toBe(1);
    expect(result.sideEffects.otherDueToday).toBe(1);
    await cleanupByDomain(sql, domain);
  });

  it("TAGGED_CUSTOMER with NULL email in s8_tagged_customers: not counted in wouldEnqueueNonFixture", async () => {
    const suffix = freshSuffix();
    const tz = etcZoneForLocalHour(await dbNow(), 12);
    const { shopId, domain } = await insertShop({ suffix, timezone: tz });

    const otherAccount = `tc-null-email-${suffix}`;
    const otherInvoice = `inv-tc-null-${suffix}`;
    const otherOrder = `order-tc-null-${suffix}`;
    const otherRule = `rule-tc-null-${suffix}`;
    const customerId = `cust-null-${suffix}`;
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "customerId", "companyId", "companyLocationId", name, "mainContactEmail", "holdState", "createdAt", "updatedAt")
      VALUES (${otherAccount}, ${shopId}, 'TAGGED_CUSTOMER', ${customerId}, NULL, NULL, 'Tagged Customer Null', NULL, 'OK', NOW(), NOW())
    `;
    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, email, created_at)
      VALUES (${shopId}, ${customerId}, NULL, NOW())
    `;
    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${otherRule}, ${shopId}, 0, 'email', true, NOW(), NOW())
    `;
    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, "issuedAt", "dueAt", "dueSource", status, "createdAt", "updatedAt")
      VALUES (
        ${otherInvoice}, ${shopId}, ${otherAccount}, ${otherOrder}, 'INV-1', 500.00, 500.00,
        now() - interval '10 days',
        (((now() AT TIME ZONE ${tz})::date + time '12:00') AT TIME ZONE ${tz}),
        'none', 'open', NOW(), NOW()
      )
    `;

    const result = await runG4Write(sql, {
      shopDomain: domain,
      recipient: "qa-fixture@example.com",
      dryRun: true,
    });

    expect(result.sideEffects.wouldEnqueueNonFixture).toBe(0);
    expect(result.sideEffects.otherDueToday).toBe(0);
    await cleanupByDomain(sql, domain);
  });

  it("TAGGED_CUSTOMER with no s8_tagged_customers row: not counted in wouldEnqueueNonFixture", async () => {
    const suffix = freshSuffix();
    const tz = etcZoneForLocalHour(await dbNow(), 12);
    const { shopId, domain } = await insertShop({ suffix, timezone: tz });

    const otherAccount = `tc-no-row-${suffix}`;
    const otherInvoice = `inv-tc-no-row-${suffix}`;
    const otherOrder = `order-tc-no-row-${suffix}`;
    const otherRule = `rule-tc-no-row-${suffix}`;
    const customerId = `cust-no-row-${suffix}`;
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "customerId", "companyId", "companyLocationId", name, "mainContactEmail", "holdState", "createdAt", "updatedAt")
      VALUES (${otherAccount}, ${shopId}, 'TAGGED_CUSTOMER', ${customerId}, NULL, NULL, 'Tagged No Row', NULL, 'OK', NOW(), NOW())
    `;
    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${otherRule}, ${shopId}, 0, 'email', true, NOW(), NOW())
    `;
    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, "issuedAt", "dueAt", "dueSource", status, "createdAt", "updatedAt")
      VALUES (
        ${otherInvoice}, ${shopId}, ${otherAccount}, ${otherOrder}, 'INV-1', 500.00, 500.00,
        now() - interval '10 days',
        (((now() AT TIME ZONE ${tz})::date + time '12:00') AT TIME ZONE ${tz}),
        'none', 'open', NOW(), NOW()
      )
    `;

    const result = await runG4Write(sql, {
      shopDomain: domain,
      recipient: "qa-fixture@example.com",
      dryRun: true,
    });

    expect(result.sideEffects.wouldEnqueueNonFixture).toBe(0);
    expect(result.sideEffects.otherDueToday).toBe(0);
    await cleanupByDomain(sql, domain);
  });

  it("gated COMPANY with NULL email: not counted in otherGatedDueToday", async () => {
    const suffix = freshSuffix();
    const tz = etcZoneForLocalHour(await dbNow(), 12);
    const { shopId, domain } = await insertShop({ suffix, timezone: tz });

    const gatedAccount = `gated-null-email-${suffix}`;
    const gatedInvoice = `inv-gated-null-${suffix}`;
    const gatedOrder = `order-gated-null-${suffix}`;
    const gatedRule = `rule-gated-null-${suffix}`;
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "mainContactEmail", "holdState", gated_at, "createdAt", "updatedAt")
      VALUES (${gatedAccount}, ${shopId}, 'COMPANY', ${`company-${suffix}`}, ${`loc-${suffix}`}, 'Gated Null Email', NULL, 'OK', now(), NOW(), NOW())
    `;
    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${gatedRule}, ${shopId}, 0, 'email', true, NOW(), NOW())
    `;
    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, "issuedAt", "dueAt", "dueSource", status, "createdAt", "updatedAt")
      VALUES (
        ${gatedInvoice}, ${shopId}, ${gatedAccount}, ${gatedOrder}, 'INV-1', 500.00, 500.00,
        now() - interval '10 days',
        (((now() AT TIME ZONE ${tz})::date + time '12:00') AT TIME ZONE ${tz}),
        'none', 'open', NOW(), NOW()
      )
    `;

    const result = await runG4Write(sql, {
      shopDomain: domain,
      recipient: "qa-fixture@example.com",
      dryRun: true,
    });

    expect(result.sideEffects.otherGatedDueToday).toBe(0);
    await cleanupByDomain(sql, domain);
  });

  it("gated COMPANY with email: counted in otherGatedDueToday", async () => {
    const suffix = freshSuffix();
    const tz = etcZoneForLocalHour(await dbNow(), 12);
    const { shopId, domain } = await insertShop({ suffix, timezone: tz });

    const gatedAccount = `gated-with-email-${suffix}`;
    const gatedInvoice = `inv-gated-email-${suffix}`;
    const gatedOrder = `order-gated-email-${suffix}`;
    const gatedRule = `rule-gated-email-${suffix}`;
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "mainContactEmail", "holdState", gated_at, "createdAt", "updatedAt")
      VALUES (${gatedAccount}, ${shopId}, 'COMPANY', ${`company-${suffix}`}, ${`loc-${suffix}`}, 'Gated With Email', 'gated@example.com', 'OK', now(), NOW(), NOW())
    `;
    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${gatedRule}, ${shopId}, 0, 'email', true, NOW(), NOW())
    `;
    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, "issuedAt", "dueAt", "dueSource", status, "createdAt", "updatedAt")
      VALUES (
        ${gatedInvoice}, ${shopId}, ${gatedAccount}, ${gatedOrder}, 'INV-1', 500.00, 500.00,
        now() - interval '10 days',
        (((now() AT TIME ZONE ${tz})::date + time '12:00') AT TIME ZONE ${tz}),
        'none', 'open', NOW(), NOW()
      )
    `;

    const result = await runG4Write(sql, {
      shopDomain: domain,
      recipient: "qa-fixture@example.com",
      dryRun: true,
    });

    expect(result.sideEffects.otherGatedDueToday).toBe(1);
    await cleanupByDomain(sql, domain);
  });

  it("allowlist: buyer with reserved domain email counted as wouldEnqueue but expectedSkip (no ReminderLog row)", async () => {
    const suffix = freshSuffix();
    const tz = etcZoneForLocalHour(await dbNow(), 12);
    const { shopId, domain } = await insertShop({ suffix, timezone: tz });

    const otherAccount = `reserved-domain-${suffix}`;
    const otherInvoice = `inv-reserved-${suffix}`;
    const otherOrder = `order-reserved-${suffix}`;
    const otherRule = `rule-reserved-${suffix}`;
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "mainContactEmail", "holdState", "createdAt", "updatedAt")
      VALUES (${otherAccount}, ${shopId}, 'COMPANY', ${`company-${suffix}`}, ${`loc-${suffix}`}, 'Reserved Domain Buyer', 'buyer@test.invalid', 'OK', NOW(), NOW())
    `;
    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${otherRule}, ${shopId}, 0, 'email', true, NOW(), NOW())
    `;
    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, "issuedAt", "dueAt", "dueSource", status, "createdAt", "updatedAt")
      VALUES (
        ${otherInvoice}, ${shopId}, ${otherAccount}, ${otherOrder}, 'INV-1', 500.00, 500.00,
        now() - interval '10 days',
        (((now() AT TIME ZONE ${tz})::date + time '12:00') AT TIME ZONE ${tz}),
        'none', 'open', NOW(), NOW()
      )
    `;

    const result = await runG4Write(sql, {
      shopDomain: domain,
      recipient: "qa-fixture@example.com",
      dryRun: true,
    });

    expect(result.sideEffects.wouldEnqueueNonFixture).toBe(1);
    expect(result.sideEffects.wouldEnqueueExpectedSkip).toBe(1);
    expect(result.sideEffects.wouldEnqueueExpectedSend).toBe(0);
    expect(result.sideEffects.otherDueToday).toBe(1);
    expect(result.sideEffects.otherSendableToday).toBe(0);
    const logs = await sql<{ c: number }[]>`SELECT count(*)::int AS c FROM "ReminderLog" WHERE "invoiceId" = ${otherInvoice}`;
    expect(logs[0].c).toBe(0);
    await cleanupByDomain(sql, domain);
  });

  // Live-write parity: the shared lookup drives the live reused/created value too.
  it("live write reports reused with an existing offset-0 rule and created without", async () => {
    // (a) existing enabled offset-0 email rule => reused, and no seed rule added.
    const reuseSuffix = freshSuffix();
    const reuse = await insertShop({
      suffix: reuseSuffix,
      timezone: etcZoneForLocalHour(await dbNow(), 12),
    });
    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${`existing-rule-${reuseSuffix}`}, ${reuse.shopId}, 0, 'email', true, NOW(), NOW())
    `;
    const reuseResult = await runG4Write(sql, {
      shopDomain: reuse.domain,
      recipient: "qa-fixture@example.com",
      dryRun: false,
    });
    expect(reuseResult.rule).toBe("reused");
    expect(reuseResult.fixture).toBe("written");
    const seedRule = await sql`SELECT 1 FROM "ReminderRule" WHERE id = ${g4FixtureIds(reuse.shopId).rule}`;
    expect(seedRule.length).toBe(0);
    await cleanupByDomain(sql, reuse.domain);

    // (b) no offset-0 email rule => created (seed-g4-rule0-<shop>).
    const createSuffix = freshSuffix();
    const create = await insertShop({
      suffix: createSuffix,
      timezone: etcZoneForLocalHour(await dbNow(), 12),
    });
    const createResult = await runG4Write(sql, {
      shopDomain: create.domain,
      recipient: "qa-fixture@example.com",
      dryRun: false,
    });
    expect(createResult.rule).toBe("created");
    expect(createResult.fixture).toBe("written");
    const created = await sql`SELECT 1 FROM "ReminderRule" WHERE id = ${g4FixtureIds(create.shopId).rule}`;
    expect(created.length).toBe(1);
    await cleanupByDomain(sql, create.domain);
  });

  // Guard: write window. Removing assertWithinWriteWindow lets this proceed and write.
  // A LIVE write outside the window still aborts with the existing code.
  it("aborts outside the write window and writes nothing", async () => {
    const suffix = freshSuffix();
    const { shopId, domain } = await insertShop({
      suffix,
      timezone: etcZoneForLocalHour(await dbNow(), 3), // 03:xx shop-local
    });

    await expect(
      runG4Write(sql, { shopDomain: domain, recipient: "qa-fixture@example.com", dryRun: false })
    ).rejects.toThrow("g4_outside_send_window");

    expect(await countFixtureRows(shopId)).toBe(0);
    await cleanupByDomain(sql, domain);
  });

  // Guard: INR store. Removing the currency check lets a USD store proceed.
  it("aborts when the resolved store is not INR and writes nothing", async () => {
    const suffix = freshSuffix();
    const { shopId, domain } = await insertShop({
      suffix,
      timezone: etcZoneForLocalHour(await dbNow(), 12),
      currency: "USD",
    });

    await expect(
      runG4Write(sql, { shopDomain: domain, recipient: "qa-fixture@example.com", dryRun: false })
    ).rejects.toThrow("g4_store_not_inr");

    expect(await countFixtureRows(shopId)).toBe(0);
    await cleanupByDomain(sql, domain);
  });

  // Guard: seed marker. A shop with no seed marker is not resolved.
  it("aborts when the store has no seed marker", async () => {
    const suffix = freshSuffix();
    const { domain } = await insertShop({
      suffix,
      timezone: etcZoneForLocalHour(await dbNow(), 12),
      seedMarked: false,
    });

    await expect(
      runG4Write(sql, { shopDomain: domain, recipient: "qa-fixture@example.com", dryRun: false })
    ).rejects.toThrow("g4_store_not_found");

    await cleanupByDomain(sql, domain);
  });

  // Guard: pre-flight. Another sendable buyer due today blocks the write.
  // The other buyer's address is at a NON-reserved (real-looking but synthetic)
  // domain, so isSendableRecipient classifies it as sendable and the run aborts.
  it("aborts when another sendable buyer is due today and writes nothing", async () => {
    const suffix = freshSuffix();
    const tz = etcZoneForLocalHour(await dbNow(), 12);
    const { shopId, domain } = await insertShop({ suffix, timezone: tz });

    const otherAccount = `other-acct-${suffix}`;
    const otherInvoice = `other-inv-${suffix}`;
    const otherOrder = `gid-free-order-${suffix}`;
    const otherRule = `other-rule-${suffix}`;
    // A myshopify.com-based address is synthetic yet NOT a reserved test domain,
    // so the pre-flight treats it as deliverable and aborts (fail-safe).
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "mainContactEmail", "holdState", "createdAt", "updatedAt")
      VALUES (${otherAccount}, ${shopId}, 'COMPANY', ${`company-${suffix}`}, ${`loc-${suffix}`}, 'Other Buyer', ${`buyer@${domain}`}, 'OK', NOW(), NOW())
    `;
    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${otherRule}, ${shopId}, 0, 'email', true, NOW(), NOW())
    `;
    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, "issuedAt", "dueAt", "dueSource", status, "createdAt", "updatedAt")
      VALUES (
        ${otherInvoice}, ${shopId}, ${otherAccount}, ${otherOrder}, 'OTHER-1', 500.00, 500.00,
        now() - interval '10 days',
        (((now() AT TIME ZONE ${tz})::date + time '12:00') AT TIME ZONE ${tz}),
        'none', 'open', NOW(), NOW()
      )
    `;

    await expect(
      runG4Write(sql, { shopDomain: domain, recipient: "qa-fixture@example.com", dryRun: false })
    ).rejects.toThrow("g4_other_buyers_due");

    expect(await countFixtureRows(shopId)).toBe(0);
    await cleanupByDomain(sql, domain);
  });

  // (a) The production shape: the only other due-today buyer is on a reserved
  // test domain (example.com), so it is NOT sendable. The write proceeds and the
  // side-effect counts report it as due-but-not-sendable (expected allowlist skip).
  it("does not abort when the only other due buyer is on a reserved test domain", async () => {
    const suffix = freshSuffix();
    const tz = etcZoneForLocalHour(await dbNow(), 12);
    const { shopId, domain } = await insertShop({ suffix, timezone: tz });

    const otherAccount = `other-acct-${suffix}`;
    const otherInvoice = `other-inv-${suffix}`;
    const otherOrder = `gid-free-order-${suffix}`;
    const otherRule = `other-rule-${suffix}`;
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "mainContactEmail", "holdState", "createdAt", "updatedAt")
      VALUES (${otherAccount}, ${shopId}, 'COMPANY', ${`company-${suffix}`}, ${`loc-${suffix}`}, 'Other Buyer', 'other@example.com', 'OK', NOW(), NOW())
    `;
    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${otherRule}, ${shopId}, 0, 'email', true, NOW(), NOW())
    `;
    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, "issuedAt", "dueAt", "dueSource", status, "createdAt", "updatedAt")
      VALUES (
        ${otherInvoice}, ${shopId}, ${otherAccount}, ${otherOrder}, 'OTHER-1', 500.00, 500.00,
        now() - interval '10 days',
        (((now() AT TIME ZONE ${tz})::date + time '12:00') AT TIME ZONE ${tz}),
        'none', 'open', NOW(), NOW()
      )
    `;

    const result = await runG4Write(sql, {
      shopDomain: domain,
      recipient: "qa-fixture@example.com",
      dryRun: false,
    });
    expect(result.fixture).toBe("written");
    // Due today, but not sendable (reserved domain) => no abort.
    expect(result.sideEffects.otherDueToday).toBe(1);
    expect(result.sideEffects.otherSendableToday).toBe(0);
    expect(result.sideEffects.wouldEnqueueNonFixture).toBe(1);
    expect(result.sideEffects.wouldEnqueueExpectedSkip).toBe(1);
    expect(result.sideEffects.wouldEnqueueExpectedSend).toBe(0);

    await cleanupByDomain(sql, domain);
  });

  // Cleanup restores each prior reminder state before deleting fixture rows.
  async function seedFixtureForCleanup(
    shopId: string,
    prior: "on" | "off" | "absent" | "missing"
  ): Promise<void> {
    const ids = g4FixtureIds(shopId);
    if (prior === "on") {
      await sql`INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at) VALUES (${shopId}, true, NOW(), NOW())`;
    } else if (prior === "off" || prior === "absent" || prior === "missing") {
      // Seed an enabled row so we can observe it being restored/cleared.
      await sql`INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at) VALUES (${shopId}, true, NOW(), NOW())`;
    }
    if (prior !== "missing") {
      await sql`
        INSERT INTO "AuditEvent" (id, "shopId", actor, type, data, at)
        VALUES (${ids.prior}, ${shopId}, 'seed', 'seed.g4_fixture.prior_settings',
          jsonb_build_object('prior', ${prior}::text), now())
      `;
    }
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "mainContactEmail", "holdState", "createdAt", "updatedAt")
      VALUES (${ids.account}, ${shopId}, 'COMPANY', ${ids.company}, ${ids.location}, 'NTR Seed G4 Fixture', 'qa-fixture@example.com', 'OK', NOW(), NOW())
    `;
    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${ids.rule}, ${shopId}, 0, 'email', true, NOW(), NOW())
    `;
    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, "issuedAt", "dueAt", "dueSource", "dueBasis", status, "createdAt", "updatedAt")
      VALUES (${ids.invoice}, ${shopId}, ${ids.account}, ${ids.order}, 'NTR-SEED-G4-1', 1000.00, 1000.00, now() - interval '30 days', now(), 'none', 'ntr-seed-g4', 'open', NOW(), NOW())
    `;
  }

  async function assertFixtureDeleted(shopId: string): Promise<void> {
    expect(await countFixtureRows(shopId)).toBe(0);
    const rule = await sql`SELECT 1 FROM "ReminderRule" WHERE id = ${g4FixtureIds(shopId).rule}`;
    expect(rule.length).toBe(0);
  }

  it("cleanup restores prior='on' then deletes fixture rows", async () => {
    const suffix = freshSuffix();
    const { shopId, domain } = await insertShop({
      suffix,
      timezone: "Etc/GMT",
    });
    await seedFixtureForCleanup(shopId, "on");

    const result = await runG4Cleanup(sql, {
      shopDomain: domain,
      dryRun: false,
      now: SAFE_CLEANUP_NOW,
    });
    expect(result.prior).toBe("on");
    expect(result.fixture).toBe("deleted");

    const [settings] = await sql<{ enabled: boolean }[]>`
      SELECT enabled FROM s18_shop_reminder_settings WHERE shop_id = ${shopId}
    `;
    expect(settings.enabled).toBe(true);
    await assertFixtureDeleted(shopId);
    await cleanupByDomain(sql, domain);
  });

  it("cleanup restores prior='off'", async () => {
    const suffix = freshSuffix();
    const { shopId, domain } = await insertShop({
      suffix,
      timezone: "Etc/GMT",
    });
    await seedFixtureForCleanup(shopId, "off");

    const result = await runG4Cleanup(sql, {
      shopDomain: domain,
      dryRun: false,
      now: SAFE_CLEANUP_NOW,
    });
    expect(result.prior).toBe("off");

    const [settings] = await sql<{ enabled: boolean }[]>`
      SELECT enabled FROM s18_shop_reminder_settings WHERE shop_id = ${shopId}
    `;
    expect(settings.enabled).toBe(false);
    await assertFixtureDeleted(shopId);
    await cleanupByDomain(sql, domain);
  });

  it("cleanup restores prior='absent' by removing the settings row", async () => {
    const suffix = freshSuffix();
    const { shopId, domain } = await insertShop({
      suffix,
      timezone: "Etc/GMT",
    });
    await seedFixtureForCleanup(shopId, "absent");

    const result = await runG4Cleanup(sql, {
      shopDomain: domain,
      dryRun: false,
      now: SAFE_CLEANUP_NOW,
    });
    expect(result.prior).toBe("absent");

    const settings = await sql`SELECT 1 FROM s18_shop_reminder_settings WHERE shop_id = ${shopId}`;
    expect(settings.length).toBe(0);
    await assertFixtureDeleted(shopId);
    await cleanupByDomain(sql, domain);
  });

  it("cleanup with a missing prior record fails safe (reminders off)", async () => {
    const suffix = freshSuffix();
    const { shopId, domain } = await insertShop({
      suffix,
      timezone: "Etc/GMT",
    });
    await seedFixtureForCleanup(shopId, "missing");

    const result = await runG4Cleanup(sql, {
      shopDomain: domain,
      dryRun: false,
      now: SAFE_CLEANUP_NOW,
    });
    expect(result.prior).toBe("unknown");

    const [settings] = await sql<{ enabled: boolean }[]>`
      SELECT enabled FROM s18_shop_reminder_settings WHERE shop_id = ${shopId}
    `;
    expect(settings.enabled).toBe(false);
    await assertFixtureDeleted(shopId);
    await cleanupByDomain(sql, domain);
  });

  // (b) Cleanup touches only fixture-owned rows; non-fixture ReminderLog and
  // queue rows on the same shop are left in place.
  it("cleanup leaves non-fixture ReminderLog and queue rows in place", async () => {
    const suffix = freshSuffix();
    const { shopId, domain } = await insertShop({
      suffix,
      timezone: "Etc/GMT",
    });
    await seedFixtureForCleanup(shopId, "off");

    // A non-fixture reminder log and a non-fixture queue row on the same shop.
    const otherAccount = `other-acct-${suffix}`;
    const otherInvoice = `other-inv-${suffix}`;
    const otherOrder = `gid-free-order-${suffix}`;
    const otherRule = `other-rule-${suffix}`;
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "mainContactEmail", "holdState", "createdAt", "updatedAt")
      VALUES (${otherAccount}, ${shopId}, 'COMPANY', ${`company-${suffix}`}, ${`loc-${suffix}`}, 'Other Buyer', 'other@example.com', 'OK', NOW(), NOW())
    `;
    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${otherRule}, ${shopId}, 0, 'email', true, NOW(), NOW())
    `;
    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, "issuedAt", "dueAt", "dueSource", status, "createdAt", "updatedAt")
      VALUES (${otherInvoice}, ${shopId}, ${otherAccount}, ${otherOrder}, 'OTHER-1', 500.00, 500.00, now() - interval '10 days', now(), 'none', 'open', NOW(), NOW())
    `;
    await sql`
      INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "sentAt")
      VALUES (${`other-log-${suffix}`}, ${shopId}, ${otherRule}, ${otherInvoice}, 'sent', now())
    `;
    await sql`
      SELECT pgmq.send('s6_sync', ${sql.json({
        topic: "REMINDER_SEND",
        shop: domain,
        shopId,
        invoiceId: otherInvoice,
        ruleId: otherRule,
      })}::jsonb)
    `;

    const result = await runG4Cleanup(sql, {
      shopDomain: domain,
      dryRun: false,
      now: SAFE_CLEANUP_NOW,
    });

    const logs = await sql`SELECT 1 FROM "ReminderLog" WHERE "invoiceId" = ${otherInvoice}`;
    expect(logs.length).toBe(1);
    const [queued] = await sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM pgmq.q_s6_sync WHERE message->>'invoiceId' = ${otherInvoice}
    `;
    expect(queued.c).toBe(1);
    // The fixture's own rows are gone.
    await assertFixtureDeleted(shopId);

    // (b) The reported side-effect counts match the rows left in place.
    expect(result.nonfixtureReminderLogByStatus).toEqual({ sent: 1 });
    expect(result.nonfixtureQueued).toBe(1);
    // The output carries the counts as fixed-key, PII-free lines (no addresses).
    const output = formatG4CleanupOutput(result).join("\n");
    expect(output).toContain("g4_cleanup_sideeffects nonfixture_reminderlog sent=1");
    expect(output).toContain("g4_cleanup_sideeffects nonfixture_queued=1");
    expect(output).not.toContain("@");

    await cleanupByDomain(sql, domain);
  });

  // (c) An allowlist skip of a non-fixture due row on the same shop does not
  // block the fixture's own send. Exercises the real send path (no runtime
  // changes); the sender is mocked at the network layer.
  it("allowlist skip of a non-fixture row does not block the fixture send", async () => {
    const suffix = freshSuffix();
    const tz = etcZoneForLocalHour(await dbNow(), 12);
    const { shopId, domain } = await insertShop({ suffix, timezone: tz });
    const ids = g4FixtureIds(shopId);

    // Fixture rows via the write path (recipient is a reserved test domain).
    await runG4Write(sql, {
      shopDomain: domain,
      recipient: "qa-fixture@example.com",
      dryRun: false,
    });

    // A non-fixture due-today invoice with a different recipient.
    const otherAccount = `other-acct-${suffix}`;
    const otherInvoice = `other-inv-${suffix}`;
    const otherOrder = `gid-free-order-${suffix}`;
    const otherRule = `other-rule-${suffix}`;
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "mainContactEmail", "holdState", "createdAt", "updatedAt")
      VALUES (${otherAccount}, ${shopId}, 'COMPANY', ${`company-${suffix}`}, ${`loc-${suffix}`}, 'Other Buyer', 'other@example.com', 'OK', NOW(), NOW())
    `;
    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${otherRule}, ${shopId}, 0, 'email', true, NOW(), NOW())
    `;
    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, "issuedAt", "dueAt", "dueSource", status, "createdAt", "updatedAt")
      VALUES (
        ${otherInvoice}, ${shopId}, ${otherAccount}, ${otherOrder}, 'OTHER-1', 500.00, 500.00,
        now() - interval '10 days',
        (((now() AT TIME ZONE ${tz})::date + time '12:00') AT TIME ZONE ${tz}),
        'none', 'open', NOW(), NOW()
      )
    `;

    const mockFetch = vi.fn(async (_url: string, _init: { body: string }) => ({
      ok: true,
      status: 200,
      json: async () => ({ id: "resend-test-id" }),
    }));
    vi.stubGlobal("fetch", mockFetch);

    // Allowlist contains ONLY the fixture recipient: the other row is skipped.
    const env = {
      RESEND_API_KEY: "re_test_key",
      RESEND_FROM: "reminders@example.com",
      REMINDER_UNSUBSCRIBE_SECRET: "test-secret",
      SHOPIFY_APP_URL: "https://app.example.com",
      RESEND_TEST_RECIPIENTS: "qa-fixture@example.com",
    };
    const deps = {
      reserveGlobalSendSlot: async () => ({ reserved: true as const, daily: 1, monthly: 1 }),
    };

    try {
      const { sendPaymentReminder } = await import("~/services/reminders.server");

      const otherResult = await sendPaymentReminder(
        sql,
        shopId,
        otherInvoice,
        otherRule,
        0,
        tz,
        env,
        deps
      );
      const fixtureResult = await sendPaymentReminder(
        sql,
        shopId,
        ids.invoice,
        ids.rule,
        0,
        tz,
        env,
        deps
      );

      expect(otherResult.action).toBe("skipped");
      expect(fixtureResult.action).toBe("sent");

      // Exactly one Resend call, for the fixture recipient only.
      const resendCalls = mockFetch.mock.calls.filter((c) => c[0] === RESEND_URL);
      expect(resendCalls.length).toBe(1);
      const body = JSON.parse((resendCalls[0][1] as { body: string }).body) as { to: string[] };
      expect(body.to).toEqual(["qa-fixture@example.com"]);
    } finally {
      vi.unstubAllGlobals();
    }

    await cleanupByDomain(sql, domain);
  });
});

/** Delete all rows this suite could have created for a shop domain. */
async function cleanupByDomain(sql: Sql, domain: string): Promise<void> {
  const shopRows = await sql<{ id: string }[]>`SELECT id FROM "Shop" WHERE domain = ${domain}`;
  for (const { id: shopId } of shopRows) {
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shopId' = ${shopId}`;
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${shopId}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${shopId}`;
    await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${shopId}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${shopId}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${shopId}`;
    await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${shopId}`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${shopId}`;
    await sql`DELETE FROM "AccountSource" WHERE "shopId" = ${shopId}`;
  }
  await sql`DELETE FROM "Shop" WHERE domain = ${domain}`;
}
