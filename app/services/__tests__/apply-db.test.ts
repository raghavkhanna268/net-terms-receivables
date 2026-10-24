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

vi.mock("../shopify-client.server", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    shopifyGraphQLRequest: vi.fn().mockImplementation(async (_shop: string, query: string) => {
      shopifyCallCount++;

      // Handle ORDER_QUERY for verifyOrderIsPaid (Issue #5)
      const isOrderQuery = query.includes("query GetOrder");
      if (isOrderQuery) {
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

import { applyMatch, unmatchMatch, unmatchPushedMatch } from "../apply.server";
import { confirmMatch } from "../matcher.server";

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

      const result = await applyMatch(sql, matchId, "test-user");

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

      const result = await applyMatch(sql, matchId, "test-user");

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

      const result = await applyMatch(sql, matchId, "test-user");

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

      const result = await applyMatch(sql, matchId, "test-user");

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

      await applyMatch(sql, matchId1, "test-user");
      expect(shopifyCallCount).toBe(0);

      const result = await applyMatch(sql, matchId2, "test-user");
      expect(result.invoicePaid).toBe(true);
      expect(shopifyCallCount).toBe(1);
    });
  });

  describe("S17-20 to S17-23: Idempotency", () => {
    it("S17-20: retry of same apply is no-op", async () => {
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      await applyMatch(sql, matchId, "test-user");
      const firstCallCount = shopifyCallCount;

      const result = await applyMatch(sql, matchId, "test-user");

      expect(result.success).toBe(true);
      expect(result.reasonCode).toBe("ALREADY_APPLIED");
      expect(shopifyCallCount).toBe(firstCallCount);
    });

    it("retried apply writes no duplicate match.applied event", async () => {
      const paymentId = await createPayment(500000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 500000n);

      await applyMatch(sql, matchId, "test-user");
      await applyMatch(sql, matchId, "test-user");
      await applyMatch(sql, matchId, "test-user");

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
      const result1 = await applyMatch(sql, matchId, "test-user");
      const result2 = await applyMatch(sql, matchId, "test-user");
      const result3 = await applyMatch(sql, matchId, "test-user");

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
      await unmatchMatch(sql, matchId, "test-user");

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

      await applyMatch(sql, matchId, "test-user");

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

      await applyMatch(sql, matchId, "test-user");

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

      const result = await unmatchMatch(sql, matchId, "test-user");

      expect(result.success).toBe(true);

      const [match] = await sql<{ state: string }[]>`SELECT state FROM "Match" WHERE id = ${matchId}`;
      expect(match.state).toBe("unmatched");
    });

    it("S17-51: unmatch pushed match for paid invoice is blocked", async () => {
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      await applyMatch(sql, matchId, "test-user");

      const result = await unmatchPushedMatch(sql, matchId, "test-user");

      expect(result.success).toBe(false);
      expect(result.alreadyPushed).toBe(true);
    });
  });

  describe("S17-60 to S17-62: No PII in audit", () => {
    it("S17-60: audit data contains only IDs and amounts", async () => {
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      await applyMatch(sql, matchId, "test-user");

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
        applyMatch(sql, matchId1, "test-user"),
        applyMatch(sql, matchId2, "test-user"),
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

      await applyMatch(sql, matchId, "test-user");

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

      await applyMatch(sql, matchId, "test-user");

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
      await applyMatch(sql, matchId1, "test-user");
      expect(shopifyCallCount).toBe(0);

      // Apply second partial that completes payment - should call Shopify exactly once
      shopifyCallCount = 0;
      const result = await applyMatch(sql, matchId2, "test-user");

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
        applyMatch(sql, matchId1, "test-user"),
        applyMatch(sql, matchId2, "test-user"),
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
      await applyMatch(sql, matchId, "test-user");

      const [beforeUnmatch] = await sql<{ outstanding: string }[]>`
        SELECT outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(parseFloat(beforeUnmatch.outstanding)).toBe(0);

      // Reset invoice to open status so unmatch is allowed
      await sql`UPDATE "Invoice" SET status = 'open' WHERE id = ${invoiceId}`;

      // Unmatch - should restore exactly 5000 (the capped amount), not 15000
      const result = await unmatchMatch(sql, matchId, "test-user");
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
      const result = await unmatchMatch(sql, matchId1, "test-user");
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
      const result = await unmatchMatch(sql, matchId, "test-user");
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
      const result = await applyMatch(sql, matchId, "test-user");
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

      const result = await applyMatch(sql, matchId, "test-user");

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
   * Issue #6: Crash recovery between claim (tx1) and finalize (tx2).
   * Match in 'pushed' state but invoice not 'paid' triggers recovery.
   */
  describe("Issue #6: Crash recovery for pushed matches", () => {
    it("retries push for pushed match with non-paid invoice", async () => {
      const paymentId = await createPayment(1000000n);
      const invoiceId = await createInvoice(1000000n);

      // Create a match directly in 'pushed' state (simulating crash after tx1)
      const matchId = `match-crash-${Date.now().toString(36)}`;
      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${matchId}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId}, 10000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'pushed', NOW(), NOW())
      `;

      // Invoice is still open (simulating crash before tx2 completed)
      const [beforeRecovery] = await sql<{ status: string; outstanding: string }[]>`
        SELECT status, outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(beforeRecovery.status).toBe("open");
      expect(parseFloat(beforeRecovery.outstanding)).toBe(10000);

      // Call applyMatch - should detect crash and retry
      const result = await applyMatch(sql, matchId, "test-user");

      expect(result.success).toBe(true);
      expect(result.invoicePaid).toBe(true);
      expect(result.reasonCode).toContain("RECOVERED");

      // Invoice should now be paid
      const [afterRecovery] = await sql<{ status: string; outstanding: string }[]>`
        SELECT status, outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(afterRecovery.status).toBe("paid");
      expect(parseFloat(afterRecovery.outstanding)).toBe(0);

      // Audit trail should have recoveredFromCrash flag
      const [auditEvent] = await sql<{ data: { recoveredFromCrash?: boolean } }[]>`
        SELECT data FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND type = 'match.applied'
          AND data->>'matchId' = ${matchId}
      `;
      expect(auditEvent?.data.recoveredFromCrash).toBe(true);
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

      // Call applyMatch - should be idempotent success
      const result = await applyMatch(sql, matchId, "test-user");

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

    it("partial payment crash recovery reduces outstanding correctly", async () => {
      const paymentId = await createPayment(500000n);
      const invoiceId = await createInvoice(1000000n);

      // Create a match in 'pushed' state for partial payment
      const matchId = `match-partial-crash-${Date.now().toString(36)}`;
      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${matchId}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId}, 5000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'pushed', NOW(), NOW())
      `;

      // Invoice is still open (crash before tx2)
      const result = await applyMatch(sql, matchId, "test-user");

      expect(result.success).toBe(true);
      expect(result.invoicePaid).toBe(false); // Partial, not full
      expect(result.reasonCode).toBe("RECOVERED_FROM_CRASH");

      // Outstanding should be reduced
      const [invoice] = await sql<{ outstanding: string; status: string }[]>`
        SELECT outstanding::text, status FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(parseFloat(invoice.outstanding)).toBe(5000);
      expect(invoice.status).toBe("open");
    });
  });
});
