/**
 * DB-backed integration tests for S18 buyer reminder opt-out (#232).
 *
 * Tests verify the shop-scoped opt-out helper functions:
 * - isBuyerOptedOut: check if buyer has opted out
 * - recordSkippedOptedOut: insert ReminderLog with status='skipped_opted_out'
 * - transitionDelayedToOptedOut: update delayed row to skipped_opted_out
 * - setBuyerOptOut: set opt-out on buyer account
 * - clearBuyerOptOut: clear opt-out (merchant re-enable)
 * - getBuyerOptOutStatus: get opt-out details
 *
 * These tests hit real Postgres and use the sequential DB project from vitest config.
 * They scope their own rows and do not truncate globally.
 *
 * Uses real safeLog (no vi.mock of log.server.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import {
  isBuyerOptedOut,
  recordSkippedOptedOut,
  transitionDelayedToOptedOut,
  setBuyerOptOut,
  clearBuyerOptOut,
  getBuyerOptOutStatus,
} from "../reminder-optout.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("S18 buyer reminder opt-out helpers (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-optout-db";
  const TEST_SHOP_ID = `shop-optout-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-s18-optout-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-optout-${TEST_SUFFIX}`;
  const TEST_CUSTOMER_ID = `gid://shopify/Customer/optout-${TEST_SUFFIX}`;
  const TEST_RULE_ID = `rule-optout-${TEST_SUFFIX}`;
  const TEST_INVOICE_ID = `inv-optout-${TEST_SUFFIX}`;
  const TEST_ORDER_ID = `gid://shopify/Order/optout-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create shop
    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', 'free', NOW(), NOW())
    `;

    // Create buyer account (initially opted IN, reminder_opt_out_at = NULL)
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "customerId", name,
        "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER',
        ${TEST_CUSTOMER_ID}, 'Opt-out Test Account', 100000.00, 'OK', false, false, 30, 'explicit',
        false, 1, NOW(), NOW()
      )
    `;

    // Create reminder rule
    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${TEST_RULE_ID}, ${TEST_SHOP_ID}, 0, 'email'::"ReminderChannel", true, NOW(), NOW())
    `;

    // Create invoice
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_INVOICE_ID}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${TEST_ORDER_ID},
        '#OPTOUT-TEST', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '5 days', NOW(), NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    // Reset buyer account to opted-in state
    await sql`
      UPDATE "BuyerAccount"
      SET "reminderOptOutAt" = NULL, "reminderOptOutSource" = NULL, "updatedAt" = NOW()
      WHERE id = ${TEST_ACCOUNT_ID} AND "shopId" = ${TEST_SHOP_ID}
    `;
    // Clear reminder logs
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${TEST_SHOP_ID}`;
  });

  describe("isBuyerOptedOut", () => {
    it("returns false when buyer is opted in (NULL opt-out fields)", async () => {
      const result = await isBuyerOptedOut(sql, TEST_SHOP_ID, TEST_ACCOUNT_ID);
      expect(result).toBe(false);
    });

    it("returns true when buyer is opted out", async () => {
      // Set opt-out
      await sql`
        UPDATE "BuyerAccount"
        SET "reminderOptOutAt" = NOW(), "reminderOptOutSource" = 'link'::"ReminderOptOutSource"
        WHERE id = ${TEST_ACCOUNT_ID} AND "shopId" = ${TEST_SHOP_ID}
      `;

      const result = await isBuyerOptedOut(sql, TEST_SHOP_ID, TEST_ACCOUNT_ID);
      expect(result).toBe(true);
    });

    it("returns false for non-existent account", async () => {
      const result = await isBuyerOptedOut(sql, TEST_SHOP_ID, "nonexistent-account");
      expect(result).toBe(false);
    });

    it("returns false when querying wrong shop (shop-scoped)", async () => {
      // Set opt-out on the correct shop
      await sql`
        UPDATE "BuyerAccount"
        SET "reminderOptOutAt" = NOW(), "reminderOptOutSource" = 'link'::"ReminderOptOutSource"
        WHERE id = ${TEST_ACCOUNT_ID} AND "shopId" = ${TEST_SHOP_ID}
      `;

      // Query with wrong shop ID should return false (account not found in that shop)
      const result = await isBuyerOptedOut(sql, "wrong-shop-id", TEST_ACCOUNT_ID);
      expect(result).toBe(false);
    });
  });

  describe("recordSkippedOptedOut", () => {
    it("inserts ReminderLog with status='skipped_opted_out' and sentAt=NULL", async () => {
      await recordSkippedOptedOut(sql, TEST_SHOP_ID, TEST_RULE_ID, TEST_INVOICE_ID);

      const [log] = await sql<{ status: string; sentAt: Date | null }[]>`
        SELECT status, "sentAt"
        FROM "ReminderLog"
        WHERE "shopId" = ${TEST_SHOP_ID} AND "ruleId" = ${TEST_RULE_ID} AND "invoiceId" = ${TEST_INVOICE_ID}
      `;

      expect(log).toBeDefined();
      expect(log.status).toBe("skipped_opted_out");
      expect(log.sentAt).toBeNull();
    });

    it("is idempotent (ON CONFLICT DO NOTHING)", async () => {
      await recordSkippedOptedOut(sql, TEST_SHOP_ID, TEST_RULE_ID, TEST_INVOICE_ID);
      await recordSkippedOptedOut(sql, TEST_SHOP_ID, TEST_RULE_ID, TEST_INVOICE_ID);

      const logs = await sql<{ id: string }[]>`
        SELECT id FROM "ReminderLog"
        WHERE "shopId" = ${TEST_SHOP_ID} AND "ruleId" = ${TEST_RULE_ID} AND "invoiceId" = ${TEST_INVOICE_ID}
      `;

      expect(logs.length).toBe(1);
    });

    it("prevents s18_enqueue_reminders Part 3 NOT EXISTS from re-enqueuing", async () => {
      // Record skipped_opted_out
      await recordSkippedOptedOut(sql, TEST_SHOP_ID, TEST_RULE_ID, TEST_INVOICE_ID);

      // Simulate Part 3's NOT EXISTS check
      const [exists] = await sql<{ found: boolean }[]>`
        SELECT EXISTS(
          SELECT 1 FROM "ReminderLog" rl
          WHERE rl."ruleId" = ${TEST_RULE_ID} AND rl."invoiceId" = ${TEST_INVOICE_ID}
        ) AS found
      `;

      expect(exists.found).toBe(true);
    });
  });

  describe("transitionDelayedToOptedOut", () => {
    it("updates delayed row to skipped_opted_out", async () => {
      // Create delayed row
      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID}, ${TEST_INVOICE_ID}, 'delayed'::"ReminderLogStatus", NOW())
      `;

      const result = await transitionDelayedToOptedOut(sql, TEST_SHOP_ID, TEST_RULE_ID, TEST_INVOICE_ID);
      expect(result).toBe(true);

      const [log] = await sql<{ status: string }[]>`
        SELECT status FROM "ReminderLog"
        WHERE "shopId" = ${TEST_SHOP_ID} AND "ruleId" = ${TEST_RULE_ID} AND "invoiceId" = ${TEST_INVOICE_ID}
      `;

      expect(log.status).toBe("skipped_opted_out");
    });

    it("returns false when no delayed row exists", async () => {
      const result = await transitionDelayedToOptedOut(sql, TEST_SHOP_ID, TEST_RULE_ID, TEST_INVOICE_ID);
      expect(result).toBe(false);
    });

    it("does not update sent rows", async () => {
      // Create sent row
      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "sentAt")
        VALUES (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID}, ${TEST_INVOICE_ID}, 'sent'::"ReminderLogStatus", NOW())
      `;

      const result = await transitionDelayedToOptedOut(sql, TEST_SHOP_ID, TEST_RULE_ID, TEST_INVOICE_ID);
      expect(result).toBe(false);

      const [log] = await sql<{ status: string }[]>`
        SELECT status FROM "ReminderLog"
        WHERE "shopId" = ${TEST_SHOP_ID} AND "ruleId" = ${TEST_RULE_ID} AND "invoiceId" = ${TEST_INVOICE_ID}
      `;

      expect(log.status).toBe("sent");
    });

    it("is shop-scoped (does not affect other shops)", async () => {
      // Create delayed row
      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID}, ${TEST_INVOICE_ID}, 'delayed'::"ReminderLogStatus", NOW())
      `;

      // Try to transition with wrong shop ID
      const result = await transitionDelayedToOptedOut(sql, "wrong-shop-id", TEST_RULE_ID, TEST_INVOICE_ID);
      expect(result).toBe(false);

      // Original row should still be delayed
      const [log] = await sql<{ status: string }[]>`
        SELECT status FROM "ReminderLog"
        WHERE "shopId" = ${TEST_SHOP_ID} AND "ruleId" = ${TEST_RULE_ID} AND "invoiceId" = ${TEST_INVOICE_ID}
      `;

      expect(log.status).toBe("delayed");
    });
  });

  describe("setBuyerOptOut", () => {
    it("sets opt-out with source='link'", async () => {
      const result = await setBuyerOptOut(sql, TEST_SHOP_ID, TEST_ACCOUNT_ID, "link");
      expect(result).toBe(true);

      const [account] = await sql<{ optOutAt: Date; optOutSource: string }[]>`
        SELECT "reminderOptOutAt" AS "optOutAt", "reminderOptOutSource" AS "optOutSource"
        FROM "BuyerAccount"
        WHERE id = ${TEST_ACCOUNT_ID} AND "shopId" = ${TEST_SHOP_ID}
      `;

      expect(account.optOutAt).toBeInstanceOf(Date);
      expect(account.optOutSource).toBe("link");
    });

    it("sets opt-out with source='merchant'", async () => {
      const result = await setBuyerOptOut(sql, TEST_SHOP_ID, TEST_ACCOUNT_ID, "merchant");
      expect(result).toBe(true);

      const [account] = await sql<{ optOutSource: string }[]>`
        SELECT "reminderOptOutSource" AS "optOutSource"
        FROM "BuyerAccount"
        WHERE id = ${TEST_ACCOUNT_ID} AND "shopId" = ${TEST_SHOP_ID}
      `;

      expect(account.optOutSource).toBe("merchant");
    });

    it("is idempotent (does not update if already opted out)", async () => {
      // First opt-out via link
      await setBuyerOptOut(sql, TEST_SHOP_ID, TEST_ACCOUNT_ID, "link");

      const [before] = await sql<{ optOutAt: Date }[]>`
        SELECT "reminderOptOutAt" AS "optOutAt"
        FROM "BuyerAccount"
        WHERE id = ${TEST_ACCOUNT_ID} AND "shopId" = ${TEST_SHOP_ID}
      `;

      // Try to opt-out again via merchant - should return false
      const result = await setBuyerOptOut(sql, TEST_SHOP_ID, TEST_ACCOUNT_ID, "merchant");
      expect(result).toBe(false);

      // Timestamp should be unchanged
      const [after] = await sql<{ optOutAt: Date; optOutSource: string }[]>`
        SELECT "reminderOptOutAt" AS "optOutAt", "reminderOptOutSource" AS "optOutSource"
        FROM "BuyerAccount"
        WHERE id = ${TEST_ACCOUNT_ID} AND "shopId" = ${TEST_SHOP_ID}
      `;

      expect(after.optOutAt.getTime()).toBe(before.optOutAt.getTime());
      expect(after.optOutSource).toBe("link"); // Source unchanged
    });

    it("returns false for non-existent account", async () => {
      const result = await setBuyerOptOut(sql, TEST_SHOP_ID, "nonexistent-account", "link");
      expect(result).toBe(false);
    });

    it("is shop-scoped (does not affect other shops)", async () => {
      // Try to set opt-out with wrong shop ID
      const result = await setBuyerOptOut(sql, "wrong-shop-id", TEST_ACCOUNT_ID, "link");
      expect(result).toBe(false);

      // Original account should still be opted in
      const isOptedOut = await isBuyerOptedOut(sql, TEST_SHOP_ID, TEST_ACCOUNT_ID);
      expect(isOptedOut).toBe(false);
    });
  });

  describe("clearBuyerOptOut", () => {
    it("clears opt-out (merchant re-enable)", async () => {
      // First set opt-out
      await setBuyerOptOut(sql, TEST_SHOP_ID, TEST_ACCOUNT_ID, "link");
      expect(await isBuyerOptedOut(sql, TEST_SHOP_ID, TEST_ACCOUNT_ID)).toBe(true);

      // Clear opt-out
      const result = await clearBuyerOptOut(sql, TEST_SHOP_ID, TEST_ACCOUNT_ID);
      expect(result).toBe(true);

      // Should now be opted in
      expect(await isBuyerOptedOut(sql, TEST_SHOP_ID, TEST_ACCOUNT_ID)).toBe(false);

      // Fields should be NULL
      const [account] = await sql<{ optOutAt: Date | null; optOutSource: string | null }[]>`
        SELECT "reminderOptOutAt" AS "optOutAt", "reminderOptOutSource" AS "optOutSource"
        FROM "BuyerAccount"
        WHERE id = ${TEST_ACCOUNT_ID} AND "shopId" = ${TEST_SHOP_ID}
      `;

      expect(account.optOutAt).toBeNull();
      expect(account.optOutSource).toBeNull();
    });

    it("returns false when already opted in", async () => {
      // Account is already opted in (default state)
      const result = await clearBuyerOptOut(sql, TEST_SHOP_ID, TEST_ACCOUNT_ID);
      expect(result).toBe(false);
    });

    it("is shop-scoped (does not affect other shops)", async () => {
      // Set opt-out
      await setBuyerOptOut(sql, TEST_SHOP_ID, TEST_ACCOUNT_ID, "link");

      // Try to clear with wrong shop ID
      const result = await clearBuyerOptOut(sql, "wrong-shop-id", TEST_ACCOUNT_ID);
      expect(result).toBe(false);

      // Original account should still be opted out
      expect(await isBuyerOptedOut(sql, TEST_SHOP_ID, TEST_ACCOUNT_ID)).toBe(true);
    });
  });

  describe("getBuyerOptOutStatus", () => {
    it("returns optedOut=false for opted-in account", async () => {
      const status = await getBuyerOptOutStatus(sql, TEST_SHOP_ID, TEST_ACCOUNT_ID);

      expect(status).not.toBeNull();
      expect(status!.optedOut).toBe(false);
      expect(status!.optOutAt).toBeNull();
      expect(status!.optOutSource).toBeNull();
    });

    it("returns optedOut=true with details for opted-out account", async () => {
      await setBuyerOptOut(sql, TEST_SHOP_ID, TEST_ACCOUNT_ID, "link");

      const status = await getBuyerOptOutStatus(sql, TEST_SHOP_ID, TEST_ACCOUNT_ID);

      expect(status).not.toBeNull();
      expect(status!.optedOut).toBe(true);
      expect(status!.optOutAt).toBeInstanceOf(Date);
      expect(status!.optOutSource).toBe("link");
    });

    it("returns null for non-existent account", async () => {
      const status = await getBuyerOptOutStatus(sql, TEST_SHOP_ID, "nonexistent-account");
      expect(status).toBeNull();
    });

    it("returns null when querying wrong shop (shop-scoped)", async () => {
      const status = await getBuyerOptOutStatus(sql, "wrong-shop-id", TEST_ACCOUNT_ID);
      expect(status).toBeNull();
    });
  });

  describe("CHECK constraint: skipped_opted_out requires sentAt IS NULL", () => {
    it("allows inserting skipped_opted_out with sentAt NULL", async () => {
      // This should succeed
      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "sentAt")
        VALUES (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID}, ${TEST_INVOICE_ID}, 'skipped_opted_out'::"ReminderLogStatus", NULL)
      `;

      const [log] = await sql<{ status: string; sentAt: Date | null }[]>`
        SELECT status, "sentAt" FROM "ReminderLog"
        WHERE "shopId" = ${TEST_SHOP_ID} AND "ruleId" = ${TEST_RULE_ID} AND "invoiceId" = ${TEST_INVOICE_ID}
      `;

      expect(log.status).toBe("skipped_opted_out");
      expect(log.sentAt).toBeNull();
    });

    it("rejects inserting skipped_opted_out with sentAt NOT NULL", async () => {
      await expect(
        sql`
          INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "sentAt")
          VALUES (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID}, ${TEST_INVOICE_ID}, 'skipped_opted_out'::"ReminderLogStatus", NOW())
        `
      ).rejects.toThrow(/ReminderLog_status_skipped_opted_out_check/);
    });
  });

  describe("Migration backfill: existing accounts remain opted-in", () => {
    it("existing account has NULL opt-out fields (unchanged count)", async () => {
      // The account was created in beforeAll without opt-out fields
      // After migration, it should have NULL values (opted in)
      const [account] = await sql<{ optOutAt: Date | null; optOutSource: string | null }[]>`
        SELECT "reminderOptOutAt" AS "optOutAt", "reminderOptOutSource" AS "optOutSource"
        FROM "BuyerAccount"
        WHERE id = ${TEST_ACCOUNT_ID} AND "shopId" = ${TEST_SHOP_ID}
      `;

      expect(account.optOutAt).toBeNull();
      expect(account.optOutSource).toBeNull();
    });
  });
});
