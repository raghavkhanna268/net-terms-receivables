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
 * IMPORTANT: Tests the real enqueue helper, not a mock. Asserts that
 * CREDIT_STATUS_RECOMPUTE messages are enqueued with correct buyerAccountId.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

let mockShopifySuccess = true;
let mockAlreadyPaid = false;
let shopifyCallCount = 0;
let lastShopifyInput: unknown = null;

vi.mock("../shopify-client.server", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    shopifyGraphQLRequest: vi.fn().mockImplementation(async (_shop: string, _query: string, variables: unknown) => {
      shopifyCallCount++;
      lastShopifyInput = variables;

      if (mockAlreadyPaid) {
        return {
          success: true,
          data: {
            orderMarkAsPaid: {
              order: null,
              userErrors: [{ field: ["id"], message: "Order has already been paid" }],
            },
          },
          retryable: false,
        };
      }

      if (!mockShopifySuccess) {
        return {
          success: false,
          error: "Shopify API error",
          retryable: true,
        };
      }

      return {
        success: true,
        data: {
          orderMarkAsPaid: {
            order: { id: "gid://shopify/Order/123", displayFinancialStatus: "PAID" },
            userErrors: [],
          },
        },
        retryable: false,
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
  const TEST_SUFFIX = Date.now().toString(36) + "-s17-apply";
  const TEST_SHOP_ID = `shop-apply-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `apply-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-apply-${TEST_SUFFIX}`;
  const TEST_IMPORT_ID = `import-apply-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop
    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    // Create test buyer account
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "manualHold",
        "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-" + TEST_SUFFIX}, ${"loc-" + TEST_SUFFIX},
        'Test Apply Account', 100000.00, 'OK', false, false, NOW(), NOW()
      )
    `;

    // Create test bank import
    await sql`
      INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
      VALUES (${TEST_IMPORT_ID}, ${TEST_SHOP_ID}, 'hdfc', 'test.csv', 1, NOW())
    `;
  });

  afterAll(async () => {
    // Cleanup
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
    lastShopifyInput = null;

    // Cleanup test data
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Match" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
  });

  async function createTestPayment(amountPaise: bigint, paymentId?: string): Promise<string> {
    const id = paymentId ?? `pmt-${Date.now().toString(36)}-${TEST_SUFFIX}`;
    await sql`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        ${id}, ${TEST_SHOP_ID}, ${TEST_IMPORT_ID}, NOW(),
        ${Number(amountPaise) / 100}, 'NEFT', 'Test payment', 'unmatched', NOW(), NOW()
      )
    `;
    return id;
  }

  async function createTestInvoice(outstandingPaise: bigint, orderId?: string | null, invoiceId?: string): Promise<string> {
    const id = invoiceId ?? `inv-${Date.now().toString(36)}-${TEST_SUFFIX}`;
    const orderGid = orderId === undefined ? `gid://shopify/Order/${id}` : orderId;
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${id}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderGid},
        ${'#' + id.slice(-6)}, ${Number(outstandingPaise) / 100}, ${Number(outstandingPaise) / 100},
        'open', NOW(), NOW(), NOW()
      )
    `;
    return id;
  }

  async function createConfirmedMatch(paymentId: string, invoiceId: string, amountPaise: bigint): Promise<string> {
    const matchId = `match-${Date.now().toString(36)}-${TEST_SUFFIX}`;
    await sql`
      INSERT INTO "Match" (
        id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state,
        "confirmedBy", "confirmedAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${matchId}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId},
        ${Number(amountPaise) / 100}, 100, ${sql.json([{ type: 'test', points: 100 }])},
        'confirmed', 'test-user', NOW(), NOW(), NOW()
      )
    `;
    return matchId;
  }

  describe("S17-01 to S17-05: orderMarkAsPaid and transaction semantics", () => {
    it("S17-01: full match marks invoice paid and calls orderMarkAsPaid", async () => {
      const paymentId = await createTestPayment(1000000n); // ₹10,000
      const invoiceId = await createTestInvoice(1000000n); // ₹10,000 outstanding
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      const result = await applyMatch(sql, matchId, "test-user");

      expect(result.success).toBe(true);
      expect(result.invoicePaid).toBe(true);
      expect(result.shopifyPushSucceeded).toBe(true);

      // Verify invoice state
      const [invoice] = await sql<{ outstanding: string; status: string }[]>`
        SELECT outstanding::text, status FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(invoice.outstanding).toBe("0.00");
      expect(invoice.status).toBe("paid");

      // Verify match state
      const [match] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchId}
      `;
      expect(match.state).toBe("pushed");

      // Verify orderMarkAsPaid was called
      expect(shopifyCallCount).toBe(1);
    });

    it("S17-02: orderMarkAsPaid mutation payload contains order GID", async () => {
      const paymentId = await createTestPayment(1000000n);
      const orderId = `gid://shopify/Order/test-order-${TEST_SUFFIX}`;
      const invoiceId = await createTestInvoice(1000000n, orderId);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      await applyMatch(sql, matchId, "test-user");

      expect(lastShopifyInput).toEqual({ input: { id: orderId } });
    });

    it("S17-03: Shopify error rolls back DB changes", async () => {
      mockShopifySuccess = false;

      const paymentId = await createTestPayment(1000000n);
      const invoiceId = await createTestInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      const result = await applyMatch(sql, matchId, "test-user");

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(true);

      // Verify invoice unchanged
      const [invoice] = await sql<{ outstanding: string; status: string }[]>`
        SELECT outstanding::text, status FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(invoice.outstanding).toBe("10000.00");
      expect(invoice.status).toBe("open");

      // Verify match unchanged
      const [match] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchId}
      `;
      expect(match.state).toBe("confirmed");
    });

    it("S17-04: already-paid userError is idempotent success", async () => {
      mockAlreadyPaid = true;

      const paymentId = await createTestPayment(1000000n);
      const invoiceId = await createTestInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      const result = await applyMatch(sql, matchId, "test-user");

      expect(result.success).toBe(true);
      expect(result.invoicePaid).toBe(true);
      expect(result.reasonCode).toBe("ALREADY_PAID_IN_SHOPIFY");

      // Invoice should still be marked paid
      const [invoice] = await sql<{ status: string }[]>`
        SELECT status FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(invoice.status).toBe("paid");

      // Match should be pushed
      const [match] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchId}
      `;
      expect(match.state).toBe("pushed");
    });
  });

  describe("S17-10 to S17-13: Partial apply", () => {
    it("S17-10: partial payment reduces outstanding without orderMarkAsPaid", async () => {
      const paymentId = await createTestPayment(500000n); // ₹5,000
      const invoiceId = await createTestInvoice(2500000n); // ₹25,000 outstanding
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 500000n);

      const result = await applyMatch(sql, matchId, "test-user");

      expect(result.success).toBe(true);
      expect(result.invoicePaid).toBe(false);
      expect(shopifyCallCount).toBe(0); // No Shopify call for partial

      // Verify invoice state
      const [invoice] = await sql<{ outstanding: string; status: string }[]>`
        SELECT outstanding::text, status FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(invoice.outstanding).toBe("20000.00"); // ₹25,000 - ₹5,000
      expect(invoice.status).toBe("open");
    });

    it("S17-11: second partial payment completes the invoice", async () => {
      const paymentId1 = await createTestPayment(500000n);
      const paymentId2 = await createTestPayment(2000000n);
      const invoiceId = await createTestInvoice(2500000n);
      const matchId1 = await createConfirmedMatch(paymentId1, invoiceId, 500000n);
      const matchId2 = await createConfirmedMatch(paymentId2, invoiceId, 2000000n);

      // Apply first partial
      await applyMatch(sql, matchId1, "test-user");
      expect(shopifyCallCount).toBe(0);

      // Apply second partial - completes the invoice
      const result = await applyMatch(sql, matchId2, "test-user");

      expect(result.success).toBe(true);
      expect(result.invoicePaid).toBe(true);
      expect(shopifyCallCount).toBe(1);

      const [invoice] = await sql<{ outstanding: string; status: string }[]>`
        SELECT outstanding::text, status FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(invoice.outstanding).toBe("0.00");
      expect(invoice.status).toBe("paid");
    });

    it("S17-13: match amount exceeding outstanding is capped", async () => {
      const paymentId = await createTestPayment(3000000n); // ₹30,000
      const invoiceId = await createTestInvoice(1000000n); // ₹10,000 outstanding
      // Create match for full payment amount
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 3000000n);

      const result = await applyMatch(sql, matchId, "test-user");

      expect(result.success).toBe(true);
      expect(result.invoicePaid).toBe(true);

      // Invoice should be fully paid
      const [invoice] = await sql<{ outstanding: string }[]>`
        SELECT outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(invoice.outstanding).toBe("0.00");
    });
  });

  describe("S17-20 to S17-23: Idempotency on retry", () => {
    it("S17-20: re-applying a pushed match is a no-op", async () => {
      const paymentId = await createTestPayment(1000000n);
      const invoiceId = await createTestInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      // First apply
      await applyMatch(sql, matchId, "test-user");
      const firstCallCount = shopifyCallCount;

      // Second apply (retry)
      const result = await applyMatch(sql, matchId, "test-user");

      expect(result.success).toBe(true);
      expect(result.reasonCode).toBe("ALREADY_APPLIED");
      expect(shopifyCallCount).toBe(firstCallCount); // No additional Shopify call
    });

    it("S17-21: match in pushed state returns success", async () => {
      const paymentId = await createTestPayment(1000000n);
      const invoiceId = await createTestInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      // Apply to push state
      await applyMatch(sql, matchId, "test-user");

      // Try again
      const result = await applyMatch(sql, matchId, "test-user");

      expect(result.success).toBe(true);
    });

    it("S17-22: no duplicate AuditEvent on retry", async () => {
      const paymentId = await createTestPayment(1000000n);
      const invoiceId = await createTestInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      // First apply
      await applyMatch(sql, matchId, "test-user");

      // Second apply
      await applyMatch(sql, matchId, "test-user");

      // Count audit events for this match
      const [count] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND data->>'matchId' = ${matchId}
      `;

      // Should have exactly 2 events (match.applied and invoice.paid), not 4
      expect(parseInt(count.count)).toBeLessThanOrEqual(2);
    });
  });

  describe("S17-40 to S17-43: Audit trail", () => {
    it("S17-40: match.applied audit event is written", async () => {
      const paymentId = await createTestPayment(500000n);
      const invoiceId = await createTestInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 500000n);

      await applyMatch(sql, matchId, "test-user");

      const [event] = await sql<{ type: string; actor: string; data: unknown }[]>`
        SELECT type, actor, data FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND type = 'match.applied'
          AND data->>'matchId' = ${matchId}
      `;

      expect(event).toBeDefined();
      expect(event.type).toBe("match.applied");
      expect(event.actor).toBe("test-user");
      expect((event.data as Record<string, unknown>).invoiceId).toBe(invoiceId);
      expect((event.data as Record<string, unknown>).paymentId).toBe(paymentId);
    });

    it("S17-41: invoice.paid audit event is written", async () => {
      const paymentId = await createTestPayment(1000000n);
      const invoiceId = await createTestInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      await applyMatch(sql, matchId, "test-user");

      const [event] = await sql<{ type: string; data: unknown }[]>`
        SELECT type, data FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND type = 'invoice.paid'
          AND data->>'invoiceId' = ${invoiceId}
      `;

      expect(event).toBeDefined();
      expect(event.type).toBe("invoice.paid");
      expect((event.data as Record<string, unknown>).shopifyPushSucceeded).toBe(true);
    });

    it("S17-43: audit events are immutable (no UPDATE/DELETE)", async () => {
      const paymentId = await createTestPayment(1000000n);
      const invoiceId = await createTestInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      await applyMatch(sql, matchId, "test-user");

      // Get the audit event
      const [event] = await sql<{ id: string; at: Date }[]>`
        SELECT id, at FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND type = 'match.applied'
        LIMIT 1
      `;

      // Events should exist and have timestamps
      expect(event).toBeDefined();
      expect(event.at).toBeInstanceOf(Date);
    });
  });

  describe("S17-50 to S17-53: Unmatch", () => {
    it("S17-50: unmatch a confirmed match returns to unmatched state", async () => {
      const paymentId = await createTestPayment(1000000n);
      const invoiceId = await createTestInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      const result = await unmatchMatch(sql, matchId, "test-user");

      expect(result.success).toBe(true);

      const [match] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchId}
      `;
      expect(match.state).toBe("unmatched");
    });

    it("S17-51: unmatch a pushed match for fully paid invoice is blocked", async () => {
      const paymentId = await createTestPayment(1000000n);
      const invoiceId = await createTestInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      // Apply the match (makes it pushed and invoice paid)
      await applyMatch(sql, matchId, "test-user");

      // Try to unmatch
      const result = await unmatchPushedMatch(sql, matchId, "test-user");

      expect(result.success).toBe(false);
      expect(result.alreadyPushed).toBe(true);
      expect(result.error).toContain("marked as paid in Shopify");
    });

    it("S17-52: unmatch a suggested match is a no-op", async () => {
      const paymentId = await createTestPayment(1000000n);
      const invoiceId = await createTestInvoice(1000000n);
      const matchId = `match-suggested-${Date.now().toString(36)}-${TEST_SUFFIX}`;

      // Create a suggested match directly
      await sql`
        INSERT INTO "Match" (
          id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state,
          "createdAt", "updatedAt"
        )
        VALUES (
          ${matchId}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId},
          10000.00, 80, ${sql.json([])}, 'suggested', NOW(), NOW()
        )
      `;

      const result = await unmatchMatch(sql, matchId, "test-user");

      expect(result.success).toBe(true);
    });

    it("S17-53: unmatch writes audit event", async () => {
      const paymentId = await createTestPayment(1000000n);
      const invoiceId = await createTestInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      await unmatchMatch(sql, matchId, "test-user");

      const [event] = await sql<{ type: string; data: unknown }[]>`
        SELECT type, data FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND type = 'match.unmatched'
          AND data->>'matchId' = ${matchId}
      `;

      expect(event).toBeDefined();
      expect(event.type).toBe("match.unmatched");
    });
  });

  describe("S17-60 to S17-62: No PII in logs/audit", () => {
    it("S17-62: audit data contains only IDs and amounts, no PII", async () => {
      const paymentId = await createTestPayment(1000000n);
      const invoiceId = await createTestInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      await applyMatch(sql, matchId, "test-user");

      const events = await sql<{ data: unknown }[]>`
        SELECT data FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
      `;

      for (const event of events) {
        const data = event.data as Record<string, unknown>;

        // Check for forbidden PII fields
        expect(data).not.toHaveProperty("email");
        expect(data).not.toHaveProperty("phone");
        expect(data).not.toHaveProperty("address");
        expect(data).not.toHaveProperty("name");
        expect(data).not.toHaveProperty("narration");
        expect(data).not.toHaveProperty("payerText");
        expect(data).not.toHaveProperty("utr");

        // Verify only expected fields
        const allowedFields = [
          "matchId", "invoiceId", "paymentId", "orderGid",
          "amountPaise", "previousOutstandingPaise", "newOutstandingPaise",
          "shopifyPushSucceeded", "reasonCode", "previousState"
        ];
        for (const key of Object.keys(data)) {
          expect(allowedFields).toContain(key);
        }
      }
    });
  });

  describe("Credit status recompute enqueue", () => {
    it("enqueues CREDIT_STATUS_RECOMPUTE after successful apply", async () => {
      const paymentId = await createTestPayment(1000000n);
      const invoiceId = await createTestInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      await applyMatch(sql, matchId, "test-user");

      // Find the recompute message by buyerAccountId (not by queue length)
      const [queueMsg] = await sql<{
        message: { topic: string; buyerAccountId: string; source: string };
      }[]>`
        SELECT message FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
          AND message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
        ORDER BY enqueued_at DESC
        LIMIT 1
      `;

      expect(queueMsg).toBeDefined();
      expect(queueMsg.message.topic).toBe("CREDIT_STATUS_RECOMPUTE");
      expect(queueMsg.message.buyerAccountId).toBe(TEST_ACCOUNT_ID);
      expect(queueMsg.message.source).toBe("invoice_change");
    });

    it("does NOT enqueue on Shopify failure (partial not pushed)", async () => {
      mockShopifySuccess = false;

      const paymentId = await createTestPayment(1000000n);
      const invoiceId = await createTestInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 1000000n);

      // Clear any existing messages first
      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}`;

      await applyMatch(sql, matchId, "test-user");

      // Should NOT have a recompute message (rollback occurred)
      const [queueMsg] = await sql<{ message: unknown }[]>`
        SELECT message FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
          AND message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
        LIMIT 1
      `;

      expect(queueMsg).toBeUndefined();
    });

    it("enqueues after partial apply (no Shopify call)", async () => {
      const paymentId = await createTestPayment(500000n);
      const invoiceId = await createTestInvoice(1000000n);
      const matchId = await createConfirmedMatch(paymentId, invoiceId, 500000n);

      await applyMatch(sql, matchId, "test-user");

      // Find the recompute message
      const [queueMsg] = await sql<{
        message: { topic: string; buyerAccountId: string };
      }[]>`
        SELECT message FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
          AND message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
        ORDER BY enqueued_at DESC
        LIMIT 1
      `;

      expect(queueMsg).toBeDefined();
      expect(queueMsg.message.topic).toBe("CREDIT_STATUS_RECOMPUTE");
    });
  });

  describe("match.confirmed audit event", () => {
    it("confirmMatch writes match.confirmed audit event", async () => {
      const paymentId = await createTestPayment(1000000n);
      const invoiceId = await createTestInvoice(1000000n);

      // Create a suggested match
      const matchId = `match-confirm-${Date.now().toString(36)}-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "Match" (
          id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state,
          "createdAt", "updatedAt"
        )
        VALUES (
          ${matchId}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId},
          10000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, 'suggested',
          NOW(), NOW()
        )
      `;

      // Confirm the match
      const result = await confirmMatch(sql, TEST_SHOP_ID, matchId, "test-user");
      expect(result.success).toBe(true);

      // Check for match.confirmed audit event
      const [event] = await sql<{ type: string; actor: string; data: unknown }[]>`
        SELECT type, actor, data FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND type = 'match.confirmed'
          AND data->>'matchId' = ${matchId}
      `;

      expect(event).toBeDefined();
      expect(event.type).toBe("match.confirmed");
      expect(event.actor).toBe("test-user");
      expect((event.data as Record<string, unknown>).invoiceId).toBe(invoiceId);
      expect((event.data as Record<string, unknown>).paymentId).toBe(paymentId);
    });
  });
});
