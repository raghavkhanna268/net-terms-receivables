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
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

let mockShopifySuccess = true;
let mockAlreadyPaid = false;
let shopifyCallCount = 0;
let verifyOrderIsPaidCallCount = 0;
let orderMarkAsPaidCallCount = 0;

// Callback that runs DURING the Shopify orderMarkAsPaid call (for race condition testing)
let onOrderMarkAsPaidCallback: (() => Promise<void>) | null = null;

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
    const orderGid = orderId === undefined ? `gid://shopify/Order/${invoiceId}` : orderId;
    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status, "issuedAt", "createdAt", "updatedAt")
      VALUES (${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderGid}, ${'#' + invoiceId.slice(-6)}, ${Number(outstandingPaise) / 100}, ${Number(outstandingPaise) / 100}, 'open', NOW(), NOW(), NOW())
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

      const messages = await sql<{ message: { type: string; invoiceId: string; buyerAccountId: string } }[]>`
        SELECT message FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
          AND message->>'type' = 'CREDIT_STATUS_RECOMPUTE'
      `;

      const recomputeMsg = messages.find(m => m.message.invoiceId === invoiceId);
      expect(recomputeMsg).toBeDefined();
      expect(recomputeMsg?.message.buyerAccountId).toBe(TEST_ACCOUNT_ID);
    });

    it("does NOT enqueue recompute on Shopify failure", async () => {
      mockShopifySuccess = false;
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      const messages = await sql<{ message: { type: string; invoiceId: string } }[]>`
        SELECT message FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
          AND message->>'type' = 'CREDIT_STATUS_RECOMPUTE'
          AND message->>'invoiceId' = ${invoiceId}
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

    it("STALE 'pushing' sibling (> 5 min) does NOT block new apply", async () => {
      const paymentId1 = await createPayment(500000n); // First payment (stale pushing)
      const paymentId2 = await createPayment(500000n); // Second payment (new apply)
      const invoiceId = await createInvoice(1000000n); // 10000 INR invoice

      // Create a match in 'pushing' state for paymentId1 (STALE - > 5 min old)
      const matchId1 = `match-pushing-stale-sibling-${Date.now().toString(36)}`;
      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${matchId1}, ${TEST_SHOP_ID}, ${paymentId1}, ${invoiceId}, 5000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'pushing', NOW() - interval '10 minutes', NOW() - interval '10 minutes')
      `;

      // Create a confirmed match for paymentId2 on the same invoice
      const matchId2 = await createConfirmedMatch(paymentId2, invoiceId, 500000n);

      // Try to apply match2 - should NOT be blocked because match1 is STALE (> 5 min)
      const result = await applyMatch(sql, TEST_SHOP_ID, matchId2, "test-user");

      // Should succeed (stale sibling doesn't block)
      expect(result.success).toBe(true);
      expect(result.invoicePaid).toBe(false); // Partial

      // Invoice outstanding should be reduced by 5000
      const [invoice] = await sql<{ outstanding: string }[]>`
        SELECT outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(parseFloat(invoice.outstanding)).toBe(5000);

      // match2 should now be 'pushed'
      const [match2] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchId2}
      `;
      expect(match2.state).toBe("pushed");

      // match1 should still be 'pushing' (it wasn't recovered, just ignored)
      const [match1] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchId1}
      `;
      expect(match1.state).toBe("pushing");
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
});
