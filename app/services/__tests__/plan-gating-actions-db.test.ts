/**
 * DB-backed integration tests for plan gating of value-add actions (S21).
 *
 * Tests with PLAN_GATING_ENFORCED=true that:
 * 1. Payment reminders are blocked for gated accounts
 * 2. Credit-limit edits are blocked for gated accounts
 * 3. Bulk import is blocked when over import limit
 *
 * Tests with PLAN_GATING_ENFORCED=false that:
 * - All actions are allowed for gated accounts
 *
 * Regression tests that matching/confirm/paid still work for gated accounts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const originalEnv = process.env.PLAN_GATING_ENFORCED;

describeWithDb("Plan gating value-add actions (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-gating-actions";
  const TEST_SHOP_ID = `shop-gating-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `gating-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_GATED_ACCOUNT_ID = `acc-gated-${TEST_SUFFIX}`;
  const TEST_NONGATED_ACCOUNT_ID = `acc-nongated-${TEST_SUFFIX}`;
  const _TEST_COMPANY_LOCATION_ID = `gid://shopify/CompanyLocation/gated-${TEST_SUFFIX}`;
  const _TEST_NONGATED_COMPANY_LOCATION_ID = `gid://shopify/CompanyLocation/nongated-${TEST_SUFFIX}`;
  const TEST_CUSTOMER_ID = `gid://shopify/Customer/test-${TEST_SUFFIX}`;

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
        NULL, NULL, ${"gid://shopify/Customer/nongated-" + TEST_SUFFIX},
        'Non-Gated Account', 100000.00, 'OK', false, false, 30, 'explicit',
        false, 1, NOW(), NOW()
      )
    `;

    // Create s8_tagged_customers entry for email lookup
    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
      VALUES (${TEST_SHOP_ID}, ${TEST_CUSTOMER_ID}, 'buyer@test.com', 'Test Buyer', NOW())
      ON CONFLICT (shop_id, customer_id) DO NOTHING
    `;
  });

  afterAll(async () => {
    process.env.PLAN_GATING_ENFORCED = originalEnv;
    // Clean up in reverse order of creation
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${TEST_SHOP_ID}`;
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
    // Clean up invoices between tests
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Match" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
  });

  describe("1. Payment reminders - gating check", () => {
    it("getInvoiceForReminder returns buyerAccountGatedAt for gated account", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";

      const invoiceId = `inv-reminder-gated-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/reminder-gated-${TEST_SUFFIX}`;

      // Create invoice for gated account
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

    it("getInvoiceForReminder returns null buyerAccountGatedAt for non-gated account", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";

      const invoiceId = `inv-reminder-nongated-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/reminder-nongated-${TEST_SUFFIX}`;

      // Create invoice for non-gated account
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

    it("isAccountActive returns false for gated account with gating ON", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";

      const { isAccountActive } = await import("../gating.server");

      const gatedAt = new Date();
      expect(isAccountActive(gatedAt)).toBe(false);
    });

    it("isAccountActive returns true for gated account with gating OFF", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "0";

      // Need to re-import after changing env
      vi.resetModules();
      const { isAccountActive } = await import("../gating.server");

      const gatedAt = new Date();
      expect(isAccountActive(gatedAt)).toBe(true);
    });
  });

  describe("2. Credit-limit edits - isAccountActive check", () => {
    it("isAccountActive blocks gated accounts with gating ON", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";

      vi.resetModules();
      const { isAccountActive } = await import("../gating.server");

      // Get gated_at from the actual DB record
      const [account] = await sql<{ gated_at: Date | null }[]>`
        SELECT gated_at FROM "BuyerAccount" WHERE id = ${TEST_GATED_ACCOUNT_ID}
      `;

      expect(account.gated_at).not.toBeNull();
      expect(isAccountActive(account.gated_at)).toBe(false);
    });

    it("isAccountActive allows non-gated accounts with gating ON", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";

      vi.resetModules();
      const { isAccountActive } = await import("../gating.server");

      // Get gated_at from the actual DB record
      const [account] = await sql<{ gated_at: Date | null }[]>`
        SELECT gated_at FROM "BuyerAccount" WHERE id = ${TEST_NONGATED_ACCOUNT_ID}
      `;

      expect(account.gated_at).toBeNull();
      expect(isAccountActive(account.gated_at)).toBe(true);
    });

    it("isAccountActive allows gated accounts with gating OFF", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "0";

      vi.resetModules();
      const { isAccountActive } = await import("../gating.server");

      // Get gated_at from the actual DB record
      const [account] = await sql<{ gated_at: Date | null }[]>`
        SELECT gated_at FROM "BuyerAccount" WHERE id = ${TEST_GATED_ACCOUNT_ID}
      `;

      expect(account.gated_at).not.toBeNull();
      expect(isAccountActive(account.gated_at)).toBe(true);
    });
  });

  describe("3. Bulk import - checkImportLimit", () => {
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
    });
  });
});
