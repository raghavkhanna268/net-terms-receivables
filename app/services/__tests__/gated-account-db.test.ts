/**
 * DB-backed integration tests for gated account behavior.
 *
 * Product rule: Gated accounts are never hidden from totals or lists.
 * Holds and the checkout block work on every plan.
 * Gating applies only to value-add actions (reminders, credit-limit edits,
 * account editing, bulk statement import).
 *
 * Tests verify that with PLAN_GATING_ENFORCED=true and a gated account:
 * 1. Orders still become Invoices through the normal eligibility/sync path
 * 2. When overdue or over limit, the account still drives a hold
 * 3. The credit-status metafield write happens (syncPending handled normally)
 * 4. The account still appears in aging totals and per-account aging rows
 * 5. Matching suggests and confirmMatch succeeds
 * 6. The hold clears after the invoice is paid and recomputed
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

// Track metafield write calls
let metafieldWriteCount = 0;

const mockShopifyGraphQLRequest = vi.fn().mockImplementation(async () => {
  metafieldWriteCount++;
  return {
    success: true,
    data: {
      metafieldsSet: {
        metafields: [{ id: "mf-1", namespace: "$app", key: "credit_status" }],
        userErrors: [],
      },
    },
  };
});

vi.mock("../shopify-client.server", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    shopifyGraphQLRequest: (...args: unknown[]) => mockShopifyGraphQLRequest(...args),
  };
});

// Import after mock setup
import { recomputeCreditStatus } from "../credit-status-recompute.server";
import { checkOrderEligibility, getEligibilityContext } from "~/lib/invoice-eligibility";
import { getShopAgingTotals, getBuyerLedger, getBuyerInvoices } from "~/lib/aging-queries.server";
import { runMatcher, confirmMatch } from "../matcher.server";
import { getSyncHandler } from "../drain/processor.server";
import { processOrderWebhook } from "../sync/order.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

// Set PLAN_GATING_ENFORCED=true for these tests
const originalEnv = process.env.PLAN_GATING_ENFORCED;

// Pin the clock to a fixed time for deterministic as-of date comparisons.
// This ensures JS `new Date()` is consistent with DB `NOW()` for aging buckets.
const PINNED_TIME = new Date("2026-10-15T12:00:00Z");

describeWithDb("gated account behavior (PLAN_GATING_ENFORCED=true)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-gated-full";
  const TEST_SHOP_ID = `shop-gated-full-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `gated-full-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_GATED_ACCOUNT_ID = `acc-gated-full-${TEST_SUFFIX}`;
  const TEST_NONGATED_ACCOUNT_ID = `acc-nongated-${TEST_SUFFIX}`;
  const TEST_COMPANY_LOCATION_ID = `gid://shopify/CompanyLocation/gated-${TEST_SUFFIX}`;
  const TEST_NONGATED_COMPANY_LOCATION_ID = `gid://shopify/CompanyLocation/nongated-${TEST_SUFFIX}`;

  beforeAll(async () => {
    // Pin the JS clock for deterministic date comparisons
    // Only mock Date to avoid interfering with database connection timers
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(PINNED_TIME);

    (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop
    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
    `;

    // Create gated buyer account
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
        "syncPending", "syncVersion", gated_at, "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_GATED_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-gated-" + TEST_SUFFIX}, ${TEST_COMPANY_LOCATION_ID},
        'Gated Account', 100000.00, 'OK', false, false, 30, 'explicit',
        false, 1, NOW(), NOW(), NOW()
      )
    `;

    // Create non-gated buyer account (control)
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_NONGATED_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-nongated-" + TEST_SUFFIX}, ${TEST_NONGATED_COMPANY_LOCATION_ID},
        'Non-Gated Account', 100000.00, 'OK', false, false, 30, 'explicit',
        false, 1, NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    vi.useRealTimers();
    if (originalEnv === undefined) {
      delete (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED;
    } else {
      process.env.PLAN_GATING_ENFORCED = originalEnv;
    }
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'%' + TEST_SUFFIX + '%'}`;
    await sql`DELETE FROM "Match" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    metafieldWriteCount = 0;
    mockShopifyGraphQLRequest.mockClear();
    
    // Reset account states
    await sql`
      UPDATE "BuyerAccount"
      SET "holdState" = 'OK', "holdReasonCode" = NULL, "manualHold" = false,
          "syncPending" = false, "syncVersion" = 1
      WHERE id IN (${TEST_GATED_ACCOUNT_ID}, ${TEST_NONGATED_ACCOUNT_ID})
    `;
    
    // Clean up invoices and matches
    await sql`DELETE FROM "Match" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'%' + TEST_SUFFIX + '%'}`;
  });

  describe("invoice eligibility", () => {
    it("gated account's order becomes an Invoice through eligibility check", async () => {
      const context = await getEligibilityContext(sql, TEST_SHOP_ID);
      expect(context).not.toBeNull();

      const order = {
        id: "gid://shopify/Order/gated-test-1",
        name: "#GATED-1",
        createdAt: new Date().toISOString(),
        displayFinancialStatus: "PENDING" as const,
        purchasingEntity: {
          __typename: "PurchasingCompany" as const,
          location: { id: TEST_COMPANY_LOCATION_ID },
        },
        totalPriceSet: { shopMoney: { amount: "10000.00", currencyCode: "INR" } },
      };

      const result = await checkOrderEligibility(sql, order, context!);

      // Gated account should still be eligible
      expect(result.eligible).toBe(true);
      expect(result.reason).toBe("company_account_terms");
      expect(result.buyerAccountId).toBe(TEST_GATED_ACCOUNT_ID);
    });

    it("control: non-gated account's order also becomes an Invoice", async () => {
      const context = await getEligibilityContext(sql, TEST_SHOP_ID);

      const order = {
        id: "gid://shopify/Order/nongated-test-1",
        name: "#NONGATED-1",
        createdAt: new Date().toISOString(),
        displayFinancialStatus: "PENDING" as const,
        purchasingEntity: {
          __typename: "PurchasingCompany" as const,
          location: { id: TEST_NONGATED_COMPANY_LOCATION_ID },
        },
        totalPriceSet: { shopMoney: { amount: "10000.00", currencyCode: "INR" } },
      };

      const result = await checkOrderEligibility(sql, order, context!);

      expect(result.eligible).toBe(true);
      expect(result.reason).toBe("company_account_terms");
      expect(result.buyerAccountId).toBe(TEST_NONGATED_ACCOUNT_ID);
    });
  });

  describe("holds and credit status", () => {
    it("gated account is auto-held when overdue via recompute", async () => {
      const invoiceId = `inv-gated-overdue-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/gated-overdue-${TEST_SUFFIX}`;

      // Create overdue invoice for gated account
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_GATED_ACCOUNT_ID}, ${orderId},
          '#GATED-OVERDUE-1', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '10 days',
          NOW() - INTERVAL '5 days',
          NOW(), NOW()
        )
      `;

      const result = await recomputeCreditStatus(sql, TEST_GATED_ACCOUNT_ID);

      expect(result.success).toBe(true);
      expect(result.newHold).toBe(true);
      expect(result.metafieldWritten).toBe(true);
      expect(metafieldWriteCount).toBe(1);

      // Verify DB state
      const [account] = await sql<{ holdState: string }[]>`
        SELECT "holdState" FROM "BuyerAccount" WHERE id = ${TEST_GATED_ACCOUNT_ID}
      `;
      expect(account.holdState).toBe("HELD");
    });

    it("gated account is included in sweep function when overdue", async () => {
      const invoiceId = `inv-gated-sweep-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/gated-sweep-${TEST_SUFFIX}`;

      // Create overdue invoice for gated account
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_GATED_ACCOUNT_ID}, ${orderId},
          '#GATED-SWEEP-1', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '10 days',
          NOW() - INTERVAL '5 days',
          NOW(), NOW()
        )
      `;

      // Run the sweep function
      const [result] = await sql<{ accounts_enqueued: number }[]>`
        SELECT * FROM enqueue_credit_status_recomputes()
      `;

      expect(result.accounts_enqueued).toBeGreaterThanOrEqual(1);

      // Verify message was enqueued for the gated account
      const [queueMsg] = await sql<{ message: { buyerAccountId: string } }[]>`
        SELECT message FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${TEST_GATED_ACCOUNT_ID}
        LIMIT 1
      `;

      expect(queueMsg).toBeDefined();
      expect(queueMsg.message.buyerAccountId).toBe(TEST_GATED_ACCOUNT_ID);
    });

    it("gated account hold clears after invoice is paid and recomputed", async () => {
      const invoiceId = `inv-gated-paid-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/gated-paid-${TEST_SUFFIX}`;

      // Create overdue invoice and set account to HELD
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_GATED_ACCOUNT_ID}, ${orderId},
          '#GATED-PAID-1', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '10 days',
          NOW() - INTERVAL '5 days',
          NOW(), NOW()
        )
      `;

      await sql`
        UPDATE "BuyerAccount"
        SET "holdState" = 'HELD', "manualHold" = false
        WHERE id = ${TEST_GATED_ACCOUNT_ID}
      `;

      // Pay the invoice
      await sql`
        UPDATE "Invoice"
        SET status = 'paid', outstanding = 0
        WHERE id = ${invoiceId}
      `;

      // Recompute credit status
      const result = await recomputeCreditStatus(sql, TEST_GATED_ACCOUNT_ID);

      expect(result.success).toBe(true);
      expect(result.previousHold).toBe(true);
      expect(result.newHold).toBe(false);
      expect(result.metafieldWritten).toBe(true);

      // Verify DB state
      const [account] = await sql<{ holdState: string }[]>`
        SELECT "holdState" FROM "BuyerAccount" WHERE id = ${TEST_GATED_ACCOUNT_ID}
      `;
      expect(account.holdState).toBe("OK");
    });

    it("e2e: markInvoicePaid enqueues recompute, handler clears hold on gated account", async () => {
      const invoiceId = `inv-gated-e2e-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/gated-e2e-${TEST_SUFFIX}`;
      const webhookId = `webhook-gated-e2e-${TEST_SUFFIX}`;

      // 1. Create overdue invoice for gated account
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_GATED_ACCOUNT_ID}, ${orderId},
          '#GATED-E2E-1', 15000.00, 15000.00, 'open',
          NOW() - INTERVAL '10 days',
          NOW() - INTERVAL '5 days',
          NOW(), NOW()
        )
      `;

      // 2. Set account to HELD (overdue)
      await sql`
        UPDATE "BuyerAccount"
        SET "holdState" = 'HELD', "holdReasonCode" = 'PAYMENT_OVERDUE', "manualHold" = false
        WHERE id = ${TEST_GATED_ACCOUNT_ID}
      `;

      // Verify account is held before we pay
      const [beforePay] = await sql<{ holdState: string }[]>`
        SELECT "holdState" FROM "BuyerAccount" WHERE id = ${TEST_GATED_ACCOUNT_ID}
      `;
      expect(beforePay.holdState).toBe("HELD");

      // 3. Drive the real markInvoicePaid path via processOrderWebhook with ORDERS_PAID topic
      const paidResult = await processOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "ORDERS_PAID",
        {
          id: orderId,
          name: "#GATED-E2E-1",
          createdAt: new Date().toISOString(),
          displayFinancialStatus: "PAID",
        },
        webhookId
      );

      expect(paidResult.success).toBe(true);
      expect(paidResult.action).toBe("updated");

      // 4. Verify invoice is now paid
      const [paidInvoice] = await sql<{ status: string; outstanding: string }[]>`
        SELECT status, outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(paidInvoice.status).toBe("paid");
      expect(paidInvoice.outstanding).toBe("0.00");

      // 5. Assert that a CREDIT_STATUS_RECOMPUTE message for this buyerAccountId lands on s6_sync
      // Find by payload, not queue length
      const [recomputeMsg] = await sql<{ msg_id: string; message: { topic: string; buyerAccountId: string } }[]>`
        SELECT msg_id, message FROM pgmq.q_s6_sync
        WHERE message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
          AND message->>'buyerAccountId' = ${TEST_GATED_ACCOUNT_ID}
        ORDER BY msg_id DESC
        LIMIT 1
      `;

      expect(recomputeMsg).toBeDefined();
      expect(recomputeMsg.message.topic).toBe("CREDIT_STATUS_RECOMPUTE");
      expect(recomputeMsg.message.buyerAccountId).toBe(TEST_GATED_ACCOUNT_ID);

      // 6. Process it through the real handler
      const recomputeHandler = getSyncHandler("CREDIT_STATUS_RECOMPUTE");
      expect(recomputeHandler).toBeDefined();

      const handlerResult = await recomputeHandler!(sql, {
        ...recomputeMsg.message,
        shop: TEST_SHOP_DOMAIN,
        webhookId: `credit_recompute:${TEST_GATED_ACCOUNT_ID}:e2e-test`,
        resourceGid: TEST_GATED_ACCOUNT_ID,
        enqueuedAt: new Date().toISOString(),
      });

      expect(handlerResult.success).toBe(true);

      // 7. Assert the hold clears
      const [afterRecompute] = await sql<{ holdState: string }[]>`
        SELECT "holdState" FROM "BuyerAccount" WHERE id = ${TEST_GATED_ACCOUNT_ID}
      `;
      expect(afterRecompute.holdState).toBe("OK");
    });
  });

  describe("aging totals and lists", () => {
    it("getShopAgingTotals includes gated account's invoices", async () => {
      const invoiceId = `inv-gated-aging-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/gated-aging-${TEST_SUFFIX}`;

      // Create an open invoice for gated account
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_GATED_ACCOUNT_ID}, ${orderId},
          '#GATED-AGING-1', 50000.00, 50000.00, 'open',
          NOW() - INTERVAL '5 days',
          NOW() + INTERVAL '25 days',
          NOW(), NOW()
        )
      `;

      // Call the real getShopAgingTotals function
      const totals = await getShopAgingTotals(sql, TEST_SHOP_ID, new Date());

      // Gated account's invoice MUST be in the totals (product rule: gated accounts
      // are never hidden from totals)
      expect(totals.totalByCurrency["INR"]).toBeDefined();
      expect(BigInt(totals.totalByCurrency["INR"])).toBe(5000000n); // 50000 * 100 paise
      // Should be in "current" bucket (due in future)
      expect(totals.buckets["current"].byCurrency["INR"]).toBeDefined();
      expect(BigInt(totals.buckets["current"].byCurrency["INR"])).toBe(5000000n);
    });

    it("getBuyerLedger includes gated account with is_gated flag", async () => {
      const invoiceId = `inv-gated-ledger-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/gated-ledger-${TEST_SUFFIX}`;

      // Create an open invoice for gated account
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_GATED_ACCOUNT_ID}, ${orderId},
          '#GATED-LEDGER-1', 30000.00, 30000.00, 'open',
          NOW() - INTERVAL '5 days',
          NOW() + INTERVAL '25 days',
          NOW(), NOW()
        )
      `;

      // Call the real getBuyerLedger function
      const { rows, totalCount } = await getBuyerLedger(sql, TEST_SHOP_ID, new Date(), {
        limit: 100,
        offset: 0,
        sortBy: "outstanding",
        sortOrder: "desc",
      });

      // Gated account MUST appear in buyer ledger (product rule: gated accounts
      // are never hidden from lists)
      expect(totalCount).toBeGreaterThanOrEqual(1);
      const gatedRow = rows.find(r => r.buyer_account_id === TEST_GATED_ACCOUNT_ID);
      expect(gatedRow).toBeDefined();
      expect(gatedRow!.is_gated).toBe(true);
      expect(BigInt(gatedRow!.outstanding_paise)).toBe(3000000n);
    });

    it("getBuyerInvoices returns invoices for gated account", async () => {
      const invoiceId1 = `inv-gated-list1-${TEST_SUFFIX}`;
      const invoiceId2 = `inv-gated-list2-${TEST_SUFFIX}`;
      const orderId1 = `gid://shopify/Order/gated-list1-${TEST_SUFFIX}`;
      const orderId2 = `gid://shopify/Order/gated-list2-${TEST_SUFFIX}`;

      // Create multiple open invoices for gated account
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES 
          (${invoiceId1}, ${TEST_SHOP_ID}, ${TEST_GATED_ACCOUNT_ID}, ${orderId1},
           '#GATED-LIST-1', 15000.00, 15000.00, 'open',
           NOW() - INTERVAL '10 days', NOW() + INTERVAL '20 days', NOW(), NOW()),
          (${invoiceId2}, ${TEST_SHOP_ID}, ${TEST_GATED_ACCOUNT_ID}, ${orderId2},
           '#GATED-LIST-2', 25000.00, 25000.00, 'open',
           NOW() - INTERVAL '5 days', NOW() + INTERVAL '25 days', NOW(), NOW())
      `;

      // Call the real getBuyerInvoices function
      const { rows, totalCount } = await getBuyerInvoices(
        sql,
        TEST_SHOP_ID,
        TEST_GATED_ACCOUNT_ID,
        new Date(),
        { limit: 100, offset: 0 }
      );

      // Gated account's invoices MUST be returned (product rule: gated accounts
      // are never hidden from invoice lists)
      expect(totalCount).toBe(2);
      expect(rows).toHaveLength(2);
      
      // Verify both invoices are present
      const invoice1 = rows.find(r => r.id === invoiceId1);
      const invoice2 = rows.find(r => r.id === invoiceId2);
      expect(invoice1).toBeDefined();
      expect(invoice2).toBeDefined();
      expect(BigInt(invoice1!.outstanding_paise)).toBe(1500000n);
      expect(BigInt(invoice2!.outstanding_paise)).toBe(2500000n);
    });

    it("aging totals include overdue gated account invoices in correct bucket", async () => {
      const invoiceId = `inv-gated-overdue-aging-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/gated-overdue-aging-${TEST_SUFFIX}`;

      // Create an overdue invoice for gated account (31-60 days bucket)
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_GATED_ACCOUNT_ID}, ${orderId},
          '#GATED-OVERDUE-AGING-1', 45000.00, 45000.00, 'open',
          NOW() - INTERVAL '60 days',
          NOW() - INTERVAL '45 days',
          NOW(), NOW()
        )
      `;

      // Call the real getShopAgingTotals function
      const totals = await getShopAgingTotals(sql, TEST_SHOP_ID, new Date());

      // Gated account's overdue invoice MUST be in totals and overdue buckets
      expect(totals.totalByCurrency["INR"]).toBeDefined();
      expect(BigInt(totals.totalByCurrency["INR"])).toBe(4500000n);
      // Should be in 31-60 bucket
      expect(totals.buckets["31-60"].byCurrency["INR"]).toBeDefined();
      expect(BigInt(totals.buckets["31-60"].byCurrency["INR"])).toBe(4500000n);
      // Should be in overdue totals
      expect(totals.overdueByCurrency["INR"]).toBeDefined();
      expect(BigInt(totals.overdueByCurrency["INR"])).toBe(4500000n);
    });
  });

  describe("matching", () => {
    it("matcher suggests match for gated account's invoice", async () => {
      const invoiceId = `inv-gated-match-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/gated-match-${TEST_SUFFIX}`;
      const importId = `import-gated-${TEST_SUFFIX}`;
      const paymentId = `payment-gated-${TEST_SUFFIX}`;

      // Create invoice for gated account
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_GATED_ACCOUNT_ID}, ${orderId},
          '#GATED-MATCH-1', 25000.00, 25000.00, 'open',
          NOW() - INTERVAL '10 days',
          NOW() - INTERVAL '5 days',
          NOW(), NOW()
        )
      `;

      // Create bank import and payment
      await sql`
        INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
        VALUES (${importId}, ${TEST_SHOP_ID}, 'hdfc', 'test.xlsx', 1, NOW())
      `;

      await sql`
        INSERT INTO "Payment" (
          id, "shopId", "importId", amount, narration, "payerText", utr,
          "valueDate", status, "createdAt", "updatedAt"
        )
        VALUES (
          ${paymentId}, ${TEST_SHOP_ID}, ${importId}, 25000.00,
          'Payment for #GATED-MATCH-1', 'Gated Account', 'UTR123456',
          NOW() - INTERVAL '1 day', 'unmatched', NOW(), NOW()
        )
      `;

      // Run the matcher
      const matchResult = await runMatcher(sql, TEST_SHOP_ID, { limit: 10 });

      expect(matchResult.paymentsProcessed).toBeGreaterThanOrEqual(1);
      expect(matchResult.matchesCreated).toBeGreaterThanOrEqual(1);

      // Verify match was created
      const [match] = await sql<{ id: string; invoice_id: string }[]>`
        SELECT id, "invoiceId" AS invoice_id FROM "Match"
        WHERE "paymentId" = ${paymentId} AND state = 'suggested'
        LIMIT 1
      `;

      expect(match).toBeDefined();
      expect(match.invoice_id).toBe(invoiceId);
    });

    it("confirmMatch succeeds for gated account", async () => {
      const invoiceId = `inv-gated-confirm-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/gated-confirm-${TEST_SUFFIX}`;
      const importId = `import-gated-confirm-${TEST_SUFFIX}`;
      const paymentId = `payment-gated-confirm-${TEST_SUFFIX}`;
      const matchId = `match-gated-confirm-${TEST_SUFFIX}`;

      // Create invoice for gated account
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_GATED_ACCOUNT_ID}, ${orderId},
          '#GATED-CONFIRM-1', 15000.00, 15000.00, 'open',
          NOW() - INTERVAL '10 days',
          NOW() - INTERVAL '5 days',
          NOW(), NOW()
        )
      `;

      // Create bank import, payment, and match
      await sql`
        INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
        VALUES (${importId}, ${TEST_SHOP_ID}, 'hdfc', 'test-confirm.xlsx', 1, NOW())
      `;

      await sql`
        INSERT INTO "Payment" (
          id, "shopId", "importId", amount, narration, "payerText", utr,
          "valueDate", status, "createdAt", "updatedAt"
        )
        VALUES (
          ${paymentId}, ${TEST_SHOP_ID}, ${importId}, 15000.00,
          'Payment for #GATED-CONFIRM-1', 'Gated Account', 'UTR789012',
          NOW() - INTERVAL '1 day', 'unmatched', NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "Match" (
          id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state,
          "createdAt", "updatedAt"
        )
        VALUES (
          ${matchId}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId},
          15000.00, 85, '{"exact_amount": true}'::jsonb, 'suggested',
          NOW(), NOW()
        )
      `;

      // Confirm the match
      const confirmResult = await confirmMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      expect(confirmResult.success).toBe(true);

      // Verify match state
      const [match] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchId}
      `;
      expect(match.state).toBe("confirmed");
    });

    it("full flow: match, pay, recompute clears hold on gated account", async () => {
      const invoiceId = `inv-gated-flow-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/gated-flow-${TEST_SUFFIX}`;

      // Create overdue invoice and set account to HELD
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_GATED_ACCOUNT_ID}, ${orderId},
          '#GATED-FLOW-1', 20000.00, 20000.00, 'open',
          NOW() - INTERVAL '10 days',
          NOW() - INTERVAL '5 days',
          NOW(), NOW()
        )
      `;

      // Recompute to set hold
      const holdResult = await recomputeCreditStatus(sql, TEST_GATED_ACCOUNT_ID);
      expect(holdResult.newHold).toBe(true);

      // Simulate ORDERS_PAID webhook - mark invoice as paid
      const handler = getSyncHandler("ORDERS_PAID");
      expect(handler).toBeDefined();

      // Directly update invoice to paid (simulating the paid handler)
      await sql`
        UPDATE "Invoice"
        SET status = 'paid', outstanding = 0
        WHERE id = ${invoiceId}
      `;

      // Process CREDIT_STATUS_RECOMPUTE (as the paid handler enqueues it)
      const recomputeHandler = getSyncHandler("CREDIT_STATUS_RECOMPUTE");
      expect(recomputeHandler).toBeDefined();

      const message = {
        topic: "CREDIT_STATUS_RECOMPUTE",
        shop: TEST_SHOP_DOMAIN,
        buyerAccountId: TEST_GATED_ACCOUNT_ID,
        source: "invoice_change",
        webhookId: `credit_recompute:${TEST_GATED_ACCOUNT_ID}:flow-test`,
        resourceGid: TEST_GATED_ACCOUNT_ID,
        enqueuedAt: new Date().toISOString(),
      };

      const recomputeResult = await recomputeHandler!(sql, message);
      expect(recomputeResult.success).toBe(true);

      // Verify hold is cleared
      const [account] = await sql<{ holdState: string }[]>`
        SELECT "holdState" FROM "BuyerAccount" WHERE id = ${TEST_GATED_ACCOUNT_ID}
      `;
      expect(account.holdState).toBe("OK");
    });
  });

  describe("control case: non-gated account", () => {
    it("non-gated account behaves the same as gated for holds and aging", async () => {
      const invoiceId = `inv-nongated-control-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/nongated-control-${TEST_SUFFIX}`;

      // Create overdue invoice for non-gated account
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_NONGATED_ACCOUNT_ID}, ${orderId},
          '#NONGATED-CONTROL-1', 40000.00, 40000.00, 'open',
          NOW() - INTERVAL '10 days',
          NOW() - INTERVAL '5 days',
          NOW(), NOW()
        )
      `;

      // Recompute should set hold
      const result = await recomputeCreditStatus(sql, TEST_NONGATED_ACCOUNT_ID);
      expect(result.success).toBe(true);
      expect(result.newHold).toBe(true);
      expect(result.metafieldWritten).toBe(true);

      // Should appear in aging totals
      const totals = await getShopAgingTotals(sql, TEST_SHOP_ID, new Date());
      expect(BigInt(totals.totalByCurrency["INR"])).toBe(4000000n);

      // Should appear in buyer ledger
      const { rows } = await getBuyerLedger(sql, TEST_SHOP_ID, new Date(), {
        limit: 100,
        offset: 0,
        sortBy: "outstanding",
        sortOrder: "desc",
      });

      const nongatedRow = rows.find(r => r.buyer_account_id === TEST_NONGATED_ACCOUNT_ID);
      expect(nongatedRow).toBeDefined();
      expect(nongatedRow!.is_gated).toBe(false);
    });
  });
});
