import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";

/**
 * S22 Migration Integration Test
 *
 * Verifies that the S22 migration creates the expected:
 * - FK constraints with ON DELETE CASCADE from s8 tables to Shop
 * - s22_data_requests table
 * - uninstalledAt column on Shop
 *
 * NOTE: This test requires a running PostgreSQL instance with the schema applied.
 * It will be skipped in CI if DATABASE_URL is not set.
 */

const DATABASE_URL = process.env.DATABASE_URL;

describe("S22 Migration Verification", () => {
  let sql: postgres.Sql | null = null;

  beforeAll(async () => {
    if (!DATABASE_URL) {
      console.log("Skipping S22 integration tests: DATABASE_URL not set");
      return;
    }

    sql = postgres(DATABASE_URL, {
      max: 1,
      connect_timeout: 5,
    });
  });

  afterAll(async () => {
    if (sql) {
      await sql.end();
    }
  });

  describe("FK Constraints", () => {
    it.skipIf(!DATABASE_URL)("s8_tagged_customers has FK to Shop with CASCADE", async () => {
      const [fk] = await sql!<{
        constraint_name: string;
        delete_rule: string;
      }[]>`
        SELECT 
          tc.constraint_name,
          rc.delete_rule
        FROM information_schema.table_constraints tc
        JOIN information_schema.referential_constraints rc
          ON tc.constraint_name = rc.constraint_name
        WHERE tc.table_name = 's8_tagged_customers'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND tc.constraint_name = 's8_tagged_customers_shop_fkey'
      `;

      expect(fk).toBeDefined();
      expect(fk.delete_rule).toBe("CASCADE");
    });

    it.skipIf(!DATABASE_URL)("s8_draft_orders has FK to Shop with CASCADE", async () => {
      const [fk] = await sql!<{
        constraint_name: string;
        delete_rule: string;
      }[]>`
        SELECT 
          tc.constraint_name,
          rc.delete_rule
        FROM information_schema.table_constraints tc
        JOIN information_schema.referential_constraints rc
          ON tc.constraint_name = rc.constraint_name
        WHERE tc.table_name = 's8_draft_orders'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND tc.constraint_name = 's8_draft_orders_shop_fkey'
      `;

      expect(fk).toBeDefined();
      expect(fk.delete_rule).toBe("CASCADE");
    });

    it.skipIf(!DATABASE_URL)("s22_data_requests has FK to Shop with CASCADE", async () => {
      const [fk] = await sql!<{
        constraint_name: string;
        delete_rule: string;
      }[]>`
        SELECT 
          tc.constraint_name,
          rc.delete_rule
        FROM information_schema.table_constraints tc
        JOIN information_schema.referential_constraints rc
          ON tc.constraint_name = rc.constraint_name
        WHERE tc.table_name = 's22_data_requests'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND tc.constraint_name = 's22_data_requests_shop_fkey'
      `;

      expect(fk).toBeDefined();
      expect(fk.delete_rule).toBe("CASCADE");
    });
  });

  describe("Schema Additions", () => {
    it.skipIf(!DATABASE_URL)("Shop table has uninstalledAt column", async () => {
      const [col] = await sql!<{ column_name: string }[]>`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'Shop'
          AND column_name = 'uninstalledAt'
      `;

      expect(col).toBeDefined();
    });

    it.skipIf(!DATABASE_URL)("s22_data_requests table exists with required columns", async () => {
      const columns = await sql!<{ column_name: string }[]>`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 's22_data_requests'
        ORDER BY ordinal_position
      `;

      const columnNames = columns.map((c) => c.column_name);
      expect(columnNames).toContain("id");
      expect(columnNames).toContain("shop_id");
      expect(columnNames).toContain("customer_gid");
      expect(columnNames).toContain("request_id");
      expect(columnNames).toContain("received_at");
      expect(columnNames).toContain("status");
      expect(columnNames).toContain("export_data");
    });
  });

  describe("Cascade Behavior", () => {
    it.skipIf(!DATABASE_URL)("deleting Shop cascades to s8_tagged_customers", async () => {
      const testShopDomain = `test-cascade-${Date.now()}.myshopify.com`;

      await sql!`
        INSERT INTO "Shop" (id, domain)
        VALUES ('shop-cascade-test', ${testShopDomain})
      `;

      await sql!`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, tags)
        VALUES ('shop-cascade-test', 'gid://shopify/Customer/999', '["test"]'::jsonb)
      `;

      const [before] = await sql!<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM s8_tagged_customers WHERE shop_id = 'shop-cascade-test'
      `;
      expect(parseInt(before.count, 10)).toBe(1);

      await sql!`DELETE FROM "Shop" WHERE id = 'shop-cascade-test'`;

      const [after] = await sql!<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM s8_tagged_customers WHERE shop_id = 'shop-cascade-test'
      `;
      expect(parseInt(after.count, 10)).toBe(0);
    });

    it.skipIf(!DATABASE_URL)("deleting Shop cascades to PayerAlias via BuyerAccount", async () => {
      const testId = Date.now();
      const testShopId = `shop-alias-cascade-${testId}`;
      const testAccountId = `account-alias-cascade-${testId}`;
      const testAliasId = `alias-cascade-${testId}`;
      const testShopDomain = `test-alias-cascade-${testId}.myshopify.com`;

      const now = new Date();

      await sql!`
        INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt")
        VALUES (${testShopId}, ${testShopDomain}, ${now}, ${now})
      `;

      await sql!`
        INSERT INTO "BuyerAccount" (id, "shopId", kind, name, "createdAt", "updatedAt")
        VALUES (${testAccountId}, ${testShopId}, 'TAGGED_CUSTOMER', 'Test Buyer', ${now}, ${now})
      `;

      await sql!`
        INSERT INTO "PayerAlias" (id, "buyerAccountId", "payerKey", "createdAt")
        VALUES (${testAliasId}, ${testAccountId}, 'test-payer-key', ${now})
      `;

      const [aliasBefore] = await sql!<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM "PayerAlias" WHERE id = ${testAliasId}
      `;
      expect(parseInt(aliasBefore.count, 10)).toBe(1);

      const [accountBefore] = await sql!<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM "BuyerAccount" WHERE id = ${testAccountId}
      `;
      expect(parseInt(accountBefore.count, 10)).toBe(1);

      await sql!`DELETE FROM "Shop" WHERE id = ${testShopId}`;

      const [aliasAfter] = await sql!<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM "PayerAlias" WHERE id = ${testAliasId}
      `;
      expect(parseInt(aliasAfter.count, 10)).toBe(0);

      const [accountAfter] = await sql!<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM "BuyerAccount" WHERE id = ${testAccountId}
      `;
      expect(parseInt(accountAfter.count, 10)).toBe(0);
    });
  });

  describe("Retention Purge SQL", () => {
    it.skipIf(!DATABASE_URL)("purges narration on old unmatched payments, preserves matched and amounts/UTR", async () => {
      const testId = Date.now();
      const testShopId = `shop-retention-${testId}`;
      const testImportId = `import-retention-${testId}`;
      const testShopDomain = `test-retention-${testId}.myshopify.com`;

      const now = new Date();
      const oldDate = new Date(now.getTime() - 200 * 24 * 60 * 60 * 1000); // 200 days ago
      const recentDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days ago

      // Create shop and import
      await sql!`
        INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt")
        VALUES (${testShopId}, ${testShopDomain}, ${now}, ${now})
      `;

      await sql!`
        INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
        VALUES (${testImportId}, ${testShopId}, 'test', 'test.csv', 3, ${now})
      `;

      // Payment 1: Old unmatched (should be purged)
      const oldUnmatchedId = `pay-old-unmatched-${testId}`;
      await sql!`
        INSERT INTO public."Payment" (id, "shopId", "importId", "valueDate", amount, utr, narration, "payerText", status, "createdAt", "updatedAt")
        VALUES (${oldUnmatchedId}, ${testShopId}, ${testImportId}, ${oldDate}, 1000.00, 'UTR001', 'OLD UNMATCHED NARRATION', 'OLD PAYER', 'unmatched', ${now}, ${now})
      `;

      // Payment 2: Recent unmatched (should NOT be purged)
      const recentUnmatchedId = `pay-recent-unmatched-${testId}`;
      await sql!`
        INSERT INTO public."Payment" (id, "shopId", "importId", "valueDate", amount, utr, narration, "payerText", status, "createdAt", "updatedAt")
        VALUES (${recentUnmatchedId}, ${testShopId}, ${testImportId}, ${recentDate}, 2000.00, 'UTR002', 'RECENT UNMATCHED NARRATION', 'RECENT PAYER', 'unmatched', ${now}, ${now})
      `;

      // Payment 3: Old matched (should NOT be purged - matched payments retain narration)
      const oldMatchedId = `pay-old-matched-${testId}`;
      await sql!`
        INSERT INTO public."Payment" (id, "shopId", "importId", "valueDate", amount, utr, narration, "payerText", status, "createdAt", "updatedAt")
        VALUES (${oldMatchedId}, ${testShopId}, ${testImportId}, ${oldDate}, 3000.00, 'UTR003', 'OLD MATCHED NARRATION', 'MATCHED PAYER', 'matched', ${now}, ${now})
      `;

      // Payment 4: Old unmatched with NULL narration (should NOT be touched)
      const oldNullNarrationId = `pay-old-null-${testId}`;
      await sql!`
        INSERT INTO public."Payment" (id, "shopId", "importId", "valueDate", amount, utr, narration, "payerText", status, "createdAt", "updatedAt")
        VALUES (${oldNullNarrationId}, ${testShopId}, ${testImportId}, ${oldDate}, 4000.00, 'UTR004', '', NULL, 'unmatched', ${now}, ${now})
      `;

      // Payment 5: Old unmatched already redacted (should NOT be touched)
      const oldRedactedId = `pay-old-redacted-${testId}`;
      await sql!`
        INSERT INTO public."Payment" (id, "shopId", "importId", "valueDate", amount, utr, narration, "payerText", status, "createdAt", "updatedAt")
        VALUES (${oldRedactedId}, ${testShopId}, ${testImportId}, ${oldDate}, 5000.00, 'UTR005', '[REDACTED]', NULL, 'unmatched', ${now}, ${now})
      `;

      // Run the purge SQL (same as the pg_cron job body, using 180 days directly for test)
      await sql!`
        UPDATE public."Payment"
        SET
          narration = '[RETENTION_PURGED]',
          "payerText" = NULL,
          "updatedAt" = NOW()
        WHERE status = 'unmatched'
          AND "valueDate" < NOW() - INTERVAL '180 days'
          AND narration IS NOT NULL
          AND narration IS DISTINCT FROM '[RETENTION_PURGED]'
          AND narration IS DISTINCT FROM '[REDACTED]'
          AND narration != ''
      `;

      // Verify old unmatched was purged
      const [oldUnmatched] = await sql!<{ narration: string; payerText: string | null; amount: string; utr: string }[]>`
        SELECT narration, "payerText", amount::text, utr FROM public."Payment" WHERE id = ${oldUnmatchedId}
      `;
      expect(oldUnmatched.narration).toBe('[RETENTION_PURGED]');
      expect(oldUnmatched.payerText).toBeNull();
      expect(oldUnmatched.amount).toBe('1000.00'); // Amount preserved
      expect(oldUnmatched.utr).toBe('UTR001'); // UTR preserved

      // Verify recent unmatched was NOT purged
      const [recentUnmatched] = await sql!<{ narration: string; payerText: string | null }[]>`
        SELECT narration, "payerText" FROM public."Payment" WHERE id = ${recentUnmatchedId}
      `;
      expect(recentUnmatched.narration).toBe('RECENT UNMATCHED NARRATION');
      expect(recentUnmatched.payerText).toBe('RECENT PAYER');

      // Verify old matched was NOT purged
      const [oldMatched] = await sql!<{ narration: string; payerText: string | null }[]>`
        SELECT narration, "payerText" FROM public."Payment" WHERE id = ${oldMatchedId}
      `;
      expect(oldMatched.narration).toBe('OLD MATCHED NARRATION');
      expect(oldMatched.payerText).toBe('MATCHED PAYER');

      // Verify old empty narration was NOT touched
      const [oldNull] = await sql!<{ narration: string; payerText: string | null }[]>`
        SELECT narration, "payerText" FROM public."Payment" WHERE id = ${oldNullNarrationId}
      `;
      expect(oldNull.narration).toBe('');
      expect(oldNull.payerText).toBeNull();

      // Verify already redacted was NOT touched
      const [oldRedacted] = await sql!<{ narration: string }[]>`
        SELECT narration FROM public."Payment" WHERE id = ${oldRedactedId}
      `;
      expect(oldRedacted.narration).toBe('[REDACTED]');

      // Cleanup
      await sql!`DELETE FROM "Shop" WHERE id = ${testShopId}`;
    });
  });
});
