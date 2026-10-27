/**
 * DB integration tests for AuditEvent PII-free contract.
 *
 * Proves that AuditEvent.data NEVER contains buyer name or email by:
 * 1. Seeding a synthetic buyer with known name/email
 * 2. Driving real service functions that write AuditEvents
 * 3. Asserting no AuditEvent.data::text contains the name or email (case-insensitive)
 * 4. Asserting count > 0 per path to prevent vacuous pass
 *
 * AuditEvent writers (file:line → event type → data fields):
 * - access-log.server.ts:155 → access.* → recordType, recordId?, count?
 * - apply.server.ts:430,660,673,700,808,934,965,987,1017,1030,1200,1220,1346,1359,1409,1421,1550,1617,1646,1809,1841,1869,1892
 *   → match.unmatched, match.applied, invoice.paid, match.push_claimed
 *   → matchId, invoiceId, paymentId, amountPaise, previousOutstandingPaise, newOutstandingPaise, etc.
 * - backstop.server.ts:346 → backstop.hold_applied → orderGid, buyerAccountId, fulfillmentOrdersHeld, etc.
 * - backstop.server.ts:381 → backstop.failed → orderGid, buyerAccountId, errorCode, reason
 * - backstop.server.ts:409 → backstop.non_merchant_managed_skipped → orderGid, skippedFulfillmentOrderIds, reason
 * - credit-status.server.ts:481 → credit_status.hold_applied/hold_released → buyerAccountId, holdReasonCode, source, etc.
 * - credit-status.server.ts:949,1014,1314,1383 → credit_status.sync_failed → buyerAccountId, errorCode, syncVersion
 * - credit-status.server.ts:1184 → credit_status.hold_unenforceable → buyerAccountId, ownerType, holdState, syncVersion
 * - matcher.server.ts:537 → match.confirmed → matchId, invoiceId, paymentId, amountPaise
 *
 * Uses CI pgmq Postgres. Mocks only Shopify Admin GraphQL.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const BUYER_NAME = "Test Buyer Audit";
const BUYER_EMAIL = "test-audit@example.com";

const mockShopifyGraphQLRequest = vi.fn().mockImplementation(async (_shop: string, query: string) => {
  if (query.includes("metafieldsSet")) {
    return {
      success: true,
      data: {
        metafieldsSet: {
          metafields: [{ id: "gid://shopify/Metafield/test-audit", namespace: "$app", key: "credit_status" }],
          userErrors: [],
        },
      },
    };
  }
  if (query.includes("orderMarkAsPaid")) {
    return {
      success: true,
      data: {
        orderMarkAsPaid: {
          order: { id: "gid://shopify/Order/test-audit", displayFinancialStatus: "PAID" },
          userErrors: [],
        },
      },
    };
  }
  if (query.includes("fulfillmentOrderHold")) {
    return {
      success: true,
      data: {
        fulfillmentOrderHold: {
          fulfillmentOrder: { id: "gid://shopify/FulfillmentOrder/test-audit" },
          userErrors: [],
        },
      },
    };
  }
  if (query.includes("order(id:")) {
    return {
      success: true,
      data: {
        order: {
          id: "gid://shopify/Order/test-audit",
          displayFinancialStatus: "PENDING",
          fulfillmentOrders: {
            nodes: [{
              id: "gid://shopify/FulfillmentOrder/test-audit",
              status: "OPEN",
              assignedLocation: { id: "gid://shopify/Location/test-audit" },
            }],
          },
        },
      },
    };
  }
  return { success: true, data: {} };
});

vi.mock("../shopify-client.server", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    shopifyGraphQLRequest: (...args: unknown[]) => mockShopifyGraphQLRequest(...args),
  };
});

import { applyMatch, unmatchMatch } from "../apply.server";
import { confirmMatch } from "../matcher.server";
import { recomputeCreditStatus } from "../credit-status-recompute.server";
import { recordBackstopFailure } from "../backstop.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("AuditEvent contains no buyer name or email", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-audit-pii";

  const TEST_SHOP_ID = `shop-audit-pii-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `audit-pii-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-audit-pii-${TEST_SUFFIX}`;
  const TEST_COMPANY_LOCATION_ID = `gid://shopify/CompanyLocation/audit-pii-${TEST_SUFFIX}`;
  const TEST_IMPORT_ID = `import-audit-pii-${TEST_SUFFIX}`;
  const TEST_ORDER_GID = `gid://shopify/Order/audit-pii-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId",
        name, "mainContactName", "mainContactEmail",
        "creditLimit", "holdState", "manualHold", "holdReasonCode",
        "defaultTermsDays", "defaultTermsSource",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-" + TEST_SUFFIX}, ${TEST_COMPANY_LOCATION_ID},
        ${BUYER_NAME}, ${BUYER_NAME}, ${BUYER_EMAIL},
        100000.00, 'OK', false, NULL,
        30, 'explicit',
        false, 1, NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
      VALUES (${TEST_IMPORT_ID}, ${TEST_SHOP_ID}, 'hdfc', 'audit-pii-test.xlsx', 1, NOW())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Match" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    mockShopifyGraphQLRequest.mockClear();

    await sql`
      UPDATE "BuyerAccount"
      SET "holdState" = 'OK', "holdReasonCode" = NULL, "manualHold" = false,
          "creditLimit" = 100000.00,
          "syncPending" = false, "syncVersion" = 1, gated_at = NULL, "metafieldSyncedAt" = NULL
      WHERE id = ${TEST_ACCOUNT_ID}
    `;

    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Match" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
  });

  async function assertNoPiiInAuditEvents(minExpected: number): Promise<void> {
    const events = await sql<{ id: string; type: string; data: Record<string, unknown> }[]>`
      SELECT id, type, data FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}
    `;

    expect(events.length).toBeGreaterThanOrEqual(minExpected);

    for (const event of events) {
      const dataText = JSON.stringify(event.data).toLowerCase();
      expect(dataText).not.toContain(BUYER_NAME.toLowerCase());
      expect(dataText).not.toContain(BUYER_EMAIL.toLowerCase());
    }
  }

  describe("access-log.server.ts (recordAccess)", () => {
    it("access.* events contain no buyer name or email", async () => {
      const capturedPromises: Promise<unknown>[] = [];
      const mockWaitUntil = (p: Promise<unknown>) => { capturedPromises.push(p); };

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestWaitUntil: () => mockWaitUntil,
      }));

      const { recordAccess: realRecordAccess } = await import("../access-log.server");

      realRecordAccess(sql, {
        shopId: TEST_SHOP_ID,
        actor: "12345",
        action: "accounts_detail",
        recordType: "BuyerAccount",
        recordId: TEST_ACCOUNT_ID,
      });

      realRecordAccess(sql, {
        shopId: TEST_SHOP_ID,
        actor: "67890",
        action: "data_requests_list",
        recordType: "DataRequest",
        count: 5,
      });

      await Promise.all(capturedPromises);
      await assertNoPiiInAuditEvents(2);
    });
  });

  describe("credit-status.server.ts (hold transitions and sync_failed)", () => {
    it("credit_status.hold_applied event contains no buyer name or email", async () => {
      const invoiceId = `inv-hold-audit-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${TEST_ORDER_GID},
          '#AUDIT-HOLD-1', 50000.00, 50000.00, 'open',
          NOW() - INTERVAL '40 days',
          NOW() - INTERVAL '10 days',
          NOW(), NOW()
        )
      `;

      const result = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);
      expect(result.success).toBe(true);
      expect(result.newHold).toBe(true);

      const holdEvents = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID} AND type = 'credit_status.hold_applied'
      `;
      expect(parseInt(holdEvents[0].count, 10)).toBeGreaterThanOrEqual(1);

      await assertNoPiiInAuditEvents(1);
    });

    it("credit_status.hold_released event contains no buyer name or email", async () => {
      await sql`
        UPDATE "BuyerAccount"
        SET "holdState" = 'HELD', "holdReasonCode" = 'PAYMENT_OVERDUE'
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      const result = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);
      expect(result.success).toBe(true);
      expect(result.newHold).toBe(false);

      const releaseEvents = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID} AND type = 'credit_status.hold_released'
      `;
      expect(parseInt(releaseEvents[0].count, 10)).toBeGreaterThanOrEqual(1);

      await assertNoPiiInAuditEvents(1);
    });
  });

  describe("matcher.server.ts (confirmMatch)", () => {
    it("match.confirmed event contains no buyer name or email", async () => {
      const invoiceId = `inv-confirm-audit-${TEST_SUFFIX}`;
      const paymentId = `pmt-confirm-audit-${TEST_SUFFIX}`;
      const matchId = `match-confirm-audit-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${TEST_ORDER_GID},
          '#AUDIT-CONF-1', 10000.00, 10000.00, 'open',
          NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "Payment" (
          id, "shopId", "importId", "valueDate", amount, rail, utr,
          "payerText", narration, status, "createdAt", "updatedAt"
        )
        VALUES (
          ${paymentId}, ${TEST_SHOP_ID}, ${TEST_IMPORT_ID},
          NOW(), 10000.00, 'NEFT', ${'UTR-' + TEST_SUFFIX},
          'SYNTHETIC PAYER', 'NEFT CR-SYNTHETIC PAYER-INV1', 'unmatched', NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "Match" (
          id, "shopId", "paymentId", "invoiceId",
          amount, score, reasons, state, "createdAt", "updatedAt"
        )
        VALUES (
          ${matchId}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId},
          10000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'suggested', NOW(), NOW()
        )
      `;

      const result = await confirmMatch(sql, TEST_SHOP_ID, matchId, "system");
      expect(result.success).toBe(true);

      const confirmEvents = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID} AND type = 'match.confirmed'
      `;
      expect(parseInt(confirmEvents[0].count, 10)).toBeGreaterThanOrEqual(1);

      await assertNoPiiInAuditEvents(1);
    });
  });

  describe("apply.server.ts (applyMatch, unmatchMatch)", () => {
    it("match.applied and invoice.paid events contain no buyer name or email", async () => {
      const invoiceId = `inv-apply-audit-${TEST_SUFFIX}`;
      const paymentId = `pmt-apply-audit-${TEST_SUFFIX}`;
      const matchId = `match-apply-audit-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${TEST_ORDER_GID},
          '#AUDIT-APPLY-1', 10000.00, 10000.00, 'open',
          NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "Payment" (
          id, "shopId", "importId", "valueDate", amount, rail, utr,
          "payerText", narration, status, "createdAt", "updatedAt"
        )
        VALUES (
          ${paymentId}, ${TEST_SHOP_ID}, ${TEST_IMPORT_ID},
          NOW(), 10000.00, 'NEFT', ${'UTR-APPLY-' + TEST_SUFFIX},
          'SYNTHETIC PAYER APPLY', 'NEFT CR-SYNTHETIC PAYER APPLY-INV1', 'unmatched', NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "Match" (
          id, "shopId", "paymentId", "invoiceId",
          amount, score, reasons, state, "confirmedBy", "confirmedAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${matchId}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId},
          10000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'confirmed', 'test-user', NOW(), NOW(), NOW()
        )
      `;

      const result = await applyMatch(sql, TEST_SHOP_ID, matchId, "system");
      expect(result.success).toBe(true);

      const appliedEvents = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID} AND type = 'match.applied'
      `;
      expect(parseInt(appliedEvents[0].count, 10)).toBeGreaterThanOrEqual(1);

      await assertNoPiiInAuditEvents(1);
    });

    it("match.unmatched event contains no buyer name or email", async () => {
      const invoiceId = `inv-unmatch-audit-${TEST_SUFFIX}`;
      const paymentId = `pmt-unmatch-audit-${TEST_SUFFIX}`;
      const matchId = `match-unmatch-audit-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${TEST_ORDER_GID},
          '#AUDIT-UNMATCH-1', 10000.00, 5000.00, 'open',
          NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "Payment" (
          id, "shopId", "importId", "valueDate", amount, rail, utr,
          "payerText", narration, status, "createdAt", "updatedAt"
        )
        VALUES (
          ${paymentId}, ${TEST_SHOP_ID}, ${TEST_IMPORT_ID},
          NOW(), 5000.00, 'NEFT', ${'UTR-UNMATCH-' + TEST_SUFFIX},
          'SYNTHETIC PAYER UNMATCH', 'NEFT CR-SYNTHETIC PAYER UNMATCH', 'matched', NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "Match" (
          id, "shopId", "paymentId", "invoiceId",
          amount, score, reasons, state, "confirmedBy", "confirmedAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${matchId}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId},
          5000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'confirmed', 'test-user', NOW(), NOW(), NOW()
        )
      `;

      const result = await unmatchMatch(sql, TEST_SHOP_ID, matchId, "system");
      expect(result.success).toBe(true);

      const unmatchedEvents = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID} AND type = 'match.unmatched'
      `;
      expect(parseInt(unmatchedEvents[0].count, 10)).toBeGreaterThanOrEqual(1);

      await assertNoPiiInAuditEvents(1);
    });
  });

  describe("backstop.server.ts (recordBackstopFailure)", () => {
    it("backstop.failed event contains no buyer name or email", async () => {
      await recordBackstopFailure(
        sql,
        TEST_SHOP_ID,
        TEST_ORDER_GID,
        TEST_ACCOUNT_ID,
        "test_error_code"
      );

      const backstopEvents = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID} AND type = 'backstop.failed'
      `;
      expect(parseInt(backstopEvents[0].count, 10)).toBeGreaterThanOrEqual(1);

      await assertNoPiiInAuditEvents(1);
    });
  });

  describe("consolidated assertion", () => {
    it("ALL AuditEvent paths together write rows with no buyer name or email", async () => {
      const invoiceId1 = `inv-all-audit-${TEST_SUFFIX}`;
      const paymentId1 = `pmt-all-audit-${TEST_SUFFIX}`;
      const matchId1 = `match-all-audit-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId1}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${TEST_ORDER_GID},
          '#AUDIT-ALL-1', 10000.00, 10000.00, 'open',
          NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "Payment" (
          id, "shopId", "importId", "valueDate", amount, rail, utr,
          "payerText", narration, status, "createdAt", "updatedAt"
        )
        VALUES (
          ${paymentId1}, ${TEST_SHOP_ID}, ${TEST_IMPORT_ID},
          NOW(), 10000.00, 'NEFT', ${'UTR-ALL-' + TEST_SUFFIX},
          'SYNTHETIC PAYER ALL', 'NEFT CR-SYNTHETIC PAYER ALL-INV1', 'unmatched', NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "Match" (
          id, "shopId", "paymentId", "invoiceId",
          amount, score, reasons, state, "createdAt", "updatedAt"
        )
        VALUES (
          ${matchId1}, ${TEST_SHOP_ID}, ${paymentId1}, ${invoiceId1},
          10000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'suggested', NOW(), NOW()
        )
      `;

      const confirmResult = await confirmMatch(sql, TEST_SHOP_ID, matchId1, "system");
      expect(confirmResult.success).toBe(true);

      const applyResult = await applyMatch(sql, TEST_SHOP_ID, matchId1, "system");
      expect(applyResult.success).toBe(true);

      await recordBackstopFailure(sql, TEST_SHOP_ID, TEST_ORDER_GID, TEST_ACCOUNT_ID, "test_error");

      const capturedPromises: Promise<unknown>[] = [];
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestWaitUntil: () => (p: Promise<unknown>) => capturedPromises.push(p),
      }));
      const { recordAccess: realRecordAccess } = await import("../access-log.server");
      realRecordAccess(sql, {
        shopId: TEST_SHOP_ID,
        actor: "99999",
        action: "dashboard",
        recordType: "BuyerAccount",
        count: 10,
      });
      await Promise.all(capturedPromises);

      const totalEvents = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}
      `;
      expect(parseInt(totalEvents[0].count, 10)).toBeGreaterThanOrEqual(4);

      await assertNoPiiInAuditEvents(4);
    });
  });
});
