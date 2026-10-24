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
import { requestContext } from "~/lib/request-context.server";

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
  const TEST_RULE_ID = `rule-gating-${TEST_SUFFIX}`;

  // Snapshot for s18_global_sends restoration
  let globalSendsSnapshot: { send_key: string; send_date: string; send_month: string; daily_count: number }[] = [];

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Snapshot existing global sends before tests
    globalSendsSnapshot = await sql<typeof globalSendsSnapshot>`
      SELECT send_key, send_date::TEXT, send_month, daily_count
      FROM s18_global_sends WHERE send_key = 'global'
    `;

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

    // Create a real reminder rule for testing sendPaymentReminder
    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${TEST_RULE_ID}, ${TEST_SHOP_ID}, 0, 'email'::"ReminderChannel", true, NOW(), NOW())
    `;
  });

  afterAll(async () => {
    process.env.PLAN_GATING_ENFORCED = originalEnv;

    // Clean up in reverse order of creation
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${TEST_SHOP_ID}`;

    // Restore s18_global_sends to original state instead of deleting
    const todayStr = new Date().toISOString().split("T")[0];
    // Delete rows added by this test, but only for today
    await sql`
      DELETE FROM s18_global_sends 
      WHERE send_key = 'global' 
        AND send_date = ${todayStr}::DATE
        AND NOT EXISTS (
          SELECT 1 FROM unnest(${globalSendsSnapshot.map(r => r.send_date)}::DATE[]) AS orig
          WHERE orig = s18_global_sends.send_date
        )
    `;
    // Restore original counts for any pre-existing rows
    for (const row of globalSendsSnapshot) {
      await sql`
        UPDATE s18_global_sends 
        SET daily_count = ${row.daily_count}
        WHERE send_key = ${row.send_key} AND send_date = ${row.send_date}::DATE
      `;
    }

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
    await sql`DELETE FROM "Match" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
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

      // Mock send window to be within hours
      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);

      try {
        const result = await sendPaymentReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID,
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
      } finally {
        luxonSpy.mockRestore();
      }
    });

    it("sends reminder for non-gated account with gating ON - ReminderLog created, cap consumed, fetch called", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();

      const invoiceId = `inv-send-nongated-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/send-nongated-${TEST_SUFFIX}`;

      // Create invoice for non-gated account - due today for offset=0
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

      const { getGlobalSendCounts, sendPaymentReminder } = await import("../reminders.server");
      const countsBefore = await getGlobalSendCounts(sql);

      // Mock send window
      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);

      // Mock successful Resend response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "email-nongated-123" }),
      });

      try {
        const result = await sendPaymentReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID,
          0,
          "Asia/Kolkata",
          validEnv
        );

        // Should be sent
        expect(result.success).toBe(true);
        expect(result.action).toBe("sent");
        expect(result.resendId).toBe("email-nongated-123");

        // ReminderLog row should be created
        const [logRow] = await sql<{ id: string }[]>`
          SELECT id FROM "ReminderLog"
          WHERE "shopId" = ${TEST_SHOP_ID} AND "invoiceId" = ${invoiceId}
        `;
        expect(logRow).toBeDefined();

        // Cap slot consumed
        const countsAfter = await getGlobalSendCounts(sql);
        expect(countsAfter.daily).toBe(countsBefore.daily + 1);

        // Exactly one fetch call
        expect(mockFetch).toHaveBeenCalledTimes(1);
      } finally {
        luxonSpy.mockRestore();
      }
    });

    it("sends reminder for gated account with gating OFF (passes Gate 3)", async () => {
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
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);

      // Mock successful Resend response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "email-gated-off-123" }),
      });

      try {
        const result = await sendPaymentReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID,
          0,
          "Asia/Kolkata",
          validEnv
        );

        // With gating OFF, gated account should pass Gate 3 and send
        expect(result.success).toBe(true);
        expect(result.action).toBe("sent");
        expect(mockFetch).toHaveBeenCalledTimes(1);
      } finally {
        luxonSpy.mockRestore();
      }
    });
  });

  describe("3. isAccountActive helper (from gating.server.ts)", () => {
    it("returns false for gated account when gating ON", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();

      // Re-import after env change
      const gating = await import("../gating.server");

      const [account] = await sql<{ gated_at: Date | null }[]>`
        SELECT gated_at FROM "BuyerAccount" WHERE id = ${TEST_GATED_ACCOUNT_ID}
      `;

      expect(account.gated_at).not.toBeNull();
      expect(gating.isAccountActive(account.gated_at)).toBe(false);
    });

    it("returns true for non-gated account when gating ON", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();

      const gating = await import("../gating.server");

      const [account] = await sql<{ gated_at: Date | null }[]>`
        SELECT gated_at FROM "BuyerAccount" WHERE id = ${TEST_NONGATED_ACCOUNT_ID}
      `;

      expect(account.gated_at).toBeNull();
      expect(gating.isAccountActive(account.gated_at)).toBe(true);
    });

    it("returns true for gated account when gating OFF", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "0";
      vi.resetModules();

      const gating = await import("../gating.server");

      const [account] = await sql<{ gated_at: Date | null }[]>`
        SELECT gated_at FROM "BuyerAccount" WHERE id = ${TEST_GATED_ACCOUNT_ID}
      `;

      expect(account.gated_at).not.toBeNull();
      expect(gating.isAccountActive(account.gated_at)).toBe(true);
    });
  });

  describe("4. Bulk import - checkImportLimit with real DB", () => {
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

      // Save original holdState for restoration
      const [originalAccount] = await sql<{ holdState: string; holdReasonCode: string | null }[]>`
        SELECT "holdState", "holdReasonCode" FROM "BuyerAccount" WHERE id = ${TEST_GATED_ACCOUNT_ID}
      `;

      try {
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
      } finally {
        // Restore original holdState
        await sql`
          UPDATE "BuyerAccount"
          SET "holdState" = ${originalAccount.holdState}, "holdReasonCode" = ${originalAccount.holdReasonCode}
          WHERE id = ${TEST_GATED_ACCOUNT_ID}
        `;
      }
    });
  });

  describe("5. app.accounts.$id action - credit-limit and account-details gating", () => {
    /**
     * Create a mock FormData request for the accounts action.
     */
    function createAccountsRequest(formFields: Record<string, string>, accountId: string): Request {
      const formData = new URLSearchParams();
      for (const [key, value] of Object.entries(formFields)) {
        formData.append(key, value);
      }
      return new Request(`http://localhost/app/accounts/${accountId}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData.toString(),
      });
    }

    /**
     * Create mock Shopify context with authenticated session.
     */
    function createMockContext(shopDomain: string) {
      return {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: shopDomain },
            }),
          },
        },
      };
    }

    /**
     * Call the real accounts action inside request context.
     */
    async function callAccountsAction(
      testSql: ReturnType<typeof postgres>,
      shopDomain: string,
      accountId: string,
      formFields: Record<string, string>
    ): Promise<{ success: boolean; error?: string }> {
      const request = createAccountsRequest(formFields, accountId);
      const context = createMockContext(shopDomain);
      const url = new URL(request.url);

      // Import the action inside the test to avoid import chain issues
      const { action } = await import("~/routes/app.accounts.$id");

      return requestContext.run({ getSql: () => testSql }, async () => {
        const result = await action({
          request,
          context: context as never,
          params: { id: accountId },
          url,
          pattern: "/app/accounts/:id",
        });
        return result as { success: boolean; error?: string };
      });
    }

    it("rejects credit-limit edit on gated account when gating ON", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();

      // Save original credit limit for verification
      const [originalAccount] = await sql<{ creditLimit: string }[]>`
        SELECT "creditLimit"::TEXT FROM "BuyerAccount" WHERE id = ${TEST_GATED_ACCOUNT_ID}
      `;

      const result = await callAccountsAction(sql, TEST_SHOP_DOMAIN, TEST_GATED_ACCOUNT_ID, {
        _action: "updateCredit",
        creditLimit: "200000",
      });

      // Should be rejected
      expect(result.success).toBe(false);
      expect(result.error).toContain("Cannot edit gated accounts");

      // DB row should be unchanged
      const [afterAccount] = await sql<{ creditLimit: string }[]>`
        SELECT "creditLimit"::TEXT FROM "BuyerAccount" WHERE id = ${TEST_GATED_ACCOUNT_ID}
      `;
      expect(afterAccount.creditLimit).toBe(originalAccount.creditLimit);
    });

    it("allows credit-limit edit on non-gated account when gating ON", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();

      // Mock shopify client for metafield write (required by updateCreditStatus)
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

      const result = await callAccountsAction(sql, TEST_SHOP_DOMAIN, TEST_NONGATED_ACCOUNT_ID, {
        _action: "updateCredit",
        creditLimit: "200000",
      });

      // Should succeed
      expect(result.success).toBe(true);

      // DB row should be updated
      const [afterAccount] = await sql<{ creditLimit: string }[]>`
        SELECT "creditLimit"::TEXT FROM "BuyerAccount" WHERE id = ${TEST_NONGATED_ACCOUNT_ID}
      `;
      expect(afterAccount.creditLimit).toBe("200000.00");

      // Restore original credit limit
      await sql`
        UPDATE "BuyerAccount" SET "creditLimit" = 100000.00 WHERE id = ${TEST_NONGATED_ACCOUNT_ID}
      `;
    });

    it("allows credit-limit edit on gated account when gating OFF", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "0";
      vi.resetModules();

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

      const result = await callAccountsAction(sql, TEST_SHOP_DOMAIN, TEST_GATED_ACCOUNT_ID, {
        _action: "updateCredit",
        creditLimit: "150000",
      });

      // Should succeed when gating is OFF
      expect(result.success).toBe(true);

      // Restore original credit limit
      await sql`
        UPDATE "BuyerAccount" SET "creditLimit" = 100000.00 WHERE id = ${TEST_GATED_ACCOUNT_ID}
      `;
    });

    it("rejects hold update on gated account when gating ON", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();

      // Save original state
      const [originalAccount] = await sql<{ manualHold: boolean }[]>`
        SELECT "manualHold" FROM "BuyerAccount" WHERE id = ${TEST_GATED_ACCOUNT_ID}
      `;

      const result = await callAccountsAction(sql, TEST_SHOP_DOMAIN, TEST_GATED_ACCOUNT_ID, {
        _action: "updateCredit",
        holdOnly: "true",
        manualHold: "true",
        holdReasonCode: "MANUAL_HOLD",
      });

      // Should be rejected
      expect(result.success).toBe(false);
      expect(result.error).toContain("Cannot edit gated accounts");

      // DB row should be unchanged
      const [afterAccount] = await sql<{ manualHold: boolean }[]>`
        SELECT "manualHold" FROM "BuyerAccount" WHERE id = ${TEST_GATED_ACCOUNT_ID}
      `;
      expect(afterAccount.manualHold).toBe(originalAccount.manualHold);
    });
  });
});
