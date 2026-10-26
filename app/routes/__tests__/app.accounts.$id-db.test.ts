/**
 * DB-backed integration tests for account detail page dead-letter logic.
 * Uses the CI pgmq Postgres service.
 *
 * Tests the dead-letter time filter: rows older than metafieldSyncedAt must NOT
 * trigger needs_attention, while newer rows must.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

vi.mock("~/services/gating.server", () => ({
  isAccountActive: vi.fn().mockReturnValue(true),
  isGatingEnforced: vi.fn().mockReturnValue(false),
  getUsageStats: vi.fn().mockResolvedValue({
    companies: { current: 0, limit: 25 },
    importsThisMonth: { current: 0, limit: -1 },
  }),
}));

vi.mock("~/lib/aging-queries.server", () => ({
  getBuyerInvoices: vi.fn().mockResolvedValue({ rows: [], totalCount: 0 }),
}));

vi.mock("~/services/credit-status.server", () => ({
  getCreditStatusDisplay: vi.fn(),
  getCompanyTotals: vi.fn().mockResolvedValue(null),
  updateCreditStatus: vi.fn(),
}));

import { getCreditStatusDisplay } from "~/services/credit-status.server";

const mockGetCreditStatusDisplay = vi.mocked(getCreditStatusDisplay);

describeWithDb("app.accounts.$id dead-letter time filter (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-dlq-db";
  const TEST_SHOP_ID = `shop-dlq-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-dlq-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-dlq-${TEST_SUFFIX}`;
  const OTHER_SHOP_DOMAIN = `test-other-shop-${TEST_SUFFIX}.myshopify.com`;

  const SYNC_TIME = new Date("2026-10-24T12:00:00Z");
  const OLD_DLQ_TIME = new Date("2026-10-24T10:00:00Z");
  const NEW_DLQ_TIME = new Date("2026-10-24T14:00:00Z");

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "syncPending", "metafieldSyncedAt",
        "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-" + TEST_SUFFIX}, ${"loc-" + TEST_SUFFIX},
        'Test DLQ Account', 100000.00, 'OK', false, true, ${SYNC_TIME},
        NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    await sql`
      DELETE FROM s6_dead_letter 
      WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
    `;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  function createLoaderArgs() {
    const url = new URL("https://example.com/app/accounts/" + TEST_ACCOUNT_ID);
    return {
      request: new Request(url),
      context: {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: TEST_SHOP_DOMAIN },
            }),
          },
        },
        cloudflare: {
          env: {},
          ctx: { waitUntil: vi.fn() },
        },
      },
      params: { id: TEST_ACCOUNT_ID },
      url,
      pattern: "/app/accounts/:id",
    } as unknown;
  }

  it("old dead-letter row (before metafieldSyncedAt) does NOT cause needs_attention", async () => {
    mockGetCreditStatusDisplay.mockResolvedValue({
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
      syncPending: true,
      syncErrorCode: null,
      metafieldSyncedAt: SYNC_TIME,
    });

    await sql`
      INSERT INTO s6_dead_letter (original_queue, original_msg_id, message, error, dead_lettered_at)
      VALUES (
        's6_sync',
        ${"old-msg-" + TEST_SUFFIX},
        ${sql.json({
          topic: "CREDIT_STATUS_RECOMPUTE",
          buyerAccountId: TEST_ACCOUNT_ID,
          shop: TEST_SHOP_DOMAIN,
        })},
        'test error',
        ${OLD_DLQ_TIME}
      )
    `;

    try {
      vi.resetModules();
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs() as never);

      expect(result.creditStatus?.syncState).toBe("pending_retry");
      expect(result.creditStatus?.hasDeadLetteredSync).toBe(false);
    } finally {
      await sql`
        DELETE FROM s6_dead_letter 
        WHERE original_msg_id = ${"old-msg-" + TEST_SUFFIX}
      `;
    }
  });

  it("new dead-letter row (after metafieldSyncedAt) DOES cause needs_attention", async () => {
    mockGetCreditStatusDisplay.mockResolvedValue({
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
      syncPending: true,
      syncErrorCode: null,
      metafieldSyncedAt: SYNC_TIME,
    });

    await sql`
      INSERT INTO s6_dead_letter (original_queue, original_msg_id, message, error, dead_lettered_at)
      VALUES (
        's6_sync',
        ${"new-msg-" + TEST_SUFFIX},
        ${sql.json({
          topic: "CREDIT_STATUS_RECOMPUTE",
          buyerAccountId: TEST_ACCOUNT_ID,
          shop: TEST_SHOP_DOMAIN,
        })},
        'test error',
        ${NEW_DLQ_TIME}
      )
    `;

    try {
      vi.resetModules();
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs() as never);

      expect(result.creditStatus?.syncState).toBe("needs_attention");
      expect(result.creditStatus?.hasDeadLetteredSync).toBe(true);
    } finally {
      await sql`
        DELETE FROM s6_dead_letter 
        WHERE original_msg_id = ${"new-msg-" + TEST_SUFFIX}
      `;
    }
  });

  it("dead-letter row from wrong queue does NOT cause needs_attention", async () => {
    mockGetCreditStatusDisplay.mockResolvedValue({
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
      syncPending: true,
      syncErrorCode: null,
      metafieldSyncedAt: SYNC_TIME,
    });

    await sql`
      INSERT INTO s6_dead_letter (original_queue, original_msg_id, message, error, dead_lettered_at)
      VALUES (
        'wrong_queue',
        ${"wrong-queue-msg-" + TEST_SUFFIX},
        ${sql.json({
          topic: "CREDIT_STATUS_RECOMPUTE",
          buyerAccountId: TEST_ACCOUNT_ID,
          shop: TEST_SHOP_DOMAIN,
        })},
        'test error',
        ${NEW_DLQ_TIME}
      )
    `;

    try {
      vi.resetModules();
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs() as never);

      expect(result.creditStatus?.syncState).toBe("pending_retry");
      expect(result.creditStatus?.hasDeadLetteredSync).toBe(false);
    } finally {
      await sql`
        DELETE FROM s6_dead_letter 
        WHERE original_msg_id = ${"wrong-queue-msg-" + TEST_SUFFIX}
      `;
    }
  });

  it("dead-letter row from wrong shop does NOT cause needs_attention", async () => {
    mockGetCreditStatusDisplay.mockResolvedValue({
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
      syncPending: true,
      syncErrorCode: null,
      metafieldSyncedAt: SYNC_TIME,
    });

    await sql`
      INSERT INTO s6_dead_letter (original_queue, original_msg_id, message, error, dead_lettered_at)
      VALUES (
        's6_sync',
        ${"wrong-shop-msg-" + TEST_SUFFIX},
        ${sql.json({
          topic: "CREDIT_STATUS_RECOMPUTE",
          buyerAccountId: TEST_ACCOUNT_ID,
          shop: OTHER_SHOP_DOMAIN,
        })},
        'test error',
        ${NEW_DLQ_TIME}
      )
    `;

    try {
      vi.resetModules();
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs() as never);

      expect(result.creditStatus?.syncState).toBe("pending_retry");
      expect(result.creditStatus?.hasDeadLetteredSync).toBe(false);
    } finally {
      await sql`
        DELETE FROM s6_dead_letter 
        WHERE original_msg_id = ${"wrong-shop-msg-" + TEST_SUFFIX}
      `;
    }
  });
});
