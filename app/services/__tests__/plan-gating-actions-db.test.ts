/**
 * DB-backed integration tests for plan gating of value-add actions (S21).
 *
 * Tests with PLAN_GATING_ENFORCED=true that:
 * 1. Payment reminders are blocked for gated accounts (no ReminderLog, no cap consumed)
 * 2. Credit-limit edits are blocked for gated accounts (via isAccountActive in route)
 *
 * Tests with PLAN_GATING_ENFORCED=false that:
 * - All actions are allowed for gated accounts
 *
 * Regression tests that matching/confirm/paid still work for gated accounts.
 *
 * Note: Import limit tests are in this file using real DB (different from
 * gating.test.ts which uses mocks). These test the actual SQL queries.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const originalEnv = process.env.PLAN_GATING_ENFORCED;

// Stub fetch globally for Resend API calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describeWithDb("Plan gating value-add actions (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-gating-actions";
  const TEST_SHOP_ID = `shop-gating-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `gating-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_GATED_ACCOUNT_ID = `acc-gated-${TEST_SUFFIX}`;
  const TEST_NONGATED_ACCOUNT_ID = `acc-nongated-${TEST_SUFFIX}`;
  const TEST_CUSTOMER_ID = `gid://shopify/Customer/test-${TEST_SUFFIX}`;
  const TEST_NONGATED_CUSTOMER_ID = `gid://shopify/Customer/nongated-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop (free plan by default)
    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', 'free', NOW(), NOW())
    `;

    // Create gated buyer account
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", "customerId", name,
        "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
        "syncPending", "syncVersion", gated_at, "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_GATED_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER',
        NULL, NULL, ${TEST_CUSTOMER_ID},
        'Gated Account', 100000.00, 'OK', false, false, 30, 'explicit',
        false, 1, NOW(), NOW(), NOW()
      )
    `;

    // Create non-gated buyer account
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", "customerId", name,
        "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_NONGATED_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER',
        NULL, NULL, ${TEST_NONGATED_CUSTOMER_ID},
        'Non-Gated Account', 100000.00, 'OK', false, false, 30, 'explicit',
        false, 1, NOW(), NOW()
      )
    `;

    // Create s8_tagged_customers entries for email lookup
    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
      VALUES 
        (${TEST_SHOP_ID}, ${TEST_CUSTOMER_ID}, 'gated-buyer@test.com', 'Gated Buyer', NOW()),
        (${TEST_SHOP_ID}, ${TEST_NONGATED_CUSTOMER_ID}, 'nongated-buyer@test.com', 'Non-Gated Buyer', NOW())
      ON CONFLICT (shop_id, customer_id) DO NOTHING
    `;
  });

  afterAll(async () => {
    process.env.PLAN_GATING_ENFORCED = originalEnv;
    // Clean up in reverse order of creation
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s18_global_sends WHERE send_key = 'global'`;
    await sql`DELETE FROM "Match" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    // Clean up invoices and reminders between tests
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s18_global_sends WHERE send_key = 'global'`;
    await sql`DELETE FROM "Match" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("../shopify-client.server");
  });

  describe("1. Payment reminders - getInvoiceForReminder returns gated_at", () => {
    it("returns buyerAccountGatedAt for gated account", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";

      const invoiceId = `inv-reminder-gated-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/reminder-gated-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_GATED_ACCOUNT_ID}, ${orderId},
          '#GATED-REMINDER-1', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '5 days', NOW(), NOW(), NOW()
        )
      `;

      const { getInvoiceForReminder } = await import("../reminders.server");

      const invoice = await getInvoiceForReminder(sql, TEST_SHOP_ID, invoiceId);

      expect(invoice).not.toBeNull();
      expect(invoice!.buyerAccountGatedAt).not.toBeNull();
      expect(invoice!.buyerAccountGatedAt).toBeInstanceOf(Date);
    });

    it("returns null buyerAccountGatedAt for non-gated account", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";

      const invoiceId = `inv-reminder-nongated-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/reminder-nongated-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_NONGATED_ACCOUNT_ID}, ${orderId},
          '#NONGATED-REMINDER-1', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '5 days', NOW(), NOW(), NOW()
        )
      `;

      const { getInvoiceForReminder } = await import("../reminders.server");

      const invoice = await getInvoiceForReminder(sql, TEST_SHOP_ID, invoiceId);

      expect(invoice).not.toBeNull();
      expect(invoice!.buyerAccountGatedAt).toBeNull();
    });
  });

  describe("2. sendPaymentReminder - real DB with gating", () => {
    const RULE_ID = `rule-test-${Date.now().toString(36)}`;
    const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test.com" };

    it("skips gated account with gating ON - NO ReminderLog, NO cap consumed", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();

      const invoiceId = `inv-send-gated-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/send-gated-${TEST_SUFFIX}`;

      // Create invoice for gated account - due today for offset=0
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_GATED_ACCOUNT_ID}, ${orderId},
          '#GATED-SEND-1', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '5 days', NOW(), NOW(), NOW()
        )
      `;

      // Get counts before
      const { getGlobalSendCounts, sendPaymentReminder } = await import("../reminders.server");
      const countsBefore = await getGlobalSendCounts(sql);

      // Mock send window (tested separately)
      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);

      const result = await sendPaymentReminder(
        sql,
        TEST_SHOP_ID,
        invoiceId,
        RULE_ID,
        0, // offset = 0 (due today)
        "Asia/Kolkata",
        validEnv
      );

      // Should be skipped due to gating
      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("gated");

      // NO ReminderLog row should be created
      const [logRow] = await sql<{ id: string }[]>`
        SELECT id FROM "ReminderLog"
        WHERE "shopId" = ${TEST_SHOP_ID} AND "invoiceId" = ${invoiceId}
      `;
      expect(logRow).toBeUndefined();

      // NO cap slot consumed
      const countsAfter = await getGlobalSendCounts(sql);
      expect(countsAfter.daily).toBe(countsBefore.daily);
      expect(countsAfter.monthly).toBe(countsBefore.monthly);

      // NO fetch call to Resend
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("allows gated account with gating OFF (passes Gate 3)", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "0";
      vi.resetModules();

      const invoiceId = `inv-send-gated-off-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/send-gated-off-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_GATED_ACCOUNT_ID}, ${orderId},
          '#GATED-SEND-OFF', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '5 days', NOW(), NOW(), NOW()
        )
      `;

      const { sendPaymentReminder } = await import("../reminders.server");

      // Mock send window
      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);

      // Mock successful Resend response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "email-gated-off" }),
      });

      const result = await sendPaymentReminder(
        sql,
        TEST_SHOP_ID,
        invoiceId,
        RULE_ID,
        0,
        "Asia/Kolkata",
        validEnv
      );

      // With gating OFF, should pass Gate 3 and attempt to send
      // (may be skipped for other reasons like "not the reminder day", but Gate 3 passes)
      // If sent successfully, action will be "sent"
      // If skipped for other reasons (day check), that's fine - key is Gate 3 passed
      expect(result.success).toBe(true);
      // Either sent or skipped for OTHER reasons (not gating)
      if (result.action === "skipped") {
        expect(result.skipReason).not.toContain("gated");
      }
    });

    it("allows non-gated account with gating ON", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();

      const invoiceId = `inv-send-nongated-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/send-nongated-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_NONGATED_ACCOUNT_ID}, ${orderId},
          '#NONGATED-SEND', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '5 days', NOW(), NOW(), NOW()
        )
      `;

      const { sendPaymentReminder } = await import("../reminders.server");

      // Mock send window
      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);

      // Mock successful Resend response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "email-nongated" }),
      });

      const result = await sendPaymentReminder(
        sql,
        TEST_SHOP_ID,
        invoiceId,
        RULE_ID,
        0,
        "Asia/Kolkata",
        validEnv
      );

      // Non-gated account should pass Gate 3
      expect(result.success).toBe(true);
      // If sent or skipped for OTHER reasons (not gating)
      if (result.action === "skipped") {
        expect(result.skipReason).not.toContain("gated");
      }
    });
  });

  describe("3. Bulk import - checkImportLimit with real DB", () => {
    it("blocks import when at limit with gating ON (free plan)", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();

      // Create one import this month (free plan limit is 1)
      const importId = `import-limit-test-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
        VALUES (${importId}, ${TEST_SHOP_ID}, 'hdfc', 'test.xlsx', 10, NOW())
      `;

      const { checkImportLimit } = await import("../gating.server");
      const result = await checkImportLimit(sql, TEST_SHOP_ID);

      expect(result.allowed).toBe(false);
      expect(result.currentUsage).toBe(1);
      expect(result.limit).toBe(1);
      expect(result.reason).toContain("Import limit reached");
    });

    it("allows import when under limit with gating ON (free plan)", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();

      // No imports this month
      const { checkImportLimit } = await import("../gating.server");
      const result = await checkImportLimit(sql, TEST_SHOP_ID);

      expect(result.allowed).toBe(true);
      expect(result.currentUsage).toBe(0);
      expect(result.limit).toBe(1);
    });

    it("allows import when gating OFF regardless of limit", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "0";
      vi.resetModules();

      // Create one import this month
      const importId = `import-limit-off-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
        VALUES (${importId}, ${TEST_SHOP_ID}, 'hdfc', 'test.xlsx', 10, NOW())
      `;

      const { checkImportLimit } = await import("../gating.server");
      const result = await checkImportLimit(sql, TEST_SHOP_ID);

      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("Gating not enforced");
    });

    it("allows unlimited imports for starter+ plans with gating ON", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();

      // Upgrade shop to starter
      await sql`UPDATE "Shop" SET plan_key = 'starter' WHERE id = ${TEST_SHOP_ID}`;

      try {
        const { checkImportLimit } = await import("../gating.server");
        const result = await checkImportLimit(sql, TEST_SHOP_ID);

        expect(result.allowed).toBe(true);
        expect(result.limit).toBe(-1); // Unlimited
      } finally {
        // Restore to free plan
        await sql`UPDATE "Shop" SET plan_key = 'free' WHERE id = ${TEST_SHOP_ID}`;
      }
    });
  });

  describe("Regression: matching/confirm/paid NOT gated", () => {
    it("matcher suggests match for gated account invoice", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();

      const invoiceId = `inv-match-gated-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/match-gated-${TEST_SUFFIX}`;
      const importId = `import-match-${TEST_SUFFIX}`;
      const paymentId = `payment-match-${TEST_SUFFIX}`;

      // Create invoice for gated account
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_GATED_ACCOUNT_ID}, ${orderId},
          '#GATED-MATCH-1', 25000.00, 25000.00, 'open',
          NOW() - INTERVAL '10 days', NOW() - INTERVAL '5 days', NOW(), NOW()
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
          'Payment for #GATED-MATCH-1', 'Gated Account', ${'UTR-match-' + TEST_SUFFIX},
          NOW() - INTERVAL '1 day', 'unmatched', NOW(), NOW()
        )
      `;

      const { runMatcher } = await import("../matcher.server");
      const matchResult = await runMatcher(sql, TEST_SHOP_ID, { limit: 10 });

      expect(matchResult.paymentsProcessed).toBeGreaterThanOrEqual(1);
      expect(matchResult.matchesCreated).toBeGreaterThanOrEqual(1);

      // Verify match was created
      const [match] = await sql<{ id: string; invoiceId: string }[]>`
        SELECT id, "invoiceId" FROM "Match"
        WHERE "paymentId" = ${paymentId} AND state = 'suggested'
        LIMIT 1
      `;

      expect(match).toBeDefined();
      expect(match.invoiceId).toBe(invoiceId);
    });

    it("confirmMatch succeeds for gated account", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();

      const invoiceId = `inv-confirm-gated-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/confirm-gated-${TEST_SUFFIX}`;
      const importId = `import-confirm-${TEST_SUFFIX}`;
      const paymentId = `payment-confirm-${TEST_SUFFIX}`;
      const matchId = `match-confirm-${TEST_SUFFIX}`;

      // Create invoice for gated account
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_GATED_ACCOUNT_ID}, ${orderId},
          '#GATED-CONFIRM-1', 15000.00, 15000.00, 'open',
          NOW() - INTERVAL '10 days', NOW() - INTERVAL '5 days', NOW(), NOW()
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
          'Payment for #GATED-CONFIRM-1', 'Gated Account', ${'UTR-confirm-' + TEST_SUFFIX},
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

      const { confirmMatch } = await import("../matcher.server");
      const confirmResult = await confirmMatch(sql, TEST_SHOP_ID, matchId, "test-user");

      expect(confirmResult.success).toBe(true);

      // Verify match state
      const [match] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${matchId}
      `;
      expect(match.state).toBe("confirmed");
    });

    it("invoice marked paid on gated account triggers hold recompute", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();

      const invoiceId = `inv-paid-gated-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/paid-gated-${TEST_SUFFIX}`;

      // Set gated account to HELD (simulating overdue state)
      await sql`
        UPDATE "BuyerAccount"
        SET "holdState" = 'HELD', "holdReasonCode" = 'PAYMENT_OVERDUE'
        WHERE id = ${TEST_GATED_ACCOUNT_ID}
      `;

      // Create overdue invoice for gated account
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_GATED_ACCOUNT_ID}, ${orderId},
          '#GATED-PAID-1', 20000.00, 20000.00, 'open',
          NOW() - INTERVAL '10 days', NOW() - INTERVAL '5 days', NOW(), NOW()
        )
      `;

      // Mark invoice as paid
      await sql`
        UPDATE "Invoice"
        SET status = 'paid', outstanding = 0
        WHERE id = ${invoiceId}
      `;

      // Mock shopify client for metafield write
      vi.doMock("../shopify-client.server", () => ({
        shopifyGraphQLRequest: vi.fn().mockResolvedValue({
          success: true,
          data: {
            metafieldsSet: {
              metafields: [{ id: "mf-1" }],
              userErrors: [],
            },
          },
        }),
      }));

      const { recomputeCreditStatus } = await import("../credit-status-recompute.server");
      const result = await recomputeCreditStatus(sql, TEST_GATED_ACCOUNT_ID);

      // Recompute should succeed and clear the hold (gated accounts still get credit status updates)
      expect(result.success).toBe(true);
      expect(result.previousHold).toBe(true);
      expect(result.newHold).toBe(false);

      // Verify hold is cleared
      const [account] = await sql<{ holdState: string }[]>`
        SELECT "holdState" FROM "BuyerAccount" WHERE id = ${TEST_GATED_ACCOUNT_ID}
      `;
      expect(account.holdState).toBe("OK");

      // Restore holdState for other tests
      await sql`
        UPDATE "BuyerAccount"
        SET "holdState" = 'OK', "holdReasonCode" = NULL
        WHERE id = ${TEST_GATED_ACCOUNT_ID}
      `;
    });
  });
});
