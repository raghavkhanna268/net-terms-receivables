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

      const testCustomerId = `gid://shopify/Customer/${testId}`;

      await sql!`
        INSERT INTO "BuyerAccount" (id, "shopId", kind, name, "customerId", "createdAt", "updatedAt")
        VALUES (${testAccountId}, ${testShopId}, 'TAGGED_CUSTOMER', 'Test Buyer', ${testCustomerId}, ${now}, ${now})
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

    it.skipIf(!DATABASE_URL)("deleting Shop A cascades Payment, Match, RejectedMatch, Invoice while leaving Shop B intact", async () => {
      const testId = Date.now();
      const now = new Date();

      // Shop A - will be deleted
      const shopAId = `shop-a-cascade-${testId}`;
      const shopADomain = `shop-a-cascade-${testId}.myshopify.com`;
      const accountAId = `account-a-cascade-${testId}`;
      const importAId = `import-a-cascade-${testId}`;
      const invoiceAId = `invoice-a-cascade-${testId}`;
      const paymentAId = `payment-a-cascade-${testId}`;
      const matchAId = `match-a-cascade-${testId}`;
      const rejectedMatchAId = `rejected-a-cascade-${testId}`;
      const aliasAId = `alias-a-cascade-${testId}`;

      // Shop B - should remain intact
      const shopBId = `shop-b-cascade-${testId}`;
      const shopBDomain = `shop-b-cascade-${testId}.myshopify.com`;
      const accountBId = `account-b-cascade-${testId}`;
      const importBId = `import-b-cascade-${testId}`;
      const invoiceBId = `invoice-b-cascade-${testId}`;
      const paymentBId = `payment-b-cascade-${testId}`;
      const matchBId = `match-b-cascade-${testId}`;
      const rejectedMatchBId = `rejected-b-cascade-${testId}`;
      const aliasBId = `alias-b-cascade-${testId}`;

      // Create Shop A
      await sql!`
        INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt")
        VALUES (${shopAId}, ${shopADomain}, ${now}, ${now})
      `;

      // Create Shop B
      await sql!`
        INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt")
        VALUES (${shopBId}, ${shopBDomain}, ${now}, ${now})
      `;

      const customerGid = `gid://shopify/Customer/${testId}`;

      // Create BuyerAccounts
      await sql!`
        INSERT INTO "BuyerAccount" (id, "shopId", kind, name, "customerId", "createdAt", "updatedAt")
        VALUES (${accountAId}, ${shopAId}, 'TAGGED_CUSTOMER', 'Buyer A', ${customerGid}, ${now}, ${now})
      `;
      await sql!`
        INSERT INTO "BuyerAccount" (id, "shopId", kind, name, "customerId", "createdAt", "updatedAt")
        VALUES (${accountBId}, ${shopBId}, 'TAGGED_CUSTOMER', 'Buyer B', ${customerGid}, ${now}, ${now})
      `;

      // Create BankImports
      await sql!`
        INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
        VALUES (${importAId}, ${shopAId}, 'test', 'test-a.csv', 1, ${now})
      `;
      await sql!`
        INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
        VALUES (${importBId}, ${shopBId}, 'test', 'test-b.csv', 1, ${now})
      `;

      // Create Invoices
      await sql!`
        INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status, "issuedAt", "createdAt", "updatedAt")
        VALUES (${invoiceAId}, ${shopAId}, ${accountAId}, ${'gid://shopify/Order/a-' + testId}, '#A001', 1000.00, 1000.00, 'open', ${now}, ${now}, ${now})
      `;
      await sql!`
        INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status, "issuedAt", "createdAt", "updatedAt")
        VALUES (${invoiceBId}, ${shopBId}, ${accountBId}, ${'gid://shopify/Order/b-' + testId}, '#B001', 1000.00, 1000.00, 'open', ${now}, ${now}, ${now})
      `;

      // Create Payments
      await sql!`
        INSERT INTO "Payment" (id, "shopId", "importId", "valueDate", amount, rail, narration, status, "createdAt", "updatedAt")
        VALUES (${paymentAId}, ${shopAId}, ${importAId}, ${now}, 1000.00, 'NEFT', 'Payment A', 'unmatched', ${now}, ${now})
      `;
      await sql!`
        INSERT INTO "Payment" (id, "shopId", "importId", "valueDate", amount, rail, narration, status, "createdAt", "updatedAt")
        VALUES (${paymentBId}, ${shopBId}, ${importBId}, ${now}, 1000.00, 'NEFT', 'Payment B', 'unmatched', ${now}, ${now})
      `;

      // Create Matches
      await sql!`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${matchAId}, ${shopAId}, ${paymentAId}, ${invoiceAId}, 1000.00, 100, '[]'::jsonb, 'confirmed', ${now}, ${now})
      `;
      await sql!`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${matchBId}, ${shopBId}, ${paymentBId}, ${invoiceBId}, 1000.00, 100, '[]'::jsonb, 'confirmed', ${now}, ${now})
      `;

      // Create RejectedMatches (table is @@map to rejected_matches, columns stay camelCase)
      await sql!`
        INSERT INTO rejected_matches (id, "shopId", "paymentId", "invoiceId", "rejectedBy", "rejectedAt")
        VALUES (${rejectedMatchAId}, ${shopAId}, ${paymentAId}, ${invoiceAId}, 'user-a', ${now})
      `;
      await sql!`
        INSERT INTO rejected_matches (id, "shopId", "paymentId", "invoiceId", "rejectedBy", "rejectedAt")
        VALUES (${rejectedMatchBId}, ${shopBId}, ${paymentBId}, ${invoiceBId}, 'user-b', ${now})
      `;

      // Create PayerAliases
      await sql!`
        INSERT INTO "PayerAlias" (id, "buyerAccountId", "payerKey", "createdAt")
        VALUES (${aliasAId}, ${accountAId}, 'payer-key-a', ${now})
      `;
      await sql!`
        INSERT INTO "PayerAlias" (id, "buyerAccountId", "payerKey", "createdAt")
        VALUES (${aliasBId}, ${accountBId}, 'payer-key-b', ${now})
      `;

      // Verify all data exists before deletion
      const [countsBefore] = await sql!<{
        shopA: string;
        shopB: string;
        paymentA: string;
        paymentB: string;
        matchA: string;
        matchB: string;
        rejectedA: string;
        rejectedB: string;
        aliasA: string;
        aliasB: string;
        invoiceA: string;
        invoiceB: string;
        accountA: string;
        accountB: string;
      }[]>`
        SELECT
          (SELECT COUNT(*)::text FROM "Shop" WHERE id = ${shopAId}) as "shopA",
          (SELECT COUNT(*)::text FROM "Shop" WHERE id = ${shopBId}) as "shopB",
          (SELECT COUNT(*)::text FROM "Payment" WHERE id = ${paymentAId}) as "paymentA",
          (SELECT COUNT(*)::text FROM "Payment" WHERE id = ${paymentBId}) as "paymentB",
          (SELECT COUNT(*)::text FROM "Match" WHERE id = ${matchAId}) as "matchA",
          (SELECT COUNT(*)::text FROM "Match" WHERE id = ${matchBId}) as "matchB",
          (SELECT COUNT(*)::text FROM rejected_matches WHERE id = ${rejectedMatchAId}) as "rejectedA",
          (SELECT COUNT(*)::text FROM rejected_matches WHERE id = ${rejectedMatchBId}) as "rejectedB",
          (SELECT COUNT(*)::text FROM "PayerAlias" WHERE id = ${aliasAId}) as "aliasA",
          (SELECT COUNT(*)::text FROM "PayerAlias" WHERE id = ${aliasBId}) as "aliasB",
          (SELECT COUNT(*)::text FROM "Invoice" WHERE id = ${invoiceAId}) as "invoiceA",
          (SELECT COUNT(*)::text FROM "Invoice" WHERE id = ${invoiceBId}) as "invoiceB",
          (SELECT COUNT(*)::text FROM "BuyerAccount" WHERE id = ${accountAId}) as "accountA",
          (SELECT COUNT(*)::text FROM "BuyerAccount" WHERE id = ${accountBId}) as "accountB"
      `;

      expect(parseInt(countsBefore.shopA, 10)).toBe(1);
      expect(parseInt(countsBefore.shopB, 10)).toBe(1);
      expect(parseInt(countsBefore.paymentA, 10)).toBe(1);
      expect(parseInt(countsBefore.paymentB, 10)).toBe(1);
      expect(parseInt(countsBefore.matchA, 10)).toBe(1);
      expect(parseInt(countsBefore.matchB, 10)).toBe(1);
      expect(parseInt(countsBefore.rejectedA, 10)).toBe(1);
      expect(parseInt(countsBefore.rejectedB, 10)).toBe(1);
      expect(parseInt(countsBefore.aliasA, 10)).toBe(1);
      expect(parseInt(countsBefore.aliasB, 10)).toBe(1);
      expect(parseInt(countsBefore.invoiceA, 10)).toBe(1);
      expect(parseInt(countsBefore.invoiceB, 10)).toBe(1);
      expect(parseInt(countsBefore.accountA, 10)).toBe(1);
      expect(parseInt(countsBefore.accountB, 10)).toBe(1);

      // Delete Shop A
      await sql!`DELETE FROM "Shop" WHERE id = ${shopAId}`;

      // Verify Shop A's data is cascaded
      const [countsAfter] = await sql!<{
        shopA: string;
        shopB: string;
        paymentA: string;
        paymentB: string;
        matchA: string;
        matchB: string;
        rejectedA: string;
        rejectedB: string;
        aliasA: string;
        aliasB: string;
        invoiceA: string;
        invoiceB: string;
        accountA: string;
        accountB: string;
      }[]>`
        SELECT
          (SELECT COUNT(*)::text FROM "Shop" WHERE id = ${shopAId}) as "shopA",
          (SELECT COUNT(*)::text FROM "Shop" WHERE id = ${shopBId}) as "shopB",
          (SELECT COUNT(*)::text FROM "Payment" WHERE id = ${paymentAId}) as "paymentA",
          (SELECT COUNT(*)::text FROM "Payment" WHERE id = ${paymentBId}) as "paymentB",
          (SELECT COUNT(*)::text FROM "Match" WHERE id = ${matchAId}) as "matchA",
          (SELECT COUNT(*)::text FROM "Match" WHERE id = ${matchBId}) as "matchB",
          (SELECT COUNT(*)::text FROM rejected_matches WHERE id = ${rejectedMatchAId}) as "rejectedA",
          (SELECT COUNT(*)::text FROM rejected_matches WHERE id = ${rejectedMatchBId}) as "rejectedB",
          (SELECT COUNT(*)::text FROM "PayerAlias" WHERE id = ${aliasAId}) as "aliasA",
          (SELECT COUNT(*)::text FROM "PayerAlias" WHERE id = ${aliasBId}) as "aliasB",
          (SELECT COUNT(*)::text FROM "Invoice" WHERE id = ${invoiceAId}) as "invoiceA",
          (SELECT COUNT(*)::text FROM "Invoice" WHERE id = ${invoiceBId}) as "invoiceB",
          (SELECT COUNT(*)::text FROM "BuyerAccount" WHERE id = ${accountAId}) as "accountA",
          (SELECT COUNT(*)::text FROM "BuyerAccount" WHERE id = ${accountBId}) as "accountB"
      `;

      // Shop A's data should be deleted
      expect(parseInt(countsAfter.shopA, 10)).toBe(0);
      expect(parseInt(countsAfter.paymentA, 10)).toBe(0);
      expect(parseInt(countsAfter.matchA, 10)).toBe(0);
      expect(parseInt(countsAfter.rejectedA, 10)).toBe(0);
      expect(parseInt(countsAfter.aliasA, 10)).toBe(0);
      expect(parseInt(countsAfter.invoiceA, 10)).toBe(0);
      expect(parseInt(countsAfter.accountA, 10)).toBe(0);

      // Shop B's data should remain intact
      expect(parseInt(countsAfter.shopB, 10)).toBe(1);
      expect(parseInt(countsAfter.paymentB, 10)).toBe(1);
      expect(parseInt(countsAfter.matchB, 10)).toBe(1);
      expect(parseInt(countsAfter.rejectedB, 10)).toBe(1);
      expect(parseInt(countsAfter.aliasB, 10)).toBe(1);
      expect(parseInt(countsAfter.invoiceB, 10)).toBe(1);
      expect(parseInt(countsAfter.accountB, 10)).toBe(1);

      // Cleanup Shop B
      await sql!`DELETE FROM "Shop" WHERE id = ${shopBId}`;
    });
  });

  describe("Retention Purge Function", () => {
    it.skipIf(!DATABASE_URL)("s22_purge_unmatched_narration() purges old unmatched, preserves matched and amounts/UTR", async () => {
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

      // Payment 4: Old unmatched with empty narration (should NOT be touched)
      const oldEmptyNarrationId = `pay-old-empty-${testId}`;
      await sql!`
        INSERT INTO public."Payment" (id, "shopId", "importId", "valueDate", amount, utr, narration, "payerText", status, "createdAt", "updatedAt")
        VALUES (${oldEmptyNarrationId}, ${testShopId}, ${testImportId}, ${oldDate}, 4000.00, 'UTR004', '', NULL, 'unmatched', ${now}, ${now})
      `;

      // Payment 5: Old unmatched already redacted (should NOT be touched)
      const oldRedactedId = `pay-old-redacted-${testId}`;
      await sql!`
        INSERT INTO public."Payment" (id, "shopId", "importId", "valueDate", amount, utr, narration, "payerText", status, "createdAt", "updatedAt")
        VALUES (${oldRedactedId}, ${testShopId}, ${testImportId}, ${oldDate}, 5000.00, 'UTR005', '[REDACTED]', NULL, 'unmatched', ${now}, ${now})
      `;

      // Call the same function that pg_cron uses
      const [result] = await sql!<{ s22_purge_unmatched_narration: number }[]>`
        SELECT public.s22_purge_unmatched_narration()
      `;
      expect(result.s22_purge_unmatched_narration).toBeGreaterThanOrEqual(1);

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
      const [oldEmpty] = await sql!<{ narration: string; payerText: string | null }[]>`
        SELECT narration, "payerText" FROM public."Payment" WHERE id = ${oldEmptyNarrationId}
      `;
      expect(oldEmpty.narration).toBe('');
      expect(oldEmpty.payerText).toBeNull();

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
