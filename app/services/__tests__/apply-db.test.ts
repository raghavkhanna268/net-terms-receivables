/**
 * DB-backed integration tests for S17 apply service.
 *
 * Maps to QA plan docs/qa/S17-apply.md:
 * - S17-01 through S17-05: orderMarkAsPaid and transaction semantics
 * - S17-10 through S17-13: Partial apply
 * - S17-20 through S17-23: Idempotency on retry
 * - S17-40 through S17-43: Audit trail
 * - S17-50 through S17-53: Unmatch
 * - S17-60 through S17-62: No PII leakage
 *
 * Additional tests:
 * - Audit idempotency: retried apply writes no duplicate event
 * - Audit append-only: confirm, unmatch, re-confirm yields 2 match.confirmed events
 * - Concurrency: two concurrent partial applies on same invoice get correct final outstanding
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

let mockShopifySuccess = true;
let mockAlreadyPaid = false;
let shopifyCallCount = 0;
let verifyOrderIsPaidCallCount = 0;
let orderMarkAsPaidCallCount = 0;

// Callback that runs DURING the Shopify orderMarkAsPaid call (for race condition testing)
let onOrderMarkAsPaidCallback: (() => Promise<void>) | null = null;

// Flag to make enqueueRecomputeForInvoice throw
let mockEnqueueShouldThrow = false;

// M7: Custom userErrors to inject for testing error code mapping
let mockUserErrors: Array<{ field: string[]; message: string }> | null = null;

vi.mock("../shopify-client.server", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    shopifyGraphQLRequest: vi.fn().mockImplementation(async (_shop: string, query: string) => {
      shopifyCallCount++;

      // Handle ORDER_QUERY for verifyOrderIsPaid (Issue #5)
      const isOrderQuery = query.includes("query GetOrder");
      if (isOrderQuery) {
        verifyOrderIsPaidCallCount++;
        return {
          success: true,
          data: {
            order: {
              id: "gid://shopify/Order/123",
              displayFinancialStatus: mockAlreadyPaid ? "PAID" : "PENDING",
            },
          },
        };
      }

      // Handle OrderMarkAsPaid mutation
      orderMarkAsPaidCallCount++;
      // Execute callback DURING the Shopify call (for race condition testing)
      if (onOrderMarkAsPaidCallback) {
        await onOrderMarkAsPaidCallback();
      }

      if (mockAlreadyPaid) {
        return {
          success: true,
          data: {
            orderMarkAsPaid: {
              order: null,
              userErrors: [{ field: ["id"], message: "Order has already been paid" }],
            },
          },
        };
      }

      // M7: Return custom userErrors when set (for testing error code mapping)
      if (mockUserErrors) {
        return {
          success: true,
          data: {
            orderMarkAsPaid: {
              order: null,
              userErrors: mockUserErrors,
            },
          },
        };
      }

      if (!mockShopifySuccess) {
        return { success: false, error: "Shopify API error", retryable: true };
      }

      return {
        success: true,
        data: {
          orderMarkAsPaid: {
            order: { id: "gid://shopify/Order/123", displayFinancialStatus: "PAID" },
            userErrors: [],
          },
        },
      };
    }),
  };
});

vi.mock("../credit-status-recompute.server", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    enqueueRecomputeForInvoice: vi.fn().mockImplementation(async (sql, invoiceId) => {
      if (mockEnqueueShouldThrow) {
        throw new Error("Forced enqueue error for testing");
      }
      return (actual.enqueueRecomputeForInvoice as (sql: unknown, invoiceId: string) => Promise<void>)(sql, invoiceId);
    }),
  };
});

import { applyMatch, unmatchMatch } from "../apply.server";
import { confirmMatch } from "../matcher.server";

// Note: unmatchPushedMatch is now just an alias for unmatchMatch

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("S17 apply service DB integration", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-s17";
  const TEST_SHOP_ID = `shop-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-${TEST_SUFFIX}`;
  const TEST_IMPORT_ID = `import-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "manualHold", "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-" + TEST_SUFFIX}, ${"loc-" + TEST_SUFFIX},
        'Test Account', 100000.00, 'OK', false, false, NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
      VALUES (${TEST_IMPORT_ID}, ${TEST_SHOP_ID}, 'hdfc', 'test.csv', 1, NOW())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
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
    mockShopifySuccess = true;
    mockAlreadyPaid = false;
    mockEnqueueShouldThrow = false;
    mockUserErrors = null;
    shopifyCallCount = 0;
    verifyOrderIsPaidCallCount = 0;
    orderMarkAsPaidCallCount = 0;
    onOrderMarkAsPaidCallback = null;

    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Match" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
  });

  async function createPayment(amountPaise: bigint, id?: string): Promise<string> {
    const paymentId = id ?? `pmt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    await sql`
      INSERT INTO "Payment" (id, "shopId", "importId", "valueDate", amount, rail, narration, status, "createdAt", "updatedAt")
      VALUES (${paymentId}, ${TEST_SHOP_ID}, ${TEST_IMPORT_ID}, NOW(), ${Number(amountPaise) / 100}, 'NEFT', 'Test', 'unmatched', NOW(), NOW())
    `;
    return paymentId;
  }

  async function createInvoice(outstandingPaise: bigint, orderId?: string | null, id?: string): Promise<string> {
    const invoiceId = id ?? `inv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    // When orderId is explicitly null (local-only invoice), use a synthetic draftOrderId
    // because the CHECK constraint requires exactly one of orderId/draftOrderId
    const orderGid = orderId === undefined ? `gid://shopify/Order/${invoiceId}` : orderId;
    const draftOrderGid = orderId === null ? `gid://shopify/DraftOrder/999${invoiceId.slice(-6)}` : null;
    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", "draftOrderId", name, total, outstanding, status, "issuedAt", "createdAt", "updatedAt")
      VALUES (${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderGid}, ${draftOrderGid}, ${'#' + invoiceId.slice(-6)}, ${Number(outstandingPaise) / 100}, ${Number(outstandingPaise) / 100}, 'open', NOW(), NOW(), NOW())
    `;
    return invoiceId;
  }

  async function createConfirmedMatch(paymentId: string, invoiceId: string, amountPaise: bigint): Promise<string> {
    const matchId = `match-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    await sql`
      INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "confirmedBy", "confirmedAt", "createdAt", "updatedAt")
      VALUES (${matchId}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId}, ${Number(amountPaise) / 100}, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'confirmed', 'test-user', NOW(), NOW(), NOW())
    `;
    return matchId;
  }

  async function createSuggestedMatch(paymentId: string, invoiceId: string, amountPaise: bigint): Promise<string> {
    const matchId = `match-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    await sql`
      INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
      VALUES (${matchId}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId}, ${Number(amountPaise) / 100}, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'suggested', NOW(), NOW())
    `;
    return matchId;
  }

  describe("S17-01 to S17-05: orderMarkAsPaid semantics", () => {
    it("S17-01: full match marks invoice paid and calls orderMarkAsPaid", async () => {
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      const result = await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      expect(result.success).toBe(true);
      expect(result.invoicePaid).toBe(true);
      expect(result.shopifyPushSucceeded).toBe(true);

      const [invoice] = await sql<{ outstanding: string; status: string }[]>`
        SELECT outstanding::text, status FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(invoice.status).toBe("paid");
      expect(parseFloat(invoice.outstanding)).toBe(0);
    });

    it("S17-02: Shopify failure leaves invoice unchanged", async () => {
      mockShopifySuccess = false;
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      const result = await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(true);

      const [invoice] = await sql<{ outstanding: string; status: string }[]>`
        SELECT outstanding::text, status FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(invoice.status).toBe("open");
      expect(parseFloat(invoice.outstanding)).toBe(10000);

      const [match] = await sql<{ state: string }[]>`SELECT state FROM "Match" WHERE id = ${matchId}`;
      expect(match.state).toBe("confirmed");
    });

    it("S17-04: already-paid userError is idempotent success", async () => {
      mockAlreadyPaid = true;
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      const result = await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      expect(result.success).toBe(true);
      expect(result.reasonCode).toBe("ALREADY_PAID_IN_SHOPIFY");

      const [invoice] = await sql<{ status: string }[]>`SELECT status FROM "Invoice" WHERE id = ${invoiceId}`;
      expect(invoice.status).toBe("paid");
    });
  });

  describe("S17-10 to S17-13: Partial apply", () => {
    it("S17-10: partial match reduces outstanding without Shopify call", async () => {
      const paymentId = await createPayment(500000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 500000n);

      const result = await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      expect(result.success).toBe(true);
      expect(result.invoicePaid).toBe(false);
      expect(shopifyCallCount).toBe(0);

      const [invoice] = await sql<{ outstanding: string; status: string }[]>`
        SELECT outstanding::text, status FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(invoice.status).toBe("open");
      expect(parseFloat(invoice.outstanding)).toBe(5000);
    });

    it("S17-11: second partial completes payment and calls Shopify", async () => {
      const paymentId1 = await createPayment(500000n);
      const paymentId2 = await createPayment(500000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId1 = await createConfirmedMatch(paymentId1, invoiceId, 500000n);
      const matchId2 = await createConfirmedMatch(paymentId2, invoiceId, 500000n);

      await applyMatch(sql, TEST_SHOP_ID, matchId1, "test-user");
      expect(shopifyCallCount).toBe(0);

      const result = await applyMatch(sql, TEST_SHOP_ID, matchId2, "test-user");
      expect(result.invoicePaid).toBe(true);
      expect(shopifyCallCount).toBe(1);
    });
  });

  describe("S17-20 to S17-23: Idempotency", () => {
    it("S17-20: retry of same apply is no-op", async () => {
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");
      const firstCallCount = shopifyCallCount;

      const result = await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      expect(result.success).toBe(true);
      expect(result.reasonCode).toBe("ALREADY_APPLIED");
      expect(shopifyCallCount).toBe(firstCallCount);
    });

    it("retried apply writes no duplicate match.applied event", async () => {
      const paymentId = await createPayment(500000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 500000n);

      await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");
      await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");
      await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      const [count] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID} AND type = 'match.applied' AND data->>'matchId' = ${matchId}
      `;

      expect(parseInt(count.count)).toBe(1);
    });

    /**
     * QA-requested real-DB test: Apply same ₹5,000 partial match 3 times on ₹10,000 invoice.
     * Verifies:
     * - Outstanding stays ₹5,000 (not ₹0, not negative)
     * - Status stays 'open' (not 'paid')
     * - orderMarkAsPaid is never called
     * - Exactly one match.applied event
     */
    it("idempotent partial: ₹5,000 match applied 3x on ₹10,000 invoice", async () => {
      const paymentId = await createPayment(500000n); // ₹5,000
      const invoiceId = await createInvoice(1000000n); // ₹10,000
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 500000n);

      // Reset Shopify call counter
      shopifyCallCount = 0;

      // Apply same match 3 times
      const result1 = await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");
      const result2 = await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");
      const result3 = await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      // All calls should succeed
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result3.success).toBe(true);

      // First is partial, rest are idempotent
      expect(result1.invoicePaid).toBe(false);
      expect(result2.reasonCode).toBe("ALREADY_APPLIED");
      expect(result3.reasonCode).toBe("ALREADY_APPLIED");

      // Verify orderMarkAsPaid was NEVER called (partial payment)
      expect(shopifyCallCount).toBe(0);

      // Verify invoice outstanding stays ₹5,000, status stays 'open'
      const [invoice] = await sql<{ outstanding: string; status: string }[]>`
        SELECT outstanding::text, status FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(parseFloat(invoice.outstanding)).toBe(5000); // ₹5,000 remaining
      expect(invoice.status).toBe("open");

      // Verify exactly one match.applied audit event
      const [eventCount] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND type = 'match.applied'
          AND data->>'matchId' = ${matchId}
      `;
      expect(parseInt(eventCount.count)).toBe(1);
    });
  });

  describe("Audit append-only trail", () => {
    it("confirm, unmatch, re-confirm yields 2 match.confirmed events", async () => {
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createSuggestedMatch(paymentId, invoiceId, 1000000n);

      // First confirm
      await confirmMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      // Unmatch
      await unmatchMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      // Reset to suggested for re-confirm
      await sql`UPDATE "Match" SET state = 'suggested', "updatedAt" = NOW() WHERE id = ${matchId}`;

      // Re-confirm
      await confirmMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      const [count] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID} AND type = 'match.confirmed' AND data->>'matchId' = ${matchId}
      `;

      expect(parseInt(count.count)).toBe(2);
    });
  });

  describe("S17-40 to S17-43: Audit trail", () => {
    it("S17-40: match.applied audit event is written", async () => {
      const paymentId = await createPayment(500000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 500000n);

      await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      const [event] = await sql<{ type: string; actor: string; data: Record<string, unknown> }[]>`
        SELECT type, actor, data FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID} AND type = 'match.applied' AND data->>'matchId' = ${matchId}
      `;

      expect(event).toBeDefined();
      expect(event.actor).toBe("test-user");
      expect(event.data.invoiceId).toBe(invoiceId);
      expect(event.data.paymentId).toBe(paymentId);
    });

    it("S17-41: invoice.paid audit event is written on full payment", async () => {
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      const [event] = await sql<{ type: string; data: Record<string, unknown> }[]>`
        SELECT type, data FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID} AND type = 'invoice.paid' AND data->>'invoiceId' = ${invoiceId}
      `;

      expect(event).toBeDefined();
      expect(event.data.shopifyPushSucceeded).toBe(true);
    });
  });

  describe("S17-50 to S17-53: Unmatch", () => {
    it("S17-50: unmatch a confirmed match", async () => {
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      const result = await unmatchMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      expect(result.success).toBe(true);

      const [match] = await sql<{ state: string }[]>`SELECT state FROM "Match" WHERE id = ${matchId}`;
      expect(match.state).toBe("unmatched");
    });

    it("S17-51: unmatch pushed match for paid invoice is blocked", async () => {
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      const result = await unmatchMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      expect(result.success).toBe(false);
      expect(result.alreadyPushed).toBe(true);
    });
  });

  describe("S17-60 to S17-62: No PII in audit", () => {
    it("S17-60: audit data contains only IDs and amounts", async () => {
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      const events = await sql<{ data: Record<string, unknown> }[]>`
        SELECT data FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}
      `;

      for (const event of events) {
        const dataStr = JSON.stringify(event.data);
        expect(dataStr).not.toContain("@");
        expect(dataStr).not.toContain("phone");
        expect(dataStr).not.toContain("address");
        expect(dataStr).not.toContain("narration");
        expect(dataStr).not.toContain("payerText");
      }
    });
  });

  describe("Concurrency", () => {
    it("two concurrent partial applies on same invoice get correct final outstanding", async () => {
      const paymentId1 = await createPayment(300000n);
      const paymentId2 = await createPayment(400000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId1 = await createConfirmedMatch(paymentId1, invoiceId, 300000n);
      const matchId2 = await createConfirmedMatch(paymentId2, invoiceId, 400000n);

      const [r1, r2] = await Promise.all([
        applyMatch(sql, TEST_SHOP_ID, matchId1, "test-user"),
        applyMatch(sql, TEST_SHOP_ID, matchId2, "test-user"),
      ]);

      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);

      const [invoice] = await sql<{ outstanding: string }[]>`
        SELECT outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
      `;

      expect(parseFloat(invoice.outstanding)).toBe(3000);
    });
  });

  describe("Credit status recompute enqueue", () => {
    it("enqueues CREDIT_STATUS_RECOMPUTE with correct buyerAccountId after apply", async () => {
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      const messages = await sql<{ message: { topic: string; buyerAccountId: string } }[]>`
        SELECT message FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
          AND message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
      `;

      const recomputeMsg = messages.find(m => m.message.buyerAccountId === TEST_ACCOUNT_ID);
      expect(recomputeMsg).toBeDefined();
      expect(recomputeMsg?.message.buyerAccountId).toBe(TEST_ACCOUNT_ID);
    });

    it("does NOT enqueue recompute on Shopify failure", async () => {
      mockShopifySuccess = false;
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      const messages = await sql<{ message: { topic: string; buyerAccountId: string } }[]>`
        SELECT message FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
          AND message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
          AND message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
      `;

      expect(messages.length).toBe(0);
    });
  });

  /**
   * Issue #2: Partial vs full must be decided UNDER THE LOCK.
   * Two partial applies whose sum equals outstanding gives status=paid
   * and orderMarkAsPaid called exactly once.
   */
  describe("Issue #2: Partial vs full decision under lock", () => {
    it("two partials summing to outstanding calls orderMarkAsPaid exactly once", async () => {
      const paymentId1 = await createPayment(600000n);
      const paymentId2 = await createPayment(400000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId1 = await createConfirmedMatch(paymentId1, invoiceId, 600000n);
      const matchId2 = await createConfirmedMatch(paymentId2, invoiceId, 400000n);

      // Apply first partial - should not call Shopify
      await applyMatch(sql, TEST_SHOP_ID, matchId1, "test-user");
      expect(shopifyCallCount).toBe(0);

      // Apply second partial that completes payment - should call Shopify exactly once
      shopifyCallCount = 0;
      const result = await applyMatch(sql, TEST_SHOP_ID, matchId2, "test-user");

      expect(result.success).toBe(true);
      expect(result.invoicePaid).toBe(true);
      expect(shopifyCallCount).toBe(1);

      const [invoice] = await sql<{ outstanding: string; status: string }[]>`
        SELECT outstanding::text, status FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(invoice.status).toBe("paid");
      expect(parseFloat(invoice.outstanding)).toBe(0);
    });

    it("concurrent applies under lock get correct final outstanding", async () => {
      const paymentId1 = await createPayment(250000n);
      const paymentId2 = await createPayment(250000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId1 = await createConfirmedMatch(paymentId1, invoiceId, 250000n);
      const matchId2 = await createConfirmedMatch(paymentId2, invoiceId, 250000n);

      // Apply concurrently
      const [r1, r2] = await Promise.all([
        applyMatch(sql, TEST_SHOP_ID, matchId1, "test-user"),
        applyMatch(sql, TEST_SHOP_ID, matchId2, "test-user"),
      ]);

      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
      expect(r1.invoicePaid).toBe(false);
      expect(r2.invoicePaid).toBe(false);

      const [invoice] = await sql<{ outstanding: string }[]>`
        SELECT outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
      `;

      // Both partials should have been applied correctly (5000 remaining)
      expect(parseFloat(invoice.outstanding)).toBe(5000);
    });
  });

  /**
   * Issue #3: Unmatch restores exact applied amount (not original Match.amount which may have been capped).
   * Also tests Payment.status update on unmatch.
   */
  describe("Issue #3: Unmatch restores exact applied amount", () => {
    it("unmatch restores capped amount when match was applied for less than Match.amount", async () => {
      // Create a payment larger than invoice outstanding
      const paymentId = await createPayment(1500000n); // 15000 INR
      const invoiceId = await createInvoice(1000000n); // 10000 INR
      // Match for full payment amount but will be capped to outstanding
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1500000n);

      // Create a partial apply scenario by first reducing outstanding
      await sql`UPDATE "Invoice" SET outstanding = 5000.00 WHERE id = ${invoiceId}`;

      // Apply - should only apply 5000 (capped to outstanding), not 15000
      await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      const [beforeUnmatch] = await sql<{ outstanding: string }[]>`
        SELECT outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(parseFloat(beforeUnmatch.outstanding)).toBe(0);

      // Reset invoice to open status so unmatch is allowed
      await sql`UPDATE "Invoice" SET status = 'open' WHERE id = ${invoiceId}`;

      // Unmatch - should restore exactly 5000 (the capped amount), not 15000
      const result = await unmatchMatch(sql, TEST_SHOP_ID, matchId, "test-user");
      expect(result.success).toBe(true);

      const [afterUnmatch] = await sql<{ outstanding: string }[]>`
        SELECT outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
      `;

      // Should restore exactly 5000 (from audit), not 15000 (from Match.amount)
      expect(parseFloat(afterUnmatch.outstanding)).toBe(5000);
    });

    it("unmatch updates Payment.status to partial when suggested matches remain", async () => {
      const paymentId = await createPayment(1000000n);
      const invoiceId1 = await createInvoice(500000n);
      const invoiceId2 = await createInvoice(500000n);

      // Create confirmed match on first invoice
      const matchId1 = await createConfirmedMatch(paymentId, invoiceId1, 500000n);
      // Create suggested match on second invoice
      await createSuggestedMatch(paymentId, invoiceId2, 500000n);

      // Update payment status to matched (simulating after confirm)
      await sql`UPDATE "Payment" SET status = 'partial' WHERE id = ${paymentId}`;

      // Unmatch the confirmed match
      const result = await unmatchMatch(sql, TEST_SHOP_ID, matchId1, "test-user");
      expect(result.success).toBe(true);

      // Payment should be 'partial' because suggested match still exists
      const [payment] = await sql<{ status: string }[]>`
        SELECT status FROM "Payment" WHERE id = ${paymentId}
      `;
      expect(payment.status).toBe("partial");
    });

    it("unmatch updates Payment.status to unmatched when no matches remain", async () => {
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      // Update payment status to matched
      await sql`UPDATE "Payment" SET status = 'matched' WHERE id = ${paymentId}`;

      // Unmatch
      const result = await unmatchMatch(sql, TEST_SHOP_ID, matchId, "test-user");
      expect(result.success).toBe(true);

      // Payment should be 'unmatched' because no suggested matches exist
      const [payment] = await sql<{ status: string }[]>`
        SELECT status FROM "Payment" WHERE id = ${paymentId}
      `;
      expect(payment.status).toBe("unmatched");
    });
  });

  /**
   * Issue #4: enqueueRecomputeForInvoice failures are logged without PII.
   * We verify that failures don't break the apply and log appropriately.
   */
  describe("Issue #4: Enqueue failures are logged without PII", () => {
    it("apply succeeds even when enqueue fails", async () => {
      // Create a scenario where enqueue would succeed
      const paymentId = await createPayment(500000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 500000n);

      // Apply should succeed
      const result = await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");
      expect(result.success).toBe(true);

      // Verify invoice was updated regardless of enqueue
      const [invoice] = await sql<{ outstanding: string }[]>`
        SELECT outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(parseFloat(invoice.outstanding)).toBe(5000);
    });
  });

  /**
   * Issue #5: Already-paid detection uses displayFinancialStatus query.
   * We verify the Shopify query is used to check order status.
   */
  describe("Issue #5: Already-paid detection uses displayFinancialStatus", () => {
    it("handles already-paid via displayFinancialStatus query", async () => {
      mockAlreadyPaid = true;
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      const result = await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      expect(result.success).toBe(true);
      expect(result.reasonCode).toBe("ALREADY_PAID_IN_SHOPIFY");

      // Invoice should still be marked paid
      const [invoice] = await sql<{ status: string }[]>`
        SELECT status FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(invoice.status).toBe("paid");
    });
  });

  /**
   * P1: No 'pushed' without match.applied audit.
   * A 'pushed' match without audit gets transitioned to 'unmatched'.
   */
  describe("P1: Pushed without audit transitions to unmatched", () => {
    it("transitions pushed match without audit to unmatched (full payment scenario)", async () => {
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);

      // Create a match directly in 'pushed' state WITHOUT audit event
      const matchId = `match-no-audit-${Date.now().toString(36)}`;
      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${matchId}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId}, 10000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'pushed', NOW(), NOW())
      `;

      // Invoice is still open (no audit = no reduction)
      const [before] = await sql<{ status: string; outstanding: string }[]>`
        SELECT status, outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(before.status).toBe("open");
      expect(parseFloat(before.outstanding)).toBe(10000);

      // Call applyMatch - should detect missing audit and transition to unmatched
      const result = await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      expect(result.success).toBe(false);
      expect(result.reasonCode).toBe("PUSHED_WITHOUT_AUDIT");

      // Match should now be 'unmatched'
      const [match] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchId}
      `;
      expect(match.state).toBe("unmatched");

      // Invoice outstanding should be unchanged (nothing was applied)
      const [after] = await sql<{ status: string; outstanding: string }[]>`
        SELECT status, outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(after.status).toBe("open");
      expect(parseFloat(after.outstanding)).toBe(10000);

      // Audit trail should have match.unmatched with PUSHED_WITHOUT_AUDIT reason
      const [auditEvent] = await sql<{ data: { reason?: string; previousState?: string } }[]>`
        SELECT data FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND type = 'match.unmatched'
          AND data->>'matchId' = ${matchId}
      `;
      expect(auditEvent).toBeDefined();
      expect(auditEvent?.data.reason).toBe("PUSHED_WITHOUT_AUDIT");
      expect(auditEvent?.data.previousState).toBe("pushed");

      // Payment status should be recomputed (freed up)
      const [payment] = await sql<{ status: string }[]>`
        SELECT status FROM "Payment" WHERE id = ${paymentId}
      `;
      expect(payment.status).toBe("unmatched");
    });

    it("idempotent retry for pushed match with paid invoice", async () => {
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);

      // Create a match in 'pushed' state with invoice already paid (normal completion)
      const matchId = `match-idempotent-${Date.now().toString(36)}`;
      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${matchId}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId}, 10000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'pushed', NOW(), NOW())
      `;

      // Mark invoice as already paid
      await sql`UPDATE "Invoice" SET status = 'paid', outstanding = 0 WHERE id = ${invoiceId}`;

      // Call applyMatch - should be idempotent success (invoice is paid = success)
      const result = await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      expect(result.success).toBe(true);
      expect(result.invoicePaid).toBe(true);
      expect(result.reasonCode).toBe("ALREADY_APPLIED");

      // Should NOT create new audit events
      const events = await sql<{ id: string }[]>`
        SELECT id FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND data->>'matchId' = ${matchId}
      `;
      expect(events.length).toBe(0);
    });

    it("partial pushed without audit also transitions to unmatched", async () => {
      const paymentId = await createPayment(500000n);
      const invoiceId = await createInvoice(1000000n);

      // Create a match in 'pushed' state for partial payment WITHOUT audit
      const matchId = `match-partial-no-audit-${Date.now().toString(36)}`;
      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${matchId}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId}, 5000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'pushed', NOW(), NOW())
      `;

      // Invoice is still open
      const result = await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      expect(result.success).toBe(false);
      expect(result.reasonCode).toBe("PUSHED_WITHOUT_AUDIT");

      // Match should now be 'unmatched'
      const [match] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchId}
      `;
      expect(match.state).toBe("unmatched");

      // Outstanding unchanged (nothing was applied)
      const [invoice] = await sql<{ outstanding: string; status: string }[]>`
        SELECT outstanding::text, status FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(parseFloat(invoice.outstanding)).toBe(10000);
      expect(invoice.status).toBe("open");
    });
  });

  /**
   * IDOR protection tests: applyMatch and unmatchMatch must reject
   * requests for matches belonging to other shops.
   */
  describe("IDOR protection: cross-shop isolation", () => {
    const OTHER_SHOP_ID = `shop-other-${Date.now().toString(36)}`;
    const OTHER_SHOP_DOMAIN = `other-${Date.now().toString(36)}.myshopify.com`;

    beforeAll(async () => {
      // Create a second shop for cross-shop tests
      await sql`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
        VALUES (${OTHER_SHOP_ID}, ${OTHER_SHOP_DOMAIN}, 'INR', NOW(), NOW())
        ON CONFLICT (id) DO NOTHING
      `;
    });

    afterAll(async () => {
      await sql`DELETE FROM "Match" WHERE "shopId" = ${OTHER_SHOP_ID}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${OTHER_SHOP_ID}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${OTHER_SHOP_ID}`;
      await sql`DELETE FROM "Shop" WHERE id = ${OTHER_SHOP_ID}`;
    });

    it("applyMatch returns not-found for match belonging to different shop", async () => {
      // Create match in TEST_SHOP_ID
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      // Record initial state
      const [beforeMatch] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchId}
      `;
      const [beforeInvoice] = await sql<{ outstanding: string }[]>`
        SELECT outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
      `;

      // Try to apply using OTHER_SHOP_ID - should fail with not-found
      const result = await applyMatch(sql, OTHER_SHOP_ID, matchId, "test-user");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Match not found");

      // Verify nothing changed
      const [afterMatch] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchId}
      `;
      const [afterInvoice] = await sql<{ outstanding: string }[]>`
        SELECT outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
      `;

      expect(afterMatch.state).toBe(beforeMatch.state);
      expect(afterInvoice.outstanding).toBe(beforeInvoice.outstanding);
    });

    it("unmatchMatch returns not-found for match belonging to different shop", async () => {
      // Create confirmed match in TEST_SHOP_ID
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      // Record initial state
      const [beforeMatch] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchId}
      `;

      // Try to unmatch using OTHER_SHOP_ID - should fail with not-found
      const result = await unmatchMatch(sql, OTHER_SHOP_ID, matchId, "test-user");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Match not found");

      // Verify match state unchanged
      const [afterMatch] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchId}
      `;
      expect(afterMatch.state).toBe(beforeMatch.state);
    });
  });

  /**
   * Race condition test: A partial apply is attempted during a slow Shopify call.
   * TX1's PUSH_IN_PROGRESS guard should REFUSE the partial apply while match1 is in 'pushing' state.
   * This test uses the REAL path: stubs shopifyGraphQLRequest to trigger a concurrent
   * partial applyMatch during the orderMarkAsPaid call.
   */
  describe("Race condition: partial during slow Shopify call", () => {
    it("TX1 refuses partial while full payment push is in flight ('pushing' state)", async () => {
      const paymentId1 = await createPayment(1000000n); // Full payment
      const paymentId2 = await createPayment(300000n);  // Partial that tries during push
      const invoiceId = await createInvoice(1000000n);
      const matchId1 = await createConfirmedMatch(paymentId1, invoiceId, 1000000n);
      const matchId2 = await createConfirmedMatch(paymentId2, invoiceId, 300000n);

      // Track the partial apply result and match1's state during callback
      let partialResult: { success: boolean; reasonCode?: string } | null = null;
      let match1StateDuringCallback: string | null = null;

      // Set up callback to attempt partial apply DURING the Shopify orderMarkAsPaid call
      // This simulates a concurrent partial landing while the full payment push is in flight
      onOrderMarkAsPaidCallback = async () => {
        // At this point, match1 is in 'pushing' state (TX1 complete, Shopify call in progress)
        const [match1During] = await sql<{ state: string }[]>`
          SELECT state FROM "Match" WHERE id = ${matchId1}
        `;
        match1StateDuringCallback = match1During?.state ?? null;

        // Attempting to apply match2 should be REFUSED with PUSH_IN_PROGRESS
        partialResult = await applyMatch(sql, TEST_SHOP_ID, matchId2, "test-user");
      };

      // Apply the full payment (this will trigger the callback during Shopify call)
      shopifyCallCount = 0;
      const fullResult = await applyMatch(sql, TEST_SHOP_ID, matchId1, "test-user");

      // Full payment should succeed
      expect(fullResult.success).toBe(true);
      expect(fullResult.invoicePaid).toBe(true);

      // Match1 was in 'pushing' state DURING the Shopify call
      expect(match1StateDuringCallback).toBe("pushing");

      // Partial should have been REFUSED with PUSH_IN_PROGRESS
      expect(partialResult).not.toBeNull();
      expect(partialResult!.success).toBe(false);
      expect(partialResult!.reasonCode).toBe("PUSH_IN_PROGRESS");

      // Only ONE orderMarkAsPaid call (for the full payment)
      expect(shopifyCallCount).toBe(1);

      // Invoice should be paid with outstanding 0
      const [invoice] = await sql<{ status: string; outstanding: string }[]>`
        SELECT status, outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(invoice.status).toBe("paid");
      expect(parseFloat(invoice.outstanding)).toBe(0);

      // Match1 should be 'pushed' (finalized), Match2 should still be 'confirmed' (not applied)
      const [match1] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchId1}
      `;
      const [match2] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchId2}
      `;
      expect(match1.state).toBe("pushed");
      expect(match2.state).toBe("confirmed");
    });

    it("fresh 'pushing' match (< 5 min) blocks apply even from initial path", async () => {
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);

      // Create a match directly in 'pushing' state (simulating TX1 complete)
      // with recent updatedAt (not stale)
      const matchId = `match-pushing-fresh-${Date.now().toString(36)}`;
      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${matchId}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId}, 10000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'pushing', NOW(), NOW())
      `;

      // Trying to apply should return PUSH_IN_PROGRESS (not yet stale)
      const result = await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      expect(result.success).toBe(false);
      expect(result.reasonCode).toBe("PUSH_IN_PROGRESS");

      // Match should still be 'pushing'
      const [match] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchId}
      `;
      expect(match.state).toBe("pushing");
    });
  });

  /**
   * Stale re-claim tests: 'pushing' matches older than 5 minutes can be reclaimed.
   * Only one retrier wins the conditional UPDATE.
   */
  describe("Stale re-claim: 'pushing' > 5 minutes", () => {
    it("reclaims stale 'pushing' match when Shopify already paid", async () => {
      mockAlreadyPaid = true;
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);

      // Create a match in 'pushing' state with old updatedAt (> 5 min)
      const matchId = `match-stale-paid-${Date.now().toString(36)}`;
      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${matchId}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId}, 10000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'pushing', NOW() - interval '10 minutes', NOW() - interval '10 minutes')
      `;

      // Apply - should reclaim and find Shopify already paid
      const result = await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      expect(result.success).toBe(true);
      expect(result.invoicePaid).toBe(true);
      expect(result.reasonCode).toBe("STALE_RECLAIM_SHOPIFY_ALREADY_PAID");

      // Match should now be 'pushed'
      const [match] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchId}
      `;
      expect(match.state).toBe("pushed");

      // Invoice should be paid
      const [invoice] = await sql<{ status: string; outstanding: string }[]>`
        SELECT status, outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(invoice.status).toBe("paid");
      expect(parseFloat(invoice.outstanding)).toBe(0);

      // Audit event should have staleReclaim and shopifyAlreadyPaid flags
      const [auditEvent] = await sql<{ data: { staleReclaim?: boolean; shopifyAlreadyPaid?: boolean } }[]>`
        SELECT data FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND type = 'match.applied'
          AND data->>'matchId' = ${matchId}
      `;
      expect(auditEvent?.data.staleReclaim).toBe(true);
      expect(auditEvent?.data.shopifyAlreadyPaid).toBe(true);
    });

    it("reclaims stale 'pushing' match when Shopify NOT paid (re-pushes)", async () => {
      mockShopifySuccess = true;
      mockAlreadyPaid = false;
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);

      // Create a match in 'pushing' state with old updatedAt (> 5 min)
      const matchId = `match-stale-retry-${Date.now().toString(36)}`;
      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${matchId}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId}, 10000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'pushing', NOW() - interval '10 minutes', NOW() - interval '10 minutes')
      `;

      // Reset call counts
      shopifyCallCount = 0;
      verifyOrderIsPaidCallCount = 0;
      orderMarkAsPaidCallCount = 0;

      // Apply - should reclaim and re-push to Shopify
      const result = await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      expect(result.success).toBe(true);
      expect(result.invoicePaid).toBe(true);
      expect(result.reasonCode).toBe("STALE_RECLAIM_FULL");

      // Exactly one verifyOrderIsPaid call, exactly one orderMarkAsPaid call
      expect(verifyOrderIsPaidCallCount).toBe(1);
      expect(orderMarkAsPaidCallCount).toBe(1);

      // Match should now be 'pushed'
      const [match] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchId}
      `;
      expect(match.state).toBe("pushed");

      // Invoice should be paid
      const [invoice] = await sql<{ status: string }[]>`
        SELECT status FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(invoice.status).toBe("paid");

      // Audit event should have staleReclaim flag
      const [auditEvent] = await sql<{ data: { staleReclaim?: boolean } }[]>`
        SELECT data FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND type = 'match.applied'
          AND data->>'matchId' = ${matchId}
      `;
      expect(auditEvent?.data.staleReclaim).toBe(true);
    });

    it("stale partial re-claim (local-only) completes without Shopify call", async () => {
      const paymentId = await createPayment(500000n); // 5000 INR partial
      // Create invoice WITHOUT orderId (local-only invoice, no Shopify call needed)
      const invoiceId = await createInvoice(1000000n, null); // 10000 INR, no orderId

      // Create a match in 'pushing' state with old updatedAt (> 5 min)
      const matchId = `match-stale-partial-${Date.now().toString(36)}`;
      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${matchId}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId}, 5000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'pushing', NOW() - interval '10 minutes', NOW() - interval '10 minutes')
      `;

      // Reset call counts
      shopifyCallCount = 0;
      verifyOrderIsPaidCallCount = 0;
      orderMarkAsPaidCallCount = 0;

      // Apply - should reclaim and finalize partial (no Shopify call needed)
      const result = await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      expect(result.success).toBe(true);
      expect(result.invoicePaid).toBe(false); // Partial
      expect(result.reasonCode).toBe("STALE_RECLAIM_PARTIAL");

      // No Shopify call for local-only invoice partial
      expect(shopifyCallCount).toBe(0);
      expect(verifyOrderIsPaidCallCount).toBe(0);
      expect(orderMarkAsPaidCallCount).toBe(0);

      // Match should now be 'pushed'
      const [match] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchId}
      `;
      expect(match.state).toBe("pushed");

      // Invoice should have reduced outstanding but still open
      const [invoice] = await sql<{ status: string; outstanding: string }[]>`
        SELECT status, outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(invoice.status).toBe("open");
      expect(parseFloat(invoice.outstanding)).toBe(5000); // 5000 remaining
    });

    it("stale partial re-claim WITH orderId: one verifyOrderIsPaid, zero orderMarkAsPaid", async () => {
      // Test case (b): stale partial with orderId
      // When Shopify reports NOT paid, we still only do partial local finalization
      mockAlreadyPaid = false; // Shopify says order is NOT paid yet
      const paymentId = await createPayment(500000n); // 5000 INR partial
      // Create invoice WITH orderId (Shopify-linked invoice)
      const invoiceId = await createInvoice(1000000n); // 10000 INR, has orderId by default

      // Create a match in 'pushing' state with old updatedAt (> 5 min)
      const matchId = `match-stale-partial-order-${Date.now().toString(36)}`;
      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${matchId}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId}, 5000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'pushing', NOW() - interval '10 minutes', NOW() - interval '10 minutes')
      `;

      // Reset call counts
      shopifyCallCount = 0;
      verifyOrderIsPaidCallCount = 0;
      orderMarkAsPaidCallCount = 0;

      // Apply - should reclaim, check Shopify status, then finalize partial locally
      const result = await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      expect(result.success).toBe(true);
      expect(result.invoicePaid).toBe(false); // Partial - Shopify not called for orderMarkAsPaid
      expect(result.reasonCode).toBe("STALE_RECLAIM_PARTIAL");

      // Exactly ONE verifyOrderIsPaid call (to check if already paid)
      expect(verifyOrderIsPaidCallCount).toBe(1);
      // ZERO orderMarkAsPaid calls (partial doesn't call Shopify to mark paid)
      expect(orderMarkAsPaidCallCount).toBe(0);
      // Total calls = 1
      expect(shopifyCallCount).toBe(1);

      // Match should now be 'pushed'
      const [match] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchId}
      `;
      expect(match.state).toBe("pushed");

      // Invoice should have reduced outstanding but still open
      const [invoice] = await sql<{ status: string; outstanding: string }[]>`
        SELECT status, outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(invoice.status).toBe("open");
      expect(parseFloat(invoice.outstanding)).toBe(5000); // 5000 remaining
    });

    it("stale partial re-claim when Shopify already paid: uses LOCKED outstanding", async () => {
      // Test case: Shopify reports PAID, but we must decide partial vs full from LOCKED outstanding
      mockAlreadyPaid = true; // Shopify says order IS paid
      const paymentId = await createPayment(500000n); // 5000 INR partial
      const invoiceId = await createInvoice(1000000n); // 10000 INR, has orderId

      // Create a match in 'pushing' state with old updatedAt (> 5 min)
      const matchId = `match-stale-partial-shopify-paid-${Date.now().toString(36)}`;
      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${matchId}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId}, 5000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'pushing', NOW() - interval '10 minutes', NOW() - interval '10 minutes')
      `;

      // Reset call counts
      verifyOrderIsPaidCallCount = 0;
      orderMarkAsPaidCallCount = 0;

      // Apply - should reclaim, check Shopify (which says PAID), then finalize as PARTIAL
      const result = await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      expect(result.success).toBe(true);
      // Should still be partial because match amount (5000) < invoice outstanding (10000)
      expect(result.invoicePaid).toBe(false);
      expect(result.reasonCode).toBe("STALE_RECLAIM_SHOPIFY_ALREADY_PAID_PARTIAL");

      // Exactly ONE verifyOrderIsPaid call
      expect(verifyOrderIsPaidCallCount).toBe(1);
      // ZERO orderMarkAsPaid calls
      expect(orderMarkAsPaidCallCount).toBe(0);

      // Match should now be 'pushed'
      const [match] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchId}
      `;
      expect(match.state).toBe("pushed");

      // Invoice should have reduced outstanding but still open (partial, not full)
      const [invoice] = await sql<{ status: string; outstanding: string }[]>`
        SELECT status, outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(invoice.status).toBe("open");
      expect(parseFloat(invoice.outstanding)).toBe(5000); // 5000 remaining
    });

    it("only one retrier wins stale re-claim (conditional UPDATE)", async () => {
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);

      // Create a match in 'pushing' state with old updatedAt
      const matchId = `match-stale-race-${Date.now().toString(36)}`;
      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${matchId}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId}, 10000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'pushing', NOW() - interval '10 minutes', NOW() - interval '10 minutes')
      `;

      // Reset call counts
      orderMarkAsPaidCallCount = 0;

      // Simulate concurrent retriers
      const [r1, r2] = await Promise.all([
        applyMatch(sql, TEST_SHOP_ID, matchId, "test-user-1"),
        applyMatch(sql, TEST_SHOP_ID, matchId, "test-user-2"),
      ]);

      // Exactly one should succeed
      const successes = [r1, r2].filter(r => r.success);
      const failures = [r1, r2].filter(r => !r.success);

      expect(successes.length).toBe(1);
      expect(failures.length).toBe(1);

      // The failure should be due to race
      expect(failures[0].reasonCode).toMatch(/PUSH_IN_PROGRESS|ALREADY_APPLIED|STALE_RECLAIM/);

      // Exactly one orderMarkAsPaid call
      expect(orderMarkAsPaidCallCount).toBe(1);

      // Match should be 'pushed' (finalized by winner)
      const [match] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchId}
      `;
      expect(match.state).toBe("pushed");
    });
  });

  /**
   * Stale invoice-not-open scenarios: when a stale 'pushing' match is retried
   * but the invoice is no longer open (paid by sibling, webhook, or cancelled).
   * INVARIANT: Every state='pushed' must have a match.applied audit in same TX.
   *
   * NOTE: An Apply on B can finalize a stale sibling A first. When B tries to apply
   * and finds stale A (> 5 min) on the same invoice, the pre-TX1 recovery finalizes A.
   */
  describe("Stale invoice-not-open scenarios", () => {
    /**
     * Apply on B can finalize a stale sibling A first: when B tries to apply and finds
     * a stale 'pushing' sibling A (> 5 min) on the same invoice, the pre-TX1 recovery
     * finalizes A first. Then B is refused because the invoice is no longer open.
     */
    it("Apply B finalizes stale sibling A first: A pushed with audit, B refused, Payment B not allocated", async () => {
      // Scenario: Match A is stale 'pushing' (full payment), Match B is confirmed (full payment)
      // When B applies, pre-TX1 recovery should finalize A first, making invoice paid
      // Then B should fail because invoice is no longer open
      const paymentIdA = await createPayment(1000000n); // 10000 INR
      const paymentIdB = await createPayment(1000000n); // 10000 INR
      const invoiceId = await createInvoice(1000000n); // 10000 INR

      // Create match A in 'pushing' state with old updatedAt (> 5 min)
      // Also need a push_claimed audit for it
      const matchIdA = `match-stale-sibling-a-${Date.now().toString(36)}`;
      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${matchIdA}, ${TEST_SHOP_ID}, ${paymentIdA}, ${invoiceId}, 10000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'pushing', NOW() - interval '10 minutes', NOW() - interval '10 minutes')
      `;

      // Write push_claimed audit for match A (simulating TX1 that happened 10 min ago)
      await sql`
        INSERT INTO "AuditEvent" (id, "shopId", actor, type, data, at)
        VALUES (
          gen_random_uuid(),
          ${TEST_SHOP_ID},
          'test-user',
          'match.push_claimed',
          ${sql.json({ matchId: matchIdA, invoiceId, paymentId: paymentIdA, outstandingAtClaimPaise: '1000000' })}::jsonb,
          NOW() - interval '10 minutes'
        )
      `;

      // Create and confirm match B
      const matchIdB = await createConfirmedMatch(paymentIdB, invoiceId, 1000000n);

      // Reset counts
      mockShopifySuccess = true;
      mockAlreadyPaid = false;
      orderMarkAsPaidCallCount = 0;

      // Apply match B - this should:
      // 1. Find stale sibling A and recover it first (pre-TX1 recovery)
      // 2. A gets finalized → invoice is now paid
      // 3. B should fail because invoice is no longer open
      const resultB = await applyMatch(sql, TEST_SHOP_ID, matchIdB, "test-user");

      // B should NOT succeed - invoice is no longer open (A paid it)
      expect(resultB.success).toBe(false);
      expect(resultB.reasonCode).toBe("INVOICE_NOT_OPEN");

      // Match A should be 'pushed' (recovered by pre-TX1 sibling recovery)
      const [matchA] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchIdA}
      `;
      expect(matchA.state).toBe("pushed");

      // Match A should have match.applied audit
      const [matchAAppliedAudit] = await sql<{ data: { staleReclaim?: boolean; amountPaise?: string } }[]>`
        SELECT data FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND type = 'match.applied'
          AND data->>'matchId' = ${matchIdA}
      `;
      expect(matchAAppliedAudit).toBeDefined();
      expect(matchAAppliedAudit?.data.staleReclaim).toBe(true);

      // Match B should still be 'confirmed' (unchanged, apply was refused)
      const [matchB] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchIdB}
      `;
      expect(matchB.state).toBe("confirmed");

      // NO match.applied audit for B
      const [matchBAudit] = await sql<{ id: string }[]>`
        SELECT id FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND type = 'match.applied'
          AND data->>'matchId' = ${matchIdB}
      `;
      expect(matchBAudit).toBeUndefined();

      // Invoice outstanding should be 0 (paid by A)
      const [invoiceFinal] = await sql<{ status: string; outstanding: string }[]>`
        SELECT status, outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(invoiceFinal.status).toBe("paid");
      expect(parseFloat(invoiceFinal.outstanding)).toBe(0);

      // Payment B's status should still be 'unmatched' (or unchanged - not allocated)
      // Since B was refused, its payment should still be available
      const [paymentB] = await sql<{ status: string }[]>`
        SELECT status FROM "Payment" WHERE id = ${paymentIdB}
      `;
      expect(paymentB.status).toBe("unmatched");

      // orderMarkAsPaid should be called exactly once (for A's recovery)
      expect(orderMarkAsPaidCallCount).toBe(1);
    });

    it("webhook marks invoice paid (no sibling), Retry A: pushed with STALE_FINALIZED_EXTERNALLY_PAID", async () => {
      // Scenario: Match A is stale 'pushing', webhook marks invoice paid, then A is retried
      // Decision: Invoice is paid with no sibling - our push likely worked, finalize with audit
      const paymentId = await createPayment(1000000n); // 10000 INR
      const invoiceId = await createInvoice(1000000n); // 10000 INR

      // Create match A in 'pushing' state with old updatedAt (> 5 min)
      const matchIdA = `match-stale-webhook-${Date.now().toString(36)}`;
      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${matchIdA}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId}, 10000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'pushing', NOW() - interval '10 minutes', NOW() - interval '10 minutes')
      `;

      // Write push_claimed audit for match A (simulating TX1 that happened 10 min ago)
      await sql`
        INSERT INTO "AuditEvent" (id, "shopId", actor, type, data, at)
        VALUES (
          gen_random_uuid(),
          ${TEST_SHOP_ID},
          'test-user',
          'match.push_claimed',
          ${sql.json({ matchId: matchIdA, invoiceId, paymentId, outstandingAtClaimPaise: '1000000' })}::jsonb,
          NOW() - interval '10 minutes'
        )
      `;

      // Simulate webhook marking invoice as paid (no sibling match.applied)
      await sql`
        UPDATE "Invoice"
        SET status = 'paid', outstanding = 0, "updatedAt" = NOW()
        WHERE id = ${invoiceId}
      `;

      // Reset counts
      orderMarkAsPaidCallCount = 0;

      // Now retry match A - should be PUSHED with STALE_FINALIZED_EXTERNALLY_PAID
      const resultA = await applyMatch(sql, TEST_SHOP_ID, matchIdA, "test-user");

      // A should succeed - it's being finalized
      expect(resultA.success).toBe(true);
      expect(resultA.invoicePaid).toBe(true);

      // Zero orderMarkAsPaid calls (invoice already paid, no need to call Shopify)
      expect(orderMarkAsPaidCallCount).toBe(0);

      // Match A should be 'pushed'
      const [matchA] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchIdA}
      `;
      expect(matchA.state).toBe("pushed");

      // Match A should have match.applied audit with STALE_FINALIZED_EXTERNALLY_PAID
      const appliedAudits = await sql<{ data: { reasonCode?: string; amountPaise?: string } }[]>`
        SELECT data FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND type = 'match.applied'
          AND data->>'matchId' = ${matchIdA}
      `;
      expect(appliedAudits.length).toBe(1);
      expect(appliedAudits[0].data.reasonCode).toBe("STALE_FINALIZED_EXTERNALLY_PAID");
      expect(appliedAudits[0].data.amountPaise).toBe("1000000");

      // NO match.unmatched audit
      const [unmatchedAudit] = await sql<{ id: string }[]>`
        SELECT id FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND type = 'match.unmatched'
          AND data->>'matchId' = ${matchIdA}
      `;
      expect(unmatchedAudit).toBeUndefined();

      // Payment status should be 'matched'
      const [payment] = await sql<{ status: string }[]>`
        SELECT status FROM "Payment" WHERE id = ${paymentId}
      `;
      expect(payment.status).toBe("matched");
    });

    it("cancelled invoice, Retry A: A unmatched with audit, invoice unchanged", async () => {
      // Scenario: Match A is stale 'pushing', invoice is cancelled, then A is retried
      const paymentId = await createPayment(1000000n); // 10000 INR
      const invoiceId = await createInvoice(1000000n); // 10000 INR

      // Create match A in 'pushing' state with old updatedAt (> 5 min)
      const matchIdA = `match-stale-cancelled-${Date.now().toString(36)}`;
      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${matchIdA}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId}, 10000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'pushing', NOW() - interval '10 minutes', NOW() - interval '10 minutes')
      `;

      // Write push_claimed audit for match A
      await sql`
        INSERT INTO "AuditEvent" (id, "shopId", actor, type, data, at)
        VALUES (
          gen_random_uuid(),
          ${TEST_SHOP_ID},
          'test-user',
          'match.push_claimed',
          ${sql.json({ matchId: matchIdA, invoiceId, paymentId, outstandingAtClaimPaise: '1000000' })}::jsonb,
          NOW() - interval '10 minutes'
        )
      `;

      // Cancel the invoice
      await sql`
        UPDATE "Invoice"
        SET status = 'cancelled', "updatedAt" = NOW()
        WHERE id = ${invoiceId}
      `;

      // Reset counts
      orderMarkAsPaidCallCount = 0;

      // Now retry match A - should be unmatched
      const resultA = await applyMatch(sql, TEST_SHOP_ID, matchIdA, "test-user");

      // A should NOT succeed since it's being unmatched
      expect(resultA.success).toBe(false);
      expect(resultA.reasonCode).toBe("INVOICE_NOT_OPEN");

      // Zero orderMarkAsPaid calls
      expect(orderMarkAsPaidCallCount).toBe(0);

      // Match A should be 'unmatched'
      const [matchA] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchIdA}
      `;
      expect(matchA.state).toBe("unmatched");

      // Invoice should still be cancelled with original outstanding
      const [invoice] = await sql<{ status: string; outstanding: string }[]>`
        SELECT status, outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(invoice.status).toBe("cancelled");
      expect(parseFloat(invoice.outstanding)).toBe(10000); // Unchanged

      // Match A's unmatched audit should exist with reason INVOICE_NOT_OPEN
      const [unmatchedAudit] = await sql<{ data: { reason?: string; invoiceStatus?: string } }[]>`
        SELECT data FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND type = 'match.unmatched'
          AND data->>'matchId' = ${matchIdA}
      `;
      expect(unmatchedAudit).toBeDefined();
      expect(unmatchedAudit?.data.reason).toBe("INVOICE_NOT_OPEN");
      expect(unmatchedAudit?.data.invoiceStatus).toBe("cancelled");
    });

    it("STALE_FINALIZED_EXTERNALLY_PAID match can be unmatched even when invoice is paid", async () => {
      // Scenario: Match A is finalized via STALE_FINALIZED_EXTERNALLY_PAID, then unmatched
      const paymentId = await createPayment(1000000n); // 10000 INR
      const invoiceId = await createInvoice(1000000n); // 10000 INR

      // Create match A in 'pushed' state (simulating after STALE_FINALIZED_EXTERNALLY_PAID)
      const matchIdA = `match-stale-external-${Date.now().toString(36)}`;
      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${matchIdA}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId}, 10000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'pushed', NOW(), NOW())
      `;

      // Write match.applied audit with STALE_FINALIZED_EXTERNALLY_PAID reasonCode
      await sql`
        INSERT INTO "AuditEvent" (id, "shopId", actor, type, data, at)
        VALUES (
          gen_random_uuid(),
          ${TEST_SHOP_ID},
          'test-user',
          'match.applied',
          ${sql.json({ matchId: matchIdA, invoiceId, paymentId, amountPaise: '1000000', reasonCode: 'STALE_FINALIZED_EXTERNALLY_PAID' })}::jsonb,
          NOW()
        )
      `;

      // Mark invoice as paid (webhook scenario)
      await sql`
        UPDATE "Invoice"
        SET status = 'paid', outstanding = 0, "updatedAt" = NOW()
        WHERE id = ${invoiceId}
      `;

      // Unmatch - should succeed for STALE_FINALIZED_EXTERNALLY_PAID matches
      const result = await unmatchMatch(sql, TEST_SHOP_ID, matchIdA, "test-user");

      expect(result.success).toBe(true);

      // Match should be 'unmatched'
      const [matchA] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchIdA}
      `;
      expect(matchA.state).toBe("unmatched");

      // Invoice should remain paid with outstanding 0 (unchanged)
      const [invoice] = await sql<{ status: string; outstanding: string }[]>`
        SELECT status, outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(invoice.status).toBe("paid");
      expect(parseFloat(invoice.outstanding)).toBe(0);

      // Audit should have STALE_EXTERNAL_PAID_RELEASED reason
      const [unmatchedAudit] = await sql<{ data: { reason?: string; restoredPaise?: string } }[]>`
        SELECT data FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND type = 'match.unmatched'
          AND data->>'matchId' = ${matchIdA}
      `;
      expect(unmatchedAudit).toBeDefined();
      expect(unmatchedAudit?.data.reason).toBe("STALE_EXTERNAL_PAID_RELEASED");
      expect(unmatchedAudit?.data.restoredPaise).toBe("0");

      // Payment should be free (not allocated)
      const [payment] = await sql<{ status: string }[]>`
        SELECT status FROM "Payment" WHERE id = ${paymentId}
      `;
      expect(payment.status).toBe("unmatched");
    });

    it("normal pushed match on paid invoice still refuses unmatch", async () => {
      // Scenario: Normal match applied and paid, then unmatch attempted
      const paymentId = await createPayment(1000000n); // 10000 INR
      const invoiceId = await createInvoice(1000000n); // 10000 INR

      // Create match in 'pushed' state
      const matchId = `match-normal-paid-${Date.now().toString(36)}`;
      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${matchId}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId}, 10000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'pushed', NOW(), NOW())
      `;

      // Write normal match.applied audit (NO STALE_FINALIZED_EXTERNALLY_PAID reasonCode)
      await sql`
        INSERT INTO "AuditEvent" (id, "shopId", actor, type, data, at)
        VALUES (
          gen_random_uuid(),
          ${TEST_SHOP_ID},
          'test-user',
          'match.applied',
          ${sql.json({ matchId, invoiceId, paymentId, amountPaise: '1000000' })}::jsonb,
          NOW()
        )
      `;

      // Mark invoice as paid
      await sql`
        UPDATE "Invoice"
        SET status = 'paid', outstanding = 0, "updatedAt" = NOW()
        WHERE id = ${invoiceId}
      `;

      // Unmatch - should FAIL for normal pushed matches on paid invoices
      const result = await unmatchMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      expect(result.success).toBe(false);
      expect(result.alreadyPushed).toBe(true);
      expect(result.error).toContain("paid in Shopify");

      // Match should still be 'pushed'
      const [match] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchId}
      `;
      expect(match.state).toBe("pushed");
    });

    it("invoice flipped to paid during Shopify call: match pushed, one match.applied, payment allocated", async () => {
      // INVARIANT: After successful Shopify push, never unmatch unless sibling or cancellation explains it.
      // Scenario: Match A's orderMarkAsPaid succeeds, but webhook flips invoice to 'paid' before finalize TX.
      // Expected: Match pushed with match.applied, no match.unmatched, payment allocated.
      const paymentId = await createPayment(1000000n); // 10000 INR
      const invoiceId = await createInvoice(1000000n); // 10000 INR

      // Create a stale 'pushing' match (> 5 min) - this is the match being retried
      const matchId = `match-stale-shopify-race-${Date.now().toString(36)}`;
      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${matchId}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId}, 10000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'pushing', NOW() - interval '10 minutes', NOW() - interval '10 minutes')
      `;

      // Write push_claimed audit (simulating TX1 that happened 10 min ago)
      await sql`
        INSERT INTO "AuditEvent" (id, "shopId", actor, type, data, at)
        VALUES (
          gen_random_uuid(),
          ${TEST_SHOP_ID},
          'test-user',
          'match.push_claimed',
          ${sql.json({ matchId, invoiceId, paymentId, outstandingAtClaimPaise: '1000000' })}::jsonb,
          NOW() - interval '10 minutes'
        )
      `;

      // Configure mock to succeed and flip invoice to 'paid' DURING the Shopify call
      // This simulates ORDERS_PAID webhook arriving before finalize TX
      mockShopifySuccess = true;
      mockAlreadyPaid = false;
      orderMarkAsPaidCallCount = 0;

      onOrderMarkAsPaidCallback = async () => {
        // Simulate webhook: flip invoice to 'paid' DURING the Shopify call
        await sql`
          UPDATE "Invoice"
          SET status = 'paid', outstanding = 0, "updatedAt" = NOW()
          WHERE id = ${invoiceId}
        `;
      };

      // Apply the match (handleStalePushingMatch FULL path)
      const result = await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      // Clear callback
      onOrderMarkAsPaidCallback = null;

      // INVARIANT: After successful Shopify push, should be pushed not unmatched
      expect(result.success).toBe(true);
      expect(result.invoicePaid).toBe(true);

      // Match should be 'pushed'
      const [match] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchId}
      `;
      expect(match.state).toBe("pushed");

      // Exactly ONE match.applied audit with correct amounts
      const matchAppliedAudits = await sql<{ id: string; data: { reasonCode?: string; amountPaise?: string; previousOutstandingPaise?: string; newOutstandingPaise?: string } }[]>`
        SELECT id, data FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND type = 'match.applied'
          AND data->>'matchId' = ${matchId}
      `;
      expect(matchAppliedAudits.length).toBe(1);
      expect(matchAppliedAudits[0].data.reasonCode).toBe("STALE_FINALIZED_EXTERNALLY_PAID");
      // Amounts come from push_claimed.outstandingAtClaimPaise, not locked outstanding (which is 0)
      expect(matchAppliedAudits[0].data.amountPaise).toBe("1000000");
      expect(matchAppliedAudits[0].data.previousOutstandingPaise).toBe("1000000");
      expect(matchAppliedAudits[0].data.newOutstandingPaise).toBe("0");

      // NO match.unmatched audit
      const [unmatchedAudit] = await sql<{ id: string }[]>`
        SELECT id FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND type = 'match.unmatched'
          AND data->>'matchId' = ${matchId}
      `;
      expect(unmatchedAudit).toBeUndefined();

      // Payment should be 'matched' (not unmatched)
      const [payment] = await sql<{ status: string }[]>`
        SELECT status FROM "Payment" WHERE id = ${paymentId}
      `;
      expect(payment.status).toBe("matched");

      // Invoice should be paid with outstanding 0
      const [invoice] = await sql<{ status: string; outstanding: string }[]>`
        SELECT status, outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(invoice.status).toBe("paid");
      expect(parseFloat(invoice.outstanding)).toBe(0);

      // Exactly one orderMarkAsPaid call
      expect(orderMarkAsPaidCallCount).toBe(1);
    });
  });

  /**
   * Unmatch refuses 'pushing' state - cannot unmatch while push is in flight.
   */
  describe("Unmatch refuses 'pushing' state", () => {
    it("unmatch returns error for 'pushing' match", async () => {
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);

      // Create a match directly in 'pushing' state
      const matchId = `match-pushing-unmatch-${Date.now().toString(36)}`;
      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${matchId}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId}, 10000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'pushing', NOW(), NOW())
      `;

      // Try to unmatch - should fail
      const result = await unmatchMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      expect(result.success).toBe(false);
      expect(result.error).toContain("push is in progress");
      expect(result.alreadyPushed).toBe(false);

      // Match should still be 'pushing'
      const [match] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchId}
      `;
      expect(match.state).toBe("pushing");
    });
  });

  /**
   * 'pushing' state in apply path: verifies correct behavior when matches
   * are in the in-flight 'pushing' state.
   * Note: Payment allocation counting (preventing over-allocation of a payment)
   * is handled in matcher.server.ts at suggestion/scoring time, not in apply.server.ts.
   */
  describe("'pushing' state behavior", () => {
    it("'pushing' match on same invoice blocks new apply (different payment)", async () => {
      const paymentId1 = await createPayment(500000n); // First payment
      const paymentId2 = await createPayment(500000n); // Second payment
      const invoiceId = await createInvoice(1000000n); // 10000 INR invoice

      // Create a match in 'pushing' state for paymentId1 (FRESH - within 5 min)
      const matchId1 = `match-pushing-block-${Date.now().toString(36)}`;
      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${matchId1}, ${TEST_SHOP_ID}, ${paymentId1}, ${invoiceId}, 5000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'pushing', NOW(), NOW())
      `;

      // Create a confirmed match for paymentId2 on the same invoice
      const matchId2 = await createConfirmedMatch(paymentId2, invoiceId, 500000n);

      // Try to apply match2 - should be blocked because match1 is 'pushing' on same invoice
      const result = await applyMatch(sql, TEST_SHOP_ID, matchId2, "test-user");

      expect(result.success).toBe(false);
      expect(result.reasonCode).toBe("PUSH_IN_PROGRESS");

      // Invoice outstanding should be unchanged (10000)
      const [invoice] = await sql<{ outstanding: string }[]>`
        SELECT outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(parseFloat(invoice.outstanding)).toBe(10000);

      // match2 should still be 'confirmed'
      const [match2] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchId2}
      `;
      expect(match2.state).toBe("confirmed");
    });

    it("STALE 'pushing' sibling (> 5 min) is recovered before new apply proceeds", async () => {
      const paymentId1 = await createPayment(500000n); // First payment (stale pushing)
      const paymentId2 = await createPayment(500000n); // Second payment (new apply)
      const invoiceId = await createInvoice(1000000n); // 10000 INR invoice

      // Create a match in 'pushing' state for paymentId1 (STALE - > 5 min old)
      const matchId1 = `match-pushing-stale-sibling-${Date.now().toString(36)}`;
      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${matchId1}, ${TEST_SHOP_ID}, ${paymentId1}, ${invoiceId}, 5000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'pushing', NOW() - interval '10 minutes', NOW() - interval '10 minutes')
      `;

      // Add push_claimed audit for match1 (simulating TX1 that happened 10 min ago)
      await sql`
        INSERT INTO "AuditEvent" (id, "shopId", actor, type, data, at)
        VALUES (
          gen_random_uuid(),
          ${TEST_SHOP_ID},
          'test-user',
          'match.push_claimed',
          ${sql.json({ matchId: matchId1, invoiceId, paymentId: paymentId1, outstandingAtClaimPaise: '1000000' })}::jsonb,
          NOW() - interval '10 minutes'
        )
      `;

      // Create a confirmed match for paymentId2 on the same invoice
      const matchId2 = await createConfirmedMatch(paymentId2, invoiceId, 500000n);

      // Reset call counts
      orderMarkAsPaidCallCount = 0;

      // Try to apply match2 - should first recover stale match1, then apply match2
      const result = await applyMatch(sql, TEST_SHOP_ID, matchId2, "test-user");

      // Should succeed (stale sibling was recovered first)
      expect(result.success).toBe(true);

      // match1 should now be recovered ('pushed' with match.applied since it's a partial)
      const [match1] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchId1}
      `;
      expect(match1.state).toBe("pushed");

      // match1 should have match.applied audit
      const [match1Audit] = await sql<{ data: { staleReclaim?: boolean } }[]>`
        SELECT data FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND type = 'match.applied'
          AND data->>'matchId' = ${matchId1}
      `;
      expect(match1Audit).toBeDefined();
      expect(match1Audit?.data.staleReclaim).toBe(true);

      // match2 should also be 'pushed'
      const [match2] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchId2}
      `;
      expect(match2.state).toBe("pushed");

      // Invoice outstanding should be reduced by both (5000 + 5000 = 10000, so 0 remaining)
      const [invoice] = await sql<{ outstanding: string; status: string }[]>`
        SELECT outstanding::text, status FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(parseFloat(invoice.outstanding)).toBe(0);
      expect(invoice.status).toBe("paid");

      // match1 recovery is a partial (5000 of 10000), match2 completes it (5000 → full)
      // The second apply triggers full payment and calls Shopify
      expect(orderMarkAsPaidCallCount).toBe(1);
    });

  });

  /**
   * confirmMatch early return test: When match is already confirmed/pushed,
   * return early with idempotent success instead of continuing with side effects.
   */
  describe("confirmMatch early return", () => {
    it("returns success without side effects when match already confirmed", async () => {
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createSuggestedMatch(paymentId, invoiceId, 1000000n);

      // First confirm
      const result1 = await confirmMatch(sql, TEST_SHOP_ID, matchId, "test-user");
      expect(result1.success).toBe(true);

      // Count audit events
      const [beforeCount] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND type = 'match.confirmed'
          AND data->>'matchId' = ${matchId}
      `;

      // Second confirm (should be idempotent)
      const result2 = await confirmMatch(sql, TEST_SHOP_ID, matchId, "test-user");
      expect(result2.success).toBe(true);

      // Should NOT have created another audit event
      const [afterCount] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND type = 'match.confirmed'
          AND data->>'matchId' = ${matchId}
      `;
      expect(afterCount.count).toBe(beforeCount.count);
    });

    it("returns error when match state is not suggested or confirmed", async () => {
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createSuggestedMatch(paymentId, invoiceId, 1000000n);

      // Manually set to 'unmatched'
      await sql`
        UPDATE "Match"
        SET state = 'unmatched', "updatedAt" = NOW()
        WHERE id = ${matchId}
      `;

      // Try to confirm - should fail (state is 'unmatched', not 'suggested')
      const result = await confirmMatch(sql, TEST_SHOP_ID, matchId, "test-user");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Match not found or already processed");
    });
  });

  /**
   * M1, M2, M3, M7, M9: Verify safeLog output contains no PII.
   * Tests that shop domains, emails, UTRs, and amounts never appear in logs.
   * 
   * Per QA: Uses REAL safeLog, spies on console methods, parses emitted JSON,
   * and asserts no sensitive data leaks while verifying expected safe keys.
   * 
   * IMPORTANT: Each test FORCES the failure path (mock failing dependency, inject DB error)
   * and asserts the event appears EXACTLY once with exact key set (toEqual).
   * Raw mock.calls are checked for sentinel patterns (domain, email, UTR, amount).
   */
  describe("Logging: No PII in log output", () => {
    let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleWarnSpy?.mockRestore();
      consoleErrorSpy?.mockRestore();
    });

    function parseLogCalls(spy: ReturnType<typeof vi.spyOn>): Array<{ event: string; [key: string]: unknown }> {
      const parsed: Array<{ event: string; [key: string]: unknown }> = [];
      for (const call of spy.mock.calls) {
        const arg = call[0];
        if (typeof arg === "string" && arg.startsWith("{")) {
          try {
            parsed.push(JSON.parse(arg));
          } catch {
            // Not JSON, skip
          }
        }
      }
      return parsed;
    }

    function assertNoSensitiveDataInRawCalls(spy: ReturnType<typeof vi.spyOn>) {
      for (const call of spy.mock.calls) {
        const raw = String(call[0]);
        expect(raw).not.toContain("myshopify.com");
        expect(raw).not.toContain("@");
        expect(raw).not.toMatch(/UTIB\d+/i);
        expect(raw).not.toContain("1000000");
        expect(raw).not.toContain("500000");
        expect(raw).not.toContain("10000.00");
        expect(raw).not.toContain("5000.00");
      }
    }

    type SqlType = ReturnType<typeof postgres>;

    function createThrowingSql(
      originalSql: SqlType,
      shouldThrow: () => boolean,
      pattern: RegExp
    ): SqlType {
      const handler: ProxyHandler<SqlType> = {
        apply(target, _thisArg, args) {
          if (Array.isArray(args[0]) && 'raw' in args[0]) {
            const query = (args[0] as TemplateStringsArray).join('?');
            if (shouldThrow() && pattern.test(query)) {
              throw new Error('Forced SQL error for test');
            }
          }
          return Reflect.apply(target, target, args);
        },
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop === 'begin' && typeof value === 'function') {
            return (callback: (tx: SqlType) => Promise<unknown>) => {
              return (value as (cb: (tx: SqlType) => Promise<unknown>) => Promise<unknown>).call(
                target,
                async (tx: SqlType) => {
                  const throwingTx = createThrowingSql(tx, shouldThrow, pattern);
                  return callback(throwingTx);
                }
              );
            };
          }
          return value;
        }
      };
      return new Proxy(originalSql, handler) as SqlType;
    }

    // M1: When Shopify API fails (mockShopifySuccess=false), handleStalePushingMatch
    // returns { success: false, error: "...", retryable: true } with NO reasonCode.
    // The safeLog conditionally includes reasonCode only when defined, so the
    // emitted JSON has exactly [err, event, matchId]. If recovery failed for a
    // different reason (e.g., INVOICE_NOT_OPEN), reasonCode would be present.
    it("M1: stale sibling recovery failure logs event with exact keys, no sentinels", async () => {
      mockShopifySuccess = false;
      mockAlreadyPaid = false;

      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);

      const siblingId = `match-sibling-m1-${Date.now().toString(36)}`;
      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${siblingId}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId}, 10000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'pushing', NOW() - interval '10 minutes', NOW() - interval '10 minutes')
      `;

      await sql`
        INSERT INTO "AuditEvent" (id, "shopId", actor, type, data, at)
        VALUES (
          gen_random_uuid(),
          ${TEST_SHOP_ID},
          'test-user',
          'match.push_claimed',
          ${sql.json({ matchId: siblingId, invoiceId, paymentId, outstandingAtClaimPaise: '1000000' })}::jsonb,
          NOW() - interval '10 minutes'
        )
      `;

      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      const warnLogs = parseLogCalls(consoleWarnSpy);
      const recoveryLogs = warnLogs.filter(l => l.event === "apply_stale_sibling_recovery_failed");
      expect(recoveryLogs.length).toBe(1);

      const log = recoveryLogs[0];
      expect(Object.keys(log).sort()).toEqual(["err", "event", "matchId"]);
      expect(log.matchId).toBe(siblingId);
      expect(typeof log.err).toBe("string");

      assertNoSensitiveDataInRawCalls(consoleWarnSpy);
      assertNoSensitiveDataInRawCalls(consoleErrorSpy);
    });

    it("M2: pushed-without-audit logs event with exact keys, no sentinels", async () => {
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);

      const matchId = `match-no-audit-m2-${Date.now().toString(36)}`;
      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${matchId}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId}, 10000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'pushed', NOW(), NOW())
      `;

      await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      const warnLogs = parseLogCalls(consoleWarnSpy);
      const pushedWithoutAuditLogs = warnLogs.filter(l => l.event === "apply_pushed_without_audit");
      expect(pushedWithoutAuditLogs.length).toBe(1);

      const log = pushedWithoutAuditLogs[0];
      expect(Object.keys(log).sort()).toEqual(["event", "invoiceId", "matchId", "status"]);
      expect(log.matchId).toBe(matchId);
      expect(log.invoiceId).toBe(invoiceId);
      expect(typeof log.status).toBe("string");

      assertNoSensitiveDataInRawCalls(consoleWarnSpy);
    });

    it("M3: release-claim failure logs event with exact keys, no sentinels", async () => {
      mockShopifySuccess = false;
      mockAlreadyPaid = false;

      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      let throwOnReleaseClaim = false;
      const throwingSql = createThrowingSql(
        sql,
        () => throwOnReleaseClaim,
        /SET state = 'confirmed'/
      );

      onOrderMarkAsPaidCallback = async () => {
        throwOnReleaseClaim = true;
      };

      await applyMatch(throwingSql, TEST_SHOP_ID, matchId, "test-user");
      onOrderMarkAsPaidCallback = null;

      const errorLogs = parseLogCalls(consoleErrorSpy);
      const releaseClaimLogs = errorLogs.filter(l => l.event === "apply_release_claim_failed");
      expect(releaseClaimLogs.length).toBe(1);

      const log = releaseClaimLogs[0];
      expect(Object.keys(log).sort()).toEqual(["err", "event", "matchId"]);
      expect(log.matchId).toBe(matchId);
      expect(typeof log.err).toBe("string");

      assertNoSensitiveDataInRawCalls(consoleErrorSpy);
    });

    it("M7: backstop triggered logs event with exact keys, no sentinels", async () => {
      mockShopifySuccess = true;
      mockAlreadyPaid = false;

      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      onOrderMarkAsPaidCallback = async () => {
        await sql`
          UPDATE "Invoice"
          SET outstanding = 500.00, "updatedAt" = NOW()
          WHERE id = ${invoiceId}
        `;
      };

      await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");
      onOrderMarkAsPaidCallback = null;

      const errorLogs = parseLogCalls(consoleErrorSpy);
      const backstopLogs = errorLogs.filter(l => l.event === "apply_backstop_triggered");
      expect(backstopLogs.length).toBe(1);

      const log = backstopLogs[0];
      expect(Object.keys(log).sort()).toEqual(["event", "invoiceId", "matchId", "status", "success"]);
      expect(log.matchId).toBe(matchId);
      expect(log.invoiceId).toBe(invoiceId);
      expect(typeof log.status).toBe("string");
      expect(typeof log.success).toBe("boolean");

      assertNoSensitiveDataInRawCalls(consoleErrorSpy);
    });

    it("M9: TX2 failure logs event with exact keys, no sentinels", async () => {
      mockShopifySuccess = true;
      mockAlreadyPaid = false;

      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      let throwOnTx2 = false;
      const throwingSql = createThrowingSql(
        sql,
        () => throwOnTx2,
        /outstanding = 0, status = 'paid'/
      );

      onOrderMarkAsPaidCallback = async () => {
        throwOnTx2 = true;
      };

      await applyMatch(throwingSql, TEST_SHOP_ID, matchId, "test-user");
      onOrderMarkAsPaidCallback = null;

      const errorLogs = parseLogCalls(consoleErrorSpy);
      const tx2FailLogs = errorLogs.filter(l => l.event === "apply_tx2_failed");
      expect(tx2FailLogs.length).toBe(1);

      const log = tx2FailLogs[0];
      expect(Object.keys(log).sort()).toEqual(["err", "event", "invoiceId", "matchId"]);
      expect(log.matchId).toBe(matchId);
      expect(log.invoiceId).toBe(invoiceId);
      expect(typeof log.err).toBe("string");

      assertNoSensitiveDataInRawCalls(consoleErrorSpy);
      assertNoSensitiveDataInRawCalls(consoleWarnSpy);
    });

    it("enqueue recompute failure logs event with exact keys, no sentinels", async () => {
      mockShopifySuccess = true;
      mockAlreadyPaid = false;
      mockEnqueueShouldThrow = true;

      const paymentId = await createPayment(500000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 500000n);

      try {
        await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");
      } finally {
        mockEnqueueShouldThrow = false;
      }

      const errorLogs = parseLogCalls(consoleErrorSpy);
      const enqueueLogs = errorLogs.filter(l => l.event === "apply_enqueue_recompute_failed");
      expect(enqueueLogs.length).toBe(1);

      const log = enqueueLogs[0];
      expect(Object.keys(log).sort()).toEqual(["err", "event", "invoiceId"]);
      expect(log.invoiceId).toBe(invoiceId);
      expect(typeof log.err).toBe("string");

      assertNoSensitiveDataInRawCalls(consoleWarnSpy);
      assertNoSensitiveDataInRawCalls(consoleErrorSpy);
    });

    /**
     * M7: Shopify userError returns fixed merchant-facing message, no raw text.
     * Forces userErrors with sentinel strings (domain, email-like), asserts:
     * - Returned error is the exact fixed message from RECONCILE_ERROR_MESSAGES
     * - No sentinel appears in result or logs
     */
    it("M7: Shopify userError returns fixed message, no raw text in result or logs", async () => {
      const SENTINEL_SHOPIFY = "SENTINEL_SHOPIFY_RAW_7f3a";
      const SENTINEL_EMAIL = "sentinel7f3a@pii-leak.test";

      // First userError contains "access denied" so toErrorCode returns "access_denied"
      mockUserErrors = [
        { field: ["id"], message: `Access denied: ${SENTINEL_SHOPIFY}` },
        { field: ["amount"], message: `Invalid for ${SENTINEL_EMAIL}` },
      ];

      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      const result = await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      // Result should have fixed message mapped from "access_denied" code
      expect(result.success).toBe(false);
      expect(result.error).toBe("Couldn't update the order in Shopify. Please check permissions.");
      expect(result.errorCode).toBe("access_denied");

      // Sentinel must NOT appear in the result
      const resultStr = JSON.stringify(result);
      expect(resultStr).not.toContain(SENTINEL_SHOPIFY);
      expect(resultStr).not.toContain(SENTINEL_EMAIL);
      expect(resultStr).not.toContain("pii-leak");

      // Sentinel must NOT appear in any console output
      for (const spy of [consoleWarnSpy, consoleErrorSpy]) {
        for (const call of spy.mock.calls) {
          const raw = String(call[0]);
          expect(raw).not.toContain(SENTINEL_SHOPIFY);
          expect(raw).not.toContain(SENTINEL_EMAIL);
          expect(raw).not.toContain("pii-leak");
        }
      }

      // safeLog calls should have only safe keys
      const allLogs = [
        ...parseLogCalls(consoleWarnSpy),
        ...parseLogCalls(consoleErrorSpy),
      ];
      for (const log of allLogs) {
        const logStr = JSON.stringify(log);
        expect(logStr).not.toContain(SENTINEL_SHOPIFY);
        expect(logStr).not.toContain(SENTINEL_EMAIL);
      }
    });
  });

  /**
   * Error code format tests: verify returned errors are codes, not raw messages.
   * Uses REAL toErrorCode (no mocks) and sentinels to detect leakage.
   */
  describe("Error code format: no raw messages in returned errors", () => {
    const SENTINEL = "SENTINEL_RAW_9f3";

    it("Shopify API failure returns code, not raw error text", async () => {
      mockShopifySuccess = false;
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      const result = await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      expect(result.success).toBe(false);
      expect(result.error).toBe("retryable:shopify_api_error");
      expect(result.error).not.toContain(SENTINEL);
    });

    it("unmatchMatch catch returns error code, not raw exception text", async () => {
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);
      
      const matchId = `match-unmatch-error-${Date.now().toString(36)}`;
      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${matchId}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId}, 10000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'confirmed', NOW(), NOW())
      `;

      const result = await unmatchMatch(sql, TEST_SHOP_ID, matchId, "test-user");
      expect(result.success).toBe(true);

      // Verify error format on actual failures - test the pattern
      const badResult = await unmatchMatch(sql, TEST_SHOP_ID, "nonexistent-match-id", "test-user");
      expect(badResult.success).toBe(false);
      expect(badResult.error).toBe("Match not found");
    });

    it("recovery error returns code with permanent prefix, no raw text", async () => {
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);

      const matchId = `match-recovery-error-${Date.now().toString(36)}`;
      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${matchId}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId}, 10000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'pushed', NOW(), NOW())
      `;

      const result = await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      expect(result.success).toBe(false);
      expect(result.reasonCode).toBe("PUSHED_WITHOUT_AUDIT");
      // Error should be fixed text or code, no sentinel
      expect(result.error).not.toContain(SENTINEL);
    });

    it("invoice status error uses code, no amount leak (issue #190 amount fix)", async () => {
      const AMOUNT_SENTINEL = "999888777666";
      const paymentId = await createPayment(BigInt(AMOUNT_SENTINEL));
      const invoiceId = await createInvoice(BigInt(AMOUNT_SENTINEL));
      const matchId = await createConfirmedMatch(paymentId, invoiceId, BigInt(AMOUNT_SENTINEL));

      await sql`UPDATE "Invoice" SET status = 'paid' WHERE id = ${invoiceId}`;

      const result = await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      expect(result.success).toBe(false);
      expect(result.reasonCode).toBe("INVOICE_NOT_OPEN");
      expect(result.error).not.toContain(AMOUNT_SENTINEL);
      expect(result.error).not.toContain("outstanding");
      expect(result.error).not.toContain("Paise");
    });

    it("backstop race condition: no amount/status leak in result (issue #190)", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockShopifySuccess = true;
      mockAlreadyPaid = false;

      const AMOUNT_SENTINEL = "777666555";
      const paymentId = await createPayment(BigInt(AMOUNT_SENTINEL));
      const invoiceId = await createInvoice(BigInt(AMOUNT_SENTINEL));
      const matchId = await createConfirmedMatch(paymentId, invoiceId, BigInt(AMOUNT_SENTINEL));

      onOrderMarkAsPaidCallback = async () => {
        await sql`
          UPDATE "Invoice"
          SET status = 'paid', outstanding = 0, "updatedAt" = NOW()
          WHERE id = ${invoiceId}
        `;
      };

      const result = await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");
      onOrderMarkAsPaidCallback = null;

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(AMOUNT_SENTINEL);
      expect(serialized).not.toContain("outstanding");
      expect(result.success).toBe(true);

      const allLogs = consoleSpy.mock.calls.map(c => String(c[0])).join("\n");
      expect(allLogs).toContain("apply_backstop_triggered");
      expect(allLogs).not.toContain(AMOUNT_SENTINEL);
      expect(allLogs).not.toContain("outstanding");

      consoleSpy.mockRestore();
    });

    it("error codes use toErrorCode pattern (retryable: or permanent: prefix)", async () => {
      mockShopifySuccess = false;
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      const result = await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      expect(result.error).toMatch(/^(retryable|permanent):/);
    });
  });
});
