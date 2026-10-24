/**
 * Real-DB integration tests for redactCustomer.
 *
 * Tests atomicity, shop scoping, and idempotency of customers/redact.
 * Requires a running PostgreSQL instance with pgmq extension.
 *
 * Run with: TEST_DATABASE_URL=postgresql://... npm test -- redact-customer-db
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { redactCustomer } from "../compliance.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("redactCustomer DB integration", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-redact";

  // Shop A - the shop being redacted
  const SHOP_A_ID = `shop-a-${TEST_SUFFIX}`;
  const SHOP_A_DOMAIN = `shop-a-${TEST_SUFFIX}.myshopify.com`;
  const ACCOUNT_A_ID = `acc-a-${TEST_SUFFIX}`;
  const CUSTOMER_X_GID = `gid://shopify/Customer/${TEST_SUFFIX}`;
  const IMPORT_A_ID = `import-a-${TEST_SUFFIX}`;

  // Shop B - should remain untouched
  const SHOP_B_ID = `shop-b-${TEST_SUFFIX}`;
  const SHOP_B_DOMAIN = `shop-b-${TEST_SUFFIX}.myshopify.com`;
  const ACCOUNT_B_ID = `acc-b-${TEST_SUFFIX}`;
  const IMPORT_B_ID = `import-b-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create Shop A
    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${SHOP_A_ID}, ${SHOP_A_DOMAIN}, 'INR', NOW(), NOW())
    `;

    // Create Shop B with SAME customer GID (cross-tenant isolation test)
    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${SHOP_B_ID}, ${SHOP_B_DOMAIN}, 'INR', NOW(), NOW())
    `;

    // Create BuyerAccount for Shop A
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, name, "customerId", "createdAt", "updatedAt"
      )
      VALUES (
        ${ACCOUNT_A_ID}, ${SHOP_A_ID}, 'TAGGED_CUSTOMER',
        'Customer X on Shop A', ${CUSTOMER_X_GID}, NOW(), NOW()
      )
    `;

    // Create BuyerAccount for Shop B with SAME customer GID
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, name, "customerId", "createdAt", "updatedAt"
      )
      VALUES (
        ${ACCOUNT_B_ID}, ${SHOP_B_ID}, 'TAGGED_CUSTOMER',
        'Customer X on Shop B', ${CUSTOMER_X_GID}, NOW(), NOW()
      )
    `;

    // Create BankImport for Shop A
    await sql`
      INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
      VALUES (${IMPORT_A_ID}, ${SHOP_A_ID}, 'test', 'test-a.csv', 10, NOW())
    `;

    // Create BankImport for Shop B
    await sql`
      INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
      VALUES (${IMPORT_B_ID}, ${SHOP_B_ID}, 'test', 'test-b.csv', 10, NOW())
    `;
  });

  afterAll(async () => {
    // Cleanup in reverse FK order
    await sql`DELETE FROM "Match" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "Payment" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" IN (${ACCOUNT_A_ID}, ${ACCOUNT_B_ID})`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM s8_draft_orders WHERE shop_id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM s22_data_requests WHERE shop_id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "Shop" WHERE id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql.end();
  });

  beforeEach(async () => {
    // Reset test data between tests
    await sql`DELETE FROM "Match" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "Payment" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" IN (${ACCOUNT_A_ID}, ${ACCOUNT_B_ID})`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM s8_draft_orders WHERE shop_id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM s22_data_requests WHERE shop_id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;

    // Reset buyer accounts to original state (in case anonymized in previous test)
    await sql`
      UPDATE "BuyerAccount"
      SET name = 'Customer X on Shop A', "customerId" = ${CUSTOMER_X_GID}, "updatedAt" = NOW()
      WHERE id = ${ACCOUNT_A_ID}
    `;
    await sql`
      UPDATE "BuyerAccount"
      SET name = 'Customer X on Shop B', "customerId" = ${CUSTOMER_X_GID}, "updatedAt" = NOW()
      WHERE id = ${ACCOUNT_B_ID}
    `;
  });

  async function createPayment(
    shopId: string,
    importId: string,
    id: string,
    narration: string,
    payerText: string | null
  ): Promise<void> {
    await sql`
      INSERT INTO "Payment" (id, "shopId", "importId", "valueDate", amount, rail, narration, "payerText", status, "createdAt", "updatedAt")
      VALUES (${id}, ${shopId}, ${importId}, NOW(), 1000.00, 'NEFT', ${narration}, ${payerText}, 'unmatched', NOW(), NOW())
    `;
  }

  async function createInvoice(shopId: string, accountId: string, id: string): Promise<void> {
    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status, "issuedAt", "createdAt", "updatedAt")
      VALUES (${id}, ${shopId}, ${accountId}, ${'gid://shopify/Order/' + id}, ${'#' + id.slice(-6)}, 1000.00, 1000.00, 'open', NOW(), NOW(), NOW())
    `;
  }

  async function createMatch(
    shopId: string,
    paymentId: string,
    invoiceId: string,
    state: string,
    id: string
  ): Promise<void> {
    await sql`
      INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
      VALUES (${id}, ${shopId}, ${paymentId}, ${invoiceId}, 1000.00, 100, ${sql.json([{ type: 'test', points: 100 }])}, ${state}, NOW(), NOW())
    `;
  }

  async function createPayerAlias(accountId: string, id: string, key: string): Promise<void> {
    await sql`
      INSERT INTO "PayerAlias" (id, "buyerAccountId", "payerKey", "createdAt")
      VALUES (${id}, ${accountId}, ${key}, NOW())
    `;
  }

  async function createTaggedCustomer(shopId: string, customerGid: string): Promise<void> {
    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active)
      VALUES (${shopId}, ${customerGid}, '["net-terms"]'::jsonb, true)
    `;
  }

  describe("shop-scoped redaction", () => {
    it("redacts Shop A's matched payments while preserving Shop B's identical data", async () => {
      // Create tagged customers for both shops
      await createTaggedCustomer(SHOP_A_ID, CUSTOMER_X_GID);
      await createTaggedCustomer(SHOP_B_ID, CUSTOMER_X_GID);

      // Create payments for Shop A
      const payA1 = `pmt-a1-${TEST_SUFFIX}`;
      const payA2 = `pmt-a2-${TEST_SUFFIX}`;
      await createPayment(SHOP_A_ID, IMPORT_A_ID, payA1, 'ACME CORP PAYMENT', 'ACME CORP');
      await createPayment(SHOP_A_ID, IMPORT_A_ID, payA2, 'ACME CORP INVOICE 2', 'ACME CORP');

      // Create unrelated unmatched payment in Shop A (should NOT be redacted)
      const payAUnmatched = `pmt-a-unmatched-${TEST_SUFFIX}`;
      await createPayment(SHOP_A_ID, IMPORT_A_ID, payAUnmatched, 'UNRELATED PAYMENT', 'OTHER CORP');

      // Create payments for Shop B (identical content)
      const payB1 = `pmt-b1-${TEST_SUFFIX}`;
      const payB2 = `pmt-b2-${TEST_SUFFIX}`;
      await createPayment(SHOP_B_ID, IMPORT_B_ID, payB1, 'ACME CORP PAYMENT', 'ACME CORP');
      await createPayment(SHOP_B_ID, IMPORT_B_ID, payB2, 'ACME CORP INVOICE 2', 'ACME CORP');

      // Create invoices
      const invA1 = `inv-a1-${TEST_SUFFIX}`;
      const invA2 = `inv-a2-${TEST_SUFFIX}`;
      const invB1 = `inv-b1-${TEST_SUFFIX}`;
      const invB2 = `inv-b2-${TEST_SUFFIX}`;
      await createInvoice(SHOP_A_ID, ACCOUNT_A_ID, invA1);
      await createInvoice(SHOP_A_ID, ACCOUNT_A_ID, invA2);
      await createInvoice(SHOP_B_ID, ACCOUNT_B_ID, invB1);
      await createInvoice(SHOP_B_ID, ACCOUNT_B_ID, invB2);

      // Create matches for Shop A (various states)
      const matchA1 = `match-a1-${TEST_SUFFIX}`;
      const matchA2 = `match-a2-${TEST_SUFFIX}`;
      await createMatch(SHOP_A_ID, payA1, invA1, 'confirmed', matchA1);
      await createMatch(SHOP_A_ID, payA2, invA2, 'pushed', matchA2);

      // Create matches for Shop B
      const matchB1 = `match-b1-${TEST_SUFFIX}`;
      const matchB2 = `match-b2-${TEST_SUFFIX}`;
      await createMatch(SHOP_B_ID, payB1, invB1, 'confirmed', matchB1);
      await createMatch(SHOP_B_ID, payB2, invB2, 'pushed', matchB2);

      // Create PayerAlias rows
      const aliasA1 = `alias-a1-${TEST_SUFFIX}`;
      const aliasA2 = `alias-a2-${TEST_SUFFIX}`;
      const aliasB1 = `alias-b1-${TEST_SUFFIX}`;
      await createPayerAlias(ACCOUNT_A_ID, aliasA1, 'acme-corp-a');
      await createPayerAlias(ACCOUNT_A_ID, aliasA2, 'acme-inc-a');
      await createPayerAlias(ACCOUNT_B_ID, aliasB1, 'acme-corp-b');

      // Execute redaction for Shop A only
      const result = await redactCustomer(sql, SHOP_A_ID, CUSTOMER_X_GID);

      expect(result.taggedCustomersDeleted).toBe(1);
      expect(result.paymentsRedacted).toBe(2);
      expect(result.payerAliasesDeleted).toBe(2);
      expect(result.buyerAccountAnonymized).toBe(true);

      // Verify Shop A's payments are redacted
      const paymentsA = await sql<{ id: string; narration: string; payerText: string | null; amount: string; rail: string }[]>`
        SELECT id, narration, "payerText", amount::text, rail FROM "Payment" WHERE "shopId" = ${SHOP_A_ID}
      `;
      const redactedA = paymentsA.filter(p => p.id === payA1 || p.id === payA2);
      for (const p of redactedA) {
        expect(p.narration).toBe('[REDACTED]');
        expect(p.payerText).toBeNull();
        expect(p.amount).toBe('1000.00');
        expect(p.rail).toBe('NEFT');
      }

      // Verify Shop A's unmatched payment is NOT redacted
      const unmatchedA = paymentsA.find(p => p.id === payAUnmatched);
      expect(unmatchedA?.narration).toBe('UNRELATED PAYMENT');
      expect(unmatchedA?.payerText).toBe('OTHER CORP');

      // Verify Shop B's payments are byte-for-byte unchanged
      const paymentsB = await sql<{ id: string; narration: string; payerText: string | null }[]>`
        SELECT id, narration, "payerText" FROM "Payment" WHERE "shopId" = ${SHOP_B_ID}
      `;
      const payB1Row = paymentsB.find(p => p.id === payB1);
      const payB2Row = paymentsB.find(p => p.id === payB2);
      expect(payB1Row?.narration).toBe('ACME CORP PAYMENT');
      expect(payB1Row?.payerText).toBe('ACME CORP');
      expect(payB2Row?.narration).toBe('ACME CORP INVOICE 2');
      expect(payB2Row?.payerText).toBe('ACME CORP');

      // Verify Shop A's PayerAlias rows are deleted
      const aliasesA = await sql<{ id: string }[]>`
        SELECT id FROM "PayerAlias" WHERE "buyerAccountId" = ${ACCOUNT_A_ID}
      `;
      expect(aliasesA.length).toBe(0);

      // Verify Shop B's PayerAlias rows are intact
      const aliasesB = await sql<{ id: string }[]>`
        SELECT id FROM "PayerAlias" WHERE "buyerAccountId" = ${ACCOUNT_B_ID}
      `;
      expect(aliasesB.length).toBe(1);

      // Verify Shop A's BuyerAccount is anonymized
      const [accountA] = await sql<{ name: string; customerId: string }[]>`
        SELECT name, "customerId" FROM "BuyerAccount" WHERE id = ${ACCOUNT_A_ID}
      `;
      expect(accountA.name).toBe('Redacted Customer');
      expect(accountA.customerId).toContain('_redacted_');

      // Verify Shop B's BuyerAccount is intact
      const [accountB] = await sql<{ name: string; customerId: string }[]>`
        SELECT name, "customerId" FROM "BuyerAccount" WHERE id = ${ACCOUNT_B_ID}
      `;
      expect(accountB.name).toBe('Customer X on Shop B');
      expect(accountB.customerId).toBe(CUSTOMER_X_GID);

      // Verify Shop B's tagged customer is intact
      const taggedB = await sql<{ shop_id: string }[]>`
        SELECT shop_id FROM s8_tagged_customers WHERE shop_id = ${SHOP_B_ID}
      `;
      expect(taggedB.length).toBe(1);

      // Verify Match rows are preserved (amount, state, etc.)
      const matchesA = await sql<{ id: string; amount: string; state: string }[]>`
        SELECT id, amount::text, state FROM "Match" WHERE "shopId" = ${SHOP_A_ID}
      `;
      expect(matchesA.length).toBe(2);
      for (const m of matchesA) {
        expect(m.amount).toBe('1000.00');
        expect(['confirmed', 'pushed']).toContain(m.state);
      }
    });

    it("handles different Match states: confirmed, pushed, unmatched", async () => {
      // Create payments
      const payConfirmed = `pmt-confirmed-${TEST_SUFFIX}`;
      const payPushed = `pmt-pushed-${TEST_SUFFIX}`;
      const payUnmatched = `pmt-unmatched-${TEST_SUFFIX}`;
      await createPayment(SHOP_A_ID, IMPORT_A_ID, payConfirmed, 'CONFIRMED PAYMENT', 'PAYER');
      await createPayment(SHOP_A_ID, IMPORT_A_ID, payPushed, 'PUSHED PAYMENT', 'PAYER');
      await createPayment(SHOP_A_ID, IMPORT_A_ID, payUnmatched, 'UNMATCHED PAYMENT', 'PAYER');

      // Create invoices
      const invConfirmed = `inv-confirmed-${TEST_SUFFIX}`;
      const invPushed = `inv-pushed-${TEST_SUFFIX}`;
      const invUnmatched = `inv-unmatched-${TEST_SUFFIX}`;
      await createInvoice(SHOP_A_ID, ACCOUNT_A_ID, invConfirmed);
      await createInvoice(SHOP_A_ID, ACCOUNT_A_ID, invPushed);
      await createInvoice(SHOP_A_ID, ACCOUNT_A_ID, invUnmatched);

      // Create matches with different states
      await createMatch(SHOP_A_ID, payConfirmed, invConfirmed, 'confirmed', `match-confirmed-${TEST_SUFFIX}`);
      await createMatch(SHOP_A_ID, payPushed, invPushed, 'pushed', `match-pushed-${TEST_SUFFIX}`);
      await createMatch(SHOP_A_ID, payUnmatched, invUnmatched, 'unmatched', `match-unmatched-${TEST_SUFFIX}`);

      const result = await redactCustomer(sql, SHOP_A_ID, CUSTOMER_X_GID);

      // All 3 matched payments should be redacted (regardless of Match state)
      expect(result.paymentsRedacted).toBe(3);

      const payments = await sql<{ id: string; narration: string; payerText: string | null }[]>`
        SELECT id, narration, "payerText" FROM "Payment" WHERE "shopId" = ${SHOP_A_ID}
      `;
      for (const p of payments) {
        expect(p.narration).toBe('[REDACTED]');
        expect(p.payerText).toBeNull();
      }
    });
  });

  describe("idempotency", () => {
    it("re-running redactCustomer is idempotent (no error, no further changes)", async () => {
      // Setup
      await createTaggedCustomer(SHOP_A_ID, CUSTOMER_X_GID);
      const payA = `pmt-idem-${TEST_SUFFIX}`;
      await createPayment(SHOP_A_ID, IMPORT_A_ID, payA, 'ORIGINAL NARRATION', 'PAYER');
      const invA = `inv-idem-${TEST_SUFFIX}`;
      await createInvoice(SHOP_A_ID, ACCOUNT_A_ID, invA);
      await createMatch(SHOP_A_ID, payA, invA, 'confirmed', `match-idem-${TEST_SUFFIX}`);
      await createPayerAlias(ACCOUNT_A_ID, `alias-idem-${TEST_SUFFIX}`, 'payer-key');

      // First redaction
      const result1 = await redactCustomer(sql, SHOP_A_ID, CUSTOMER_X_GID);
      expect(result1.paymentsRedacted).toBe(1);
      expect(result1.payerAliasesDeleted).toBe(1);
      expect(result1.taggedCustomersDeleted).toBe(1);
      expect(result1.buyerAccountAnonymized).toBe(true);

      // Capture state after first redaction
      const [paymentAfter1] = await sql<{ narration: string; payerText: string | null }[]>`
        SELECT narration, "payerText" FROM "Payment" WHERE id = ${payA}
      `;
      const [accountAfter1] = await sql<{ name: string; customerId: string }[]>`
        SELECT name, "customerId" FROM "BuyerAccount" WHERE id = ${ACCOUNT_A_ID}
      `;

      // Second redaction (idempotent)
      const result2 = await redactCustomer(sql, SHOP_A_ID, CUSTOMER_X_GID);
      expect(result2.paymentsRedacted).toBe(0);
      expect(result2.payerAliasesDeleted).toBe(0);
      expect(result2.taggedCustomersDeleted).toBe(0);
      expect(result2.buyerAccountAnonymized).toBe(false);

      // Verify no further changes
      const [paymentAfter2] = await sql<{ narration: string; payerText: string | null }[]>`
        SELECT narration, "payerText" FROM "Payment" WHERE id = ${payA}
      `;
      expect(paymentAfter2.narration).toBe(paymentAfter1.narration);
      expect(paymentAfter2.payerText).toBe(paymentAfter1.payerText);

      // BuyerAccount customerId was modified, so it won't match anymore
      const [accountAfter2] = await sql<{ name: string; customerId: string }[]>`
        SELECT name, "customerId" FROM "BuyerAccount" WHERE id = ${ACCOUNT_A_ID}
      `;
      expect(accountAfter2.name).toBe(accountAfter1.name);
      expect(accountAfter2.customerId).toBe(accountAfter1.customerId);
    });
  });

  describe("atomicity", () => {
    it("failure during transaction rolls back all changes", async () => {
      // This test verifies atomicity by creating a scenario where
      // the transaction will fail. We use a trigger to simulate failure.

      // Setup initial data
      await createTaggedCustomer(SHOP_A_ID, CUSTOMER_X_GID);
      const payA = `pmt-atomic-${TEST_SUFFIX}`;
      await createPayment(SHOP_A_ID, IMPORT_A_ID, payA, 'ORIGINAL NARRATION', 'ORIGINAL PAYER');
      const invA = `inv-atomic-${TEST_SUFFIX}`;
      await createInvoice(SHOP_A_ID, ACCOUNT_A_ID, invA);
      await createMatch(SHOP_A_ID, payA, invA, 'confirmed', `match-atomic-${TEST_SUFFIX}`);
      await createPayerAlias(ACCOUNT_A_ID, `alias-atomic-${TEST_SUFFIX}`, 'payer-key');

      // Create a trigger that raises an exception when BuyerAccount is updated
      // Note: We use a fixed pattern match since we can't interpolate into CREATE FUNCTION
      await sql.unsafe(`
        CREATE OR REPLACE FUNCTION test_redact_fail_trigger()
        RETURNS TRIGGER AS $$
        BEGIN
          IF NEW."customerId" LIKE '%_redacted_%' AND OLD.id LIKE 'acc-a-%-redact' THEN
            RAISE EXCEPTION 'Test failure injection';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await sql`
        CREATE TRIGGER test_redact_fail
        BEFORE UPDATE ON "BuyerAccount"
        FOR EACH ROW EXECUTE FUNCTION test_redact_fail_trigger()
      `;

      // Attempt redaction - should fail
      let error: Error | null = null;
      try {
        await redactCustomer(sql, SHOP_A_ID, CUSTOMER_X_GID);
      } catch (e) {
        error = e as Error;
      } finally {
        // Clean up trigger in finally block so a failed assert can't leave it behind
        await sql`DROP TRIGGER IF EXISTS test_redact_fail ON "BuyerAccount"`;
        await sql`DROP FUNCTION IF EXISTS test_redact_fail_trigger()`;
      }

      expect(error).not.toBeNull();
      expect(error?.message).toContain('Test failure injection');

      // Verify nothing was committed (atomic rollback)
      const [payment] = await sql<{ narration: string; payerText: string | null }[]>`
        SELECT narration, "payerText" FROM "Payment" WHERE id = ${payA}
      `;
      expect(payment.narration).toBe('ORIGINAL NARRATION');
      expect(payment.payerText).toBe('ORIGINAL PAYER');

      const aliases = await sql<{ id: string }[]>`
        SELECT id FROM "PayerAlias" WHERE "buyerAccountId" = ${ACCOUNT_A_ID}
      `;
      expect(aliases.length).toBe(1);

      const tagged = await sql<{ shop_id: string }[]>`
        SELECT shop_id FROM s8_tagged_customers WHERE shop_id = ${SHOP_A_ID}
      `;
      expect(tagged.length).toBe(1);

      const [account] = await sql<{ name: string; customerId: string }[]>`
        SELECT name, "customerId" FROM "BuyerAccount" WHERE id = ${ACCOUNT_A_ID}
      `;
      expect(account.name).toBe('Customer X on Shop A');
      expect(account.customerId).toBe(CUSTOMER_X_GID);
    });
  });

  describe("data preservation", () => {
    it("preserves amount, UTR, rail, valueDate, and Match rows after redaction", async () => {
      // Create payment with all fields
      const payA = `pmt-preserve-${TEST_SUFFIX}`;
      const valueDate = new Date('2026-01-15');
      await sql`
        INSERT INTO "Payment" (id, "shopId", "importId", "valueDate", amount, rail, utr, narration, "payerText", status, "createdAt", "updatedAt")
        VALUES (${payA}, ${SHOP_A_ID}, ${IMPORT_A_ID}, ${valueDate}, 5432.10, 'RTGS', 'UTRCBI123456789', 'ACME CORP INVOICE PAYMENT', 'ACME CORP PVT LTD', 'matched', NOW(), NOW())
      `;

      // Create invoice and match
      const invA = `inv-preserve-${TEST_SUFFIX}`;
      await createInvoice(SHOP_A_ID, ACCOUNT_A_ID, invA);
      const matchId = `match-preserve-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "confirmedBy", "confirmedAt", "createdAt", "updatedAt")
        VALUES (${matchId}, ${SHOP_A_ID}, ${payA}, ${invA}, 5432.10, 95, ${sql.json([{ type: 'utr', points: 95 }])}, 'pushed', 'user-123', NOW(), NOW(), NOW())
      `;

      // Execute redaction
      await redactCustomer(sql, SHOP_A_ID, CUSTOMER_X_GID);

      // Verify Payment fields preserved
      const [payment] = await sql<{
        amount: string;
        rail: string;
        utr: string;
        valueDate: Date;
        narration: string;
        payerText: string | null;
      }[]>`
        SELECT amount::text, rail, utr, "valueDate", narration, "payerText"
        FROM "Payment" WHERE id = ${payA}
      `;
      expect(payment.amount).toBe('5432.10');
      expect(payment.rail).toBe('RTGS');
      expect(payment.utr).toBe('UTRCBI123456789');
      expect(payment.valueDate.toISOString().slice(0, 10)).toBe('2026-01-15');
      expect(payment.narration).toBe('[REDACTED]');
      expect(payment.payerText).toBeNull();

      // Verify Match row preserved
      const [match] = await sql<{
        id: string;
        amount: string;
        score: number;
        state: string;
        confirmedBy: string;
      }[]>`
        SELECT id, amount::text, score, state, "confirmedBy"
        FROM "Match" WHERE id = ${matchId}
      `;
      expect(match.id).toBe(matchId);
      expect(match.amount).toBe('5432.10');
      expect(match.score).toBe(95);
      expect(match.state).toBe('pushed');
      expect(match.confirmedBy).toBe('user-123');
    });
  });
});
