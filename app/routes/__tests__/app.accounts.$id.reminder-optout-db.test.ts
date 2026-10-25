/**
 * DB-backed integration tests for merchant reminder opt-out toggle (S18 #232).
 *
 * Tests:
 * - Re-enable action writes AuditEvent with IDs and enums only
 * - Disable action sets opt-out with source='merchant'
 * - Shop isolation (cannot toggle other shop's accounts)
 *
 * Uses the CI pgmq Postgres service.
 * Uses real safeLog (no vi.mock of log.server.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

vi.mock("~/services/gating.server", () => ({
  isAccountActive: vi.fn().mockReturnValue(true),
  isGatingEnforced: vi.fn().mockReturnValue(false),
}));

vi.mock("~/lib/aging-queries.server", () => ({
  getBuyerInvoices: vi.fn().mockResolvedValue({ rows: [], totalCount: 0 }),
}));

vi.mock("~/services/credit-status.server", () => ({
  getCreditStatusDisplay: vi.fn().mockResolvedValue({
    creditLimitAmount: 100000,
    creditLimitPaise: 10000000n,
    exposurePaise: 0n,
    draftExposurePaise: 0n,
    availableCreditPaise: 10000000n,
    currency: "INR",
    holdState: "OK",
    manualHold: false,
    holdReasonCode: null,
    holdNote: null,
    isOnHold: false,
    holdReasonDisplay: null,
    isOverLimit: false,
    isOverdue: false,
    utilizationPercent: 0,
    syncPending: false,
    syncErrorCode: null,
    metafieldSyncedAt: new Date(),
  }),
  getCompanyTotals: vi.fn().mockResolvedValue(null),
  updateCreditStatus: vi.fn().mockResolvedValue({ success: true }),
}));

describeWithDb("app.accounts.$id reminder opt-out toggle (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-optout-toggle";
  const TEST_SHOP_ID = `shop-toggle-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-toggle-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-toggle-${TEST_SUFFIX}`;
  const TEST_CUSTOMER_ID = `gid://shopify/Customer/toggle-${TEST_SUFFIX}`;
  const OTHER_SHOP_ID = `shop-other-${TEST_SUFFIX}`;
  const OTHER_SHOP_DOMAIN = `test-other-${TEST_SUFFIX}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', 'free', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
      VALUES (${OTHER_SHOP_ID}, ${OTHER_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', 'free', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "customerId", name,
        "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER',
        ${TEST_CUSTOMER_ID}, 'Toggle Test Account', 100000.00, 'OK', false, false, 30, 'explicit',
        false, 1, NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" IN (${TEST_SHOP_ID}, ${OTHER_SHOP_ID})`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN (${TEST_SHOP_ID}, ${OTHER_SHOP_ID})`;
    await sql`DELETE FROM "Shop" WHERE id IN (${TEST_SHOP_ID}, ${OTHER_SHOP_ID})`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`
      UPDATE "BuyerAccount"
      SET "reminderOptOutAt" = NULL, "reminderOptOutSource" = NULL, "updatedAt" = NOW()
      WHERE id = ${TEST_ACCOUNT_ID} AND "shopId" = ${TEST_SHOP_ID}
    `;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
  });

  function createActionArgs(
    shopDomain: string,
    accountId: string,
    enable: boolean
  ) {
    const url = new URL(`https://example.com/app/accounts/${accountId}`);
    const formData = new FormData();
    formData.set("_action", "updateReminderOptOut");
    formData.set("enable", enable ? "true" : "false");

    return {
      request: new Request(url, {
        method: "POST",
        body: formData,
      }),
      context: {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: shopDomain },
            }),
          },
        },
        cloudflare: {
          env: {},
          ctx: { waitUntil: vi.fn() },
        },
      },
      params: { id: accountId },
      url,
      pattern: "/app/accounts/:id",
    } as unknown;
  }

  it("disable action sets opt-out with source='merchant'", async () => {
    vi.resetModules();
    vi.doMock("~/lib/request-context.server", () => ({
      getRequestSql: () => sql,
    }));

    const { action } = await import("../app.accounts.$id");
    const result = await action(
      createActionArgs(TEST_SHOP_DOMAIN, TEST_ACCOUNT_ID, false) as never
    ) as { success: boolean; action?: string };

    expect(result.success).toBe(true);
    expect(result.action).toBe("updateReminderOptOut");

    const [account] = await sql<{ optOutAt: Date | null; optOutSource: string | null }[]>`
      SELECT "reminderOptOutAt" AS "optOutAt", "reminderOptOutSource" AS "optOutSource"
      FROM "BuyerAccount"
      WHERE id = ${TEST_ACCOUNT_ID} AND "shopId" = ${TEST_SHOP_ID}
    `;

    expect(account.optOutAt).toBeInstanceOf(Date);
    expect(account.optOutSource).toBe("merchant");
  });

  it("re-enable action clears opt-out and writes AuditEvent", async () => {
    await sql`
      UPDATE "BuyerAccount"
      SET "reminderOptOutAt" = NOW(), "reminderOptOutSource" = 'link'::"ReminderOptOutSource"
      WHERE id = ${TEST_ACCOUNT_ID} AND "shopId" = ${TEST_SHOP_ID}
    `;

    vi.resetModules();
    vi.doMock("~/lib/request-context.server", () => ({
      getRequestSql: () => sql,
    }));

    const { action } = await import("../app.accounts.$id");
    const result = await action(
      createActionArgs(TEST_SHOP_DOMAIN, TEST_ACCOUNT_ID, true) as never
    ) as { success: boolean };

    expect(result.success).toBe(true);

    const [account] = await sql<{ optOutAt: Date | null; optOutSource: string | null }[]>`
      SELECT "reminderOptOutAt" AS "optOutAt", "reminderOptOutSource" AS "optOutSource"
      FROM "BuyerAccount"
      WHERE id = ${TEST_ACCOUNT_ID} AND "shopId" = ${TEST_SHOP_ID}
    `;

    expect(account.optOutAt).toBeNull();
    expect(account.optOutSource).toBeNull();

    const [auditEvent] = await sql<{
      type: string;
      actor: string;
      data: { buyerAccountId: string; source: string };
    }[]>`
      SELECT type, actor, data
      FROM "AuditEvent"
      WHERE "shopId" = ${TEST_SHOP_ID} AND type = 'reminder.opt_out_cleared'
      ORDER BY at DESC
      LIMIT 1
    `;

    expect(auditEvent).toBeDefined();
    expect(auditEvent.type).toBe("reminder.opt_out_cleared");
    expect(auditEvent.actor).toBe("system");
    expect(auditEvent.data.buyerAccountId).toBe(TEST_ACCOUNT_ID);
    expect(auditEvent.data.source).toBe("merchant");
  });

  it("AuditEvent data contains only IDs and enums (no PII)", async () => {
    await sql`
      UPDATE "BuyerAccount"
      SET "reminderOptOutAt" = NOW(), "reminderOptOutSource" = 'link'::"ReminderOptOutSource"
      WHERE id = ${TEST_ACCOUNT_ID} AND "shopId" = ${TEST_SHOP_ID}
    `;

    vi.resetModules();
    vi.doMock("~/lib/request-context.server", () => ({
      getRequestSql: () => sql,
    }));

    const { action } = await import("../app.accounts.$id");
    await action(
      createActionArgs(TEST_SHOP_DOMAIN, TEST_ACCOUNT_ID, true) as never
    );

    const [auditEvent] = await sql<{ data: Record<string, unknown> }[]>`
      SELECT data
      FROM "AuditEvent"
      WHERE "shopId" = ${TEST_SHOP_ID} AND type = 'reminder.opt_out_cleared'
      ORDER BY at DESC
      LIMIT 1
    `;

    const dataKeys = Object.keys(auditEvent.data);
    expect(dataKeys).toContain("buyerAccountId");
    expect(dataKeys).toContain("source");
    expect(dataKeys).not.toContain("email");
    expect(dataKeys).not.toContain("name");
    expect(dataKeys).not.toContain("domain");
    expect(dataKeys).not.toContain("token");
  });

  it("re-enable when already opted-in does NOT write AuditEvent", async () => {
    vi.resetModules();
    vi.doMock("~/lib/request-context.server", () => ({
      getRequestSql: () => sql,
    }));

    const { action } = await import("../app.accounts.$id");
    await action(
      createActionArgs(TEST_SHOP_DOMAIN, TEST_ACCOUNT_ID, true) as never
    );

    const events = await sql<{ id: string }[]>`
      SELECT id
      FROM "AuditEvent"
      WHERE "shopId" = ${TEST_SHOP_ID} AND type = 'reminder.opt_out_cleared'
    `;

    expect(events.length).toBe(0);
  });

  it("action fails for non-existent account", async () => {
    vi.resetModules();
    vi.doMock("~/lib/request-context.server", () => ({
      getRequestSql: () => sql,
    }));

    const { action } = await import("../app.accounts.$id");
    const result = await action(
      createActionArgs(TEST_SHOP_DOMAIN, "nonexistent-account", true) as never
    ) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe("Account not found");
  });

  it("action fails for wrong shop (shop isolation)", async () => {
    vi.resetModules();
    vi.doMock("~/lib/request-context.server", () => ({
      getRequestSql: () => sql,
    }));

    const { action } = await import("../app.accounts.$id");
    const result = await action(
      createActionArgs(OTHER_SHOP_DOMAIN, TEST_ACCOUNT_ID, false) as never
    ) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe("Account not found");

    const [account] = await sql<{ optOutAt: Date | null }[]>`
      SELECT "reminderOptOutAt" AS "optOutAt"
      FROM "BuyerAccount"
      WHERE id = ${TEST_ACCOUNT_ID} AND "shopId" = ${TEST_SHOP_ID}
    `;

    expect(account.optOutAt).toBeNull();
  });
});
