import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type {
  ShopRow,
  AccountSourceRow,
  BuyerAccountRow,
  InvoiceRow,
  BankImportRow,
  PaymentRow,
  MatchRow,
  PayerAliasRow,
  ReminderRuleRow,
  ReminderLogRow,
  AuditEventRow,
} from "~/lib/s5-types";

/**
 * Integration tests for S5 data model schema.
 *
 * Tests verify:
 * 1. Migrations apply cleanly to an empty database
 * 2. Full fixture set can be inserted and read back
 * 3. TIMESTAMPTZ columns round-trip correctly regardless of DB session timezone
 * 4. Unique constraints reject duplicates (UTR per shop, reminder per rule+invoice, etc.)
 * 5. CASCADE delete propagates correctly from Shop down
 * 6. Decimal money fields are handled correctly (returned as strings by postgres.js)
 *
 * These tests run against the CI Postgres 16 service container.
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("S5 Data Model Schema", () => {
  let sql: ReturnType<typeof postgres>;

  // Test IDs - use timestamps to avoid collisions between test runs
  const TEST_SUFFIX = Date.now().toString(36);
  const TEST_SHOP_ID = `shop-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-s5-${TEST_SUFFIX}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 1 });
  });

  afterAll(async () => {
    // Clean up test data - cascade will handle dependent rows
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`.catch(() => {});
    await sql.end();
  });

  beforeEach(async () => {
    // Clean up before each test
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`.catch(() => {});
  });

  describe("Fixture Insert and Read", () => {
    it("inserts and reads a complete fixture set", async () => {
      const now = new Date();
      const dueDate = new Date("2025-08-15T23:59:59.999Z");
      const issuedAt = new Date("2025-07-15T10:00:00.000Z");
      const valueDate = new Date("2025-07-20T00:00:00.000Z");

      // 1. Insert Shop
      await sql`
        INSERT INTO "Shop" (id, domain, currency, plan, "defaultTermsDays", timezone, "createdAt", "updatedAt")
        VALUES (
          ${TEST_SHOP_ID},
          ${TEST_SHOP_DOMAIN},
          'INR',
          'free',
          30,
          'Asia/Kolkata',
          ${now},
          ${now}
        )
      `;

      // 2. Insert AccountSource (tag rule)
      const accountSourceId = `source-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "AccountSource" (id, "shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")
        VALUES (
          ${accountSourceId},
          ${TEST_SHOP_ID},
          'net45',
          45,
          ${now},
          ${now}
        )
      `;

      // 3. Insert BuyerAccounts - one COMPANY and one TAGGED_CUSTOMER
      const companyAccountId = `account-company-${TEST_SUFFIX}`;
      const taggedAccountId = `account-tagged-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", "customerId",
          name, "creditLimit", "defaultTermsDays", "defaultTermsSource",
          "holdState", bypass, "createdAt", "updatedAt"
        ) VALUES (
          ${companyAccountId},
          ${TEST_SHOP_ID},
          'COMPANY',
          'gid://shopify/Company/123',
          'gid://shopify/CompanyLocation/456',
          NULL,
          'Acme Corp',
          '100000.00',
          60,
          'explicit',
          'OK',
          false,
          ${now},
          ${now}
        )
      `;

      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", "customerId",
          name, "creditLimit", "defaultTermsDays", "defaultTermsSource",
          "holdState", bypass, "createdAt", "updatedAt"
        ) VALUES (
          ${taggedAccountId},
          ${TEST_SHOP_ID},
          'TAGGED_CUSTOMER',
          NULL,
          NULL,
          'gid://shopify/Customer/789',
          'John Doe',
          NULL,
          30,
          'tag',
          'OK',
          false,
          ${now},
          ${now}
        )
      `;

      // 4. Insert Invoices with each dueSource value
      const invoiceScheduleId = `inv-schedule-${TEST_SUFFIX}`;
      const invoiceOverrideId = `inv-override-${TEST_SUFFIX}`;
      const invoiceInferredId = `inv-inferred-${TEST_SUFFIX}`;
      const invoiceNoneId = `inv-none-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          "issuedAt", "dueAt", "dueSource", "dueBasis", "dueReason", "dueOverrideAt",
          status, "createdAt", "updatedAt"
        ) VALUES (
          ${invoiceScheduleId},
          ${TEST_SHOP_ID},
          ${companyAccountId},
          'gid://shopify/Order/1001',
          '#1001',
          '50000.00',
          '50000.00',
          ${issuedAt},
          ${dueDate},
          'schedule',
          NULL,
          'Payment schedule from Shopify',
          NULL,
          'open',
          ${now},
          ${now}
        )
      `;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          "issuedAt", "dueAt", "dueSource", "dueBasis", "dueReason", "dueOverrideAt",
          status, "createdAt", "updatedAt"
        ) VALUES (
          ${invoiceOverrideId},
          ${TEST_SHOP_ID},
          ${companyAccountId},
          'gid://shopify/Order/1002',
          '#1002',
          '25000.00',
          '25000.00',
          ${issuedAt},
          ${dueDate},
          'override',
          NULL,
          'Merchant override for this invoice',
          ${dueDate},
          'open',
          ${now},
          ${now}
        )
      `;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          "issuedAt", "dueAt", "dueSource", "dueBasis", "dueReason", "dueOverrideAt",
          status, "createdAt", "updatedAt"
        ) VALUES (
          ${invoiceInferredId},
          ${TEST_SHOP_ID},
          ${taggedAccountId},
          'gid://shopify/Order/1003',
          '#1003',
          '15000.00',
          '15000.00',
          ${issuedAt},
          ${dueDate},
          'inferred',
          'accountDefault',
          'Account default: net 30 days',
          NULL,
          'open',
          ${now},
          ${now}
        )
      `;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", name, total, outstanding,
          "issuedAt", "dueAt", "dueSource", "dueBasis", "dueReason",
          status, "createdAt", "updatedAt"
        ) VALUES (
          ${invoiceNoneId},
          ${TEST_SHOP_ID},
          ${taggedAccountId},
          '#1004',
          '5000.00',
          '5000.00',
          ${issuedAt},
          NULL,
          'none',
          NULL,
          'No payment terms found',
          'open',
          ${now},
          ${now}
        )
      `;

      // 5. Insert BankImport + Payment + Match
      const importId = `import-${TEST_SUFFIX}`;
      const paymentId = `payment-${TEST_SUFFIX}`;
      const matchId = `match-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
        VALUES (
          ${importId},
          ${TEST_SHOP_ID},
          'hdfc',
          'statement_july_2025.csv',
          10,
          ${now}
        )
      `;

      await sql`
        INSERT INTO "Payment" (
          id, "shopId", "importId", "valueDate", amount, rail, utr,
          "payerText", narration, status, "createdAt", "updatedAt"
        ) VALUES (
          ${paymentId},
          ${TEST_SHOP_ID},
          ${importId},
          ${valueDate},
          '50000.00',
          'NEFT',
          'HDFC0000123456789',
          'ACME CORP',
          'NEFT/ACME CORP/INV1001',
          'matched',
          ${now},
          ${now}
        )
      `;

      await sql`
        INSERT INTO "Match" (
          id, "paymentId", "invoiceId", amount, score, reasons, state,
          "confirmedBy", "confirmedAt", "createdAt", "updatedAt"
        ) VALUES (
          ${matchId},
          ${paymentId},
          ${invoiceScheduleId},
          '50000.00',
          95,
          ${JSON.stringify({ name_match: true, amount_match: true })}::jsonb,
          'confirmed',
          'user:admin@example.com',
          ${now},
          ${now},
          ${now}
        )
      `;

      // 6. Insert ReminderRule + ReminderLog
      const ruleId = `rule-${TEST_SUFFIX}`;
      const logId = `log-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
        VALUES (
          ${ruleId},
          ${TEST_SHOP_ID},
          -3,
          'email',
          true,
          ${now},
          ${now}
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "ruleId", "invoiceId", "sentAt")
        VALUES (
          ${logId},
          ${ruleId},
          ${invoiceScheduleId},
          ${now}
        )
      `;

      // 7. Insert AuditEvent
      const eventId = `event-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "AuditEvent" (id, "shopId", actor, type, data, at)
        VALUES (
          ${eventId},
          ${TEST_SHOP_ID},
          'user:admin@example.com',
          'invoice.created',
          ${JSON.stringify({ invoiceId: invoiceScheduleId, amount: "50000.00" })}::jsonb,
          ${now}
        )
      `;

      // 8. Insert PayerAlias
      const aliasId = `alias-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "PayerAlias" (id, "buyerAccountId", "payerKey", "createdAt")
        VALUES (
          ${aliasId},
          ${companyAccountId},
          'acme corp',
          ${now}
        )
      `;

      // Read everything back and verify
      const [shop] = await sql<ShopRow[]>`SELECT * FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
      expect(shop.domain).toBe(TEST_SHOP_DOMAIN);
      expect(shop.defaultTermsDays).toBe(30);
      expect(shop.timezone).toBe("Asia/Kolkata");

      const [source] = await sql<AccountSourceRow[]>`SELECT * FROM "AccountSource" WHERE id = ${accountSourceId}`;
      expect(source.tag).toBe("net45");
      expect(source.defaultTermsDays).toBe(45);

      const accounts = await sql<BuyerAccountRow[]>`SELECT * FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID} ORDER BY kind`;
      expect(accounts).toHaveLength(2);
      expect(accounts[0].kind).toBe("COMPANY");
      expect(accounts[0].creditLimit).toBe("100000.00");
      expect(accounts[0].defaultTermsSource).toBe("explicit");
      expect(accounts[1].kind).toBe("TAGGED_CUSTOMER");
      expect(accounts[1].defaultTermsSource).toBe("tag");

      const invoices = await sql<InvoiceRow[]>`SELECT * FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID} ORDER BY name`;
      expect(invoices).toHaveLength(4);
      
      const scheduleInv = invoices.find((i) => i.id === invoiceScheduleId);
      expect(scheduleInv?.dueSource).toBe("schedule");
      expect(scheduleInv?.dueBasis).toBeNull();
      expect(scheduleInv?.total).toBe("50000.00");

      const overrideInv = invoices.find((i) => i.id === invoiceOverrideId);
      expect(overrideInv?.dueSource).toBe("override");
      expect(overrideInv?.dueOverrideAt).toBeInstanceOf(Date);

      const inferredInv = invoices.find((i) => i.id === invoiceInferredId);
      expect(inferredInv?.dueSource).toBe("inferred");
      expect(inferredInv?.dueBasis).toBe("accountDefault");

      const noneInv = invoices.find((i) => i.id === invoiceNoneId);
      expect(noneInv?.dueSource).toBe("none");
      expect(noneInv?.dueAt).toBeNull();

      const [bankImport] = await sql<BankImportRow[]>`SELECT * FROM "BankImport" WHERE id = ${importId}`;
      expect(bankImport.bank).toBe("hdfc");
      expect(bankImport.rowCount).toBe(10);
      expect(bankImport.fileName).toBe("statement_july_2025.csv");

      const [payment] = await sql<PaymentRow[]>`SELECT * FROM "Payment" WHERE id = ${paymentId}`;
      expect(payment.utr).toBe("HDFC0000123456789");
      expect(payment.amount).toBe("50000.00");
      expect(payment.status).toBe("matched");

      const [match] = await sql<MatchRow[]>`SELECT * FROM "Match" WHERE id = ${matchId}`;
      expect(match.score).toBe(95);
      expect(match.state).toBe("confirmed");
      expect(match.reasons).toEqual({ name_match: true, amount_match: true });

      const [rule] = await sql<ReminderRuleRow[]>`SELECT * FROM "ReminderRule" WHERE id = ${ruleId}`;
      expect(rule.offsetDays).toBe(-3);
      expect(rule.channel).toBe("email");

      const [log] = await sql<ReminderLogRow[]>`SELECT * FROM "ReminderLog" WHERE id = ${logId}`;
      expect(log.ruleId).toBe(ruleId);
      expect(log.invoiceId).toBe(invoiceScheduleId);

      const [event] = await sql<AuditEventRow[]>`SELECT * FROM "AuditEvent" WHERE id = ${eventId}`;
      expect(event.type).toBe("invoice.created");
      expect(event.data).toHaveProperty("invoiceId", invoiceScheduleId);

      const [alias] = await sql<PayerAliasRow[]>`SELECT * FROM "PayerAlias" WHERE id = ${aliasId}`;
      expect(alias.payerKey).toBe("acme corp");
    });
  });

  describe("TIMESTAMPTZ Round-trips", () => {
    const TEST_TIMESTAMP = new Date("2025-07-04T23:30:00.000Z");

    it("round-trips correctly with DB session timezone UTC", async () => {
      const sqlUtc = postgres(TEST_DATABASE_URL!, { max: 1 });
      await sqlUtc`SET TIME ZONE 'UTC'`;

      const shopId = `shop-tz-utc-${TEST_SUFFIX}`;
      await sqlUtc`
        INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt")
        VALUES (${shopId}, ${`tz-utc-${TEST_SUFFIX}.myshopify.com`}, ${TEST_TIMESTAMP}, ${TEST_TIMESTAMP})
      `;

      const [shop] = await sqlUtc<ShopRow[]>`SELECT * FROM "Shop" WHERE id = ${shopId}`;
      expect(shop.createdAt.toISOString()).toBe(TEST_TIMESTAMP.toISOString());

      await sqlUtc`DELETE FROM "Shop" WHERE id = ${shopId}`;
      await sqlUtc.end();
    });

    it("round-trips correctly with DB session timezone Asia/Kolkata", async () => {
      const sqlKolkata = postgres(TEST_DATABASE_URL!, { max: 1 });
      await sqlKolkata`SET TIME ZONE 'Asia/Kolkata'`;

      const shopId = `shop-tz-kolkata-${TEST_SUFFIX}`;
      await sqlKolkata`
        INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt")
        VALUES (${shopId}, ${`tz-kolkata-${TEST_SUFFIX}.myshopify.com`}, ${TEST_TIMESTAMP}, ${TEST_TIMESTAMP})
      `;

      const [shop] = await sqlKolkata<ShopRow[]>`SELECT * FROM "Shop" WHERE id = ${shopId}`;
      expect(shop.createdAt.toISOString()).toBe(TEST_TIMESTAMP.toISOString());

      await sqlKolkata`DELETE FROM "Shop" WHERE id = ${shopId}`;
      await sqlKolkata.end();
    });

    it("cross-writes and cross-reads correctly (write in Kolkata, read in NY)", async () => {
      const sqlWrite = postgres(TEST_DATABASE_URL!, { max: 1 });
      await sqlWrite`SET TIME ZONE 'Asia/Kolkata'`;

      const shopId = `shop-tz-cross-${TEST_SUFFIX}`;
      await sqlWrite`
        INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt")
        VALUES (${shopId}, ${`tz-cross-${TEST_SUFFIX}.myshopify.com`}, ${TEST_TIMESTAMP}, ${TEST_TIMESTAMP})
      `;
      await sqlWrite.end();

      const sqlRead = postgres(TEST_DATABASE_URL!, { max: 1 });
      await sqlRead`SET TIME ZONE 'America/New_York'`;

      const [shop] = await sqlRead<ShopRow[]>`SELECT * FROM "Shop" WHERE id = ${shopId}`;
      expect(shop.createdAt.toISOString()).toBe(TEST_TIMESTAMP.toISOString());

      await sqlRead`DELETE FROM "Shop" WHERE id = ${shopId}`;
      await sqlRead.end();
    });

    it("Invoice dueAt and dueOverrideAt round-trip correctly", async () => {
      const dueDate = new Date("2025-08-15T23:59:59.999Z");
      const overrideDate = new Date("2025-08-20T23:59:59.999Z");
      const now = new Date();

      // Setup shop and account
      const shopId = `shop-inv-tz-${TEST_SUFFIX}`;
      const accountId = `account-inv-tz-${TEST_SUFFIX}`;
      const invoiceId = `invoice-tz-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt")
        VALUES (${shopId}, ${`inv-tz-${TEST_SUFFIX}.myshopify.com`}, ${now}, ${now})
      `;

      await sql`
        INSERT INTO "BuyerAccount" (id, "shopId", kind, name, "createdAt", "updatedAt")
        VALUES (${accountId}, ${shopId}, 'COMPANY', 'Test Co', ${now}, ${now})
      `;

      // Test with Asia/Kolkata session
      const sqlKolkata = postgres(TEST_DATABASE_URL!, { max: 1 });
      await sqlKolkata`SET TIME ZONE 'Asia/Kolkata'`;

      await sqlKolkata`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", name, total, outstanding,
          "issuedAt", "dueAt", "dueOverrideAt", status, "createdAt", "updatedAt"
        ) VALUES (
          ${invoiceId}, ${shopId}, ${accountId}, '#TZ-001',
          '1000.00', '1000.00', ${now}, ${dueDate}, ${overrideDate},
          'open', ${now}, ${now}
        )
      `;
      await sqlKolkata.end();

      // Read with America/New_York session
      const sqlNy = postgres(TEST_DATABASE_URL!, { max: 1 });
      await sqlNy`SET TIME ZONE 'America/New_York'`;

      const [invoice] = await sqlNy<InvoiceRow[]>`SELECT * FROM "Invoice" WHERE id = ${invoiceId}`;
      expect(invoice.dueAt?.toISOString()).toBe(dueDate.toISOString());
      expect(invoice.dueOverrideAt?.toISOString()).toBe(overrideDate.toISOString());

      await sqlNy`DELETE FROM "Shop" WHERE id = ${shopId}`;
      await sqlNy.end();
    });
  });

  describe("Unique Constraints", () => {
    it("rejects duplicate UTR per shop", async () => {
      const now = new Date();
      const shopId = `shop-utr-${TEST_SUFFIX}`;
      const importId = `import-utr-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt")
        VALUES (${shopId}, ${`utr-${TEST_SUFFIX}.myshopify.com`}, ${now}, ${now})
      `;

      await sql`
        INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
        VALUES (${importId}, ${shopId}, 'hdfc', 'test.csv', 1, ${now})
      `;

      await sql`
        INSERT INTO "Payment" (id, "shopId", "importId", "valueDate", amount, utr, narration, "createdAt", "updatedAt")
        VALUES ('pay1-${TEST_SUFFIX}', ${shopId}, ${importId}, ${now}, '1000.00', 'UNIQUE123', 'test', ${now}, ${now})
      `;

      // Should reject duplicate UTR for same shop
      await expect(
        sql`
          INSERT INTO "Payment" (id, "shopId", "importId", "valueDate", amount, utr, narration, "createdAt", "updatedAt")
          VALUES ('pay2-${TEST_SUFFIX}', ${shopId}, ${importId}, ${now}, '2000.00', 'UNIQUE123', 'test2', ${now}, ${now})
        `
      ).rejects.toThrow(/unique/i);

      await sql`DELETE FROM "Shop" WHERE id = ${shopId}`;
    });

    it("rejects duplicate reminder per rule+invoice", async () => {
      const now = new Date();
      const shopId = `shop-rem-${TEST_SUFFIX}`;
      const accountId = `account-rem-${TEST_SUFFIX}`;
      const invoiceId = `invoice-rem-${TEST_SUFFIX}`;
      const ruleId = `rule-rem-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt")
        VALUES (${shopId}, ${`rem-${TEST_SUFFIX}.myshopify.com`}, ${now}, ${now})
      `;

      await sql`
        INSERT INTO "BuyerAccount" (id, "shopId", kind, name, "createdAt", "updatedAt")
        VALUES (${accountId}, ${shopId}, 'COMPANY', 'Test', ${now}, ${now})
      `;

      await sql`
        INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", name, total, outstanding, "issuedAt", status, "createdAt", "updatedAt")
        VALUES (${invoiceId}, ${shopId}, ${accountId}, '#1', '100.00', '100.00', ${now}, 'open', ${now}, ${now})
      `;

      await sql`
        INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, "createdAt", "updatedAt")
        VALUES (${ruleId}, ${shopId}, 0, 'email', ${now}, ${now})
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "ruleId", "invoiceId", "sentAt")
        VALUES ('log1-${TEST_SUFFIX}', ${ruleId}, ${invoiceId}, ${now})
      `;

      // Should reject duplicate rule+invoice combination
      await expect(
        sql`
          INSERT INTO "ReminderLog" (id, "ruleId", "invoiceId", "sentAt")
          VALUES ('log2-${TEST_SUFFIX}', ${ruleId}, ${invoiceId}, ${now})
        `
      ).rejects.toThrow(/unique/i);

      await sql`DELETE FROM "Shop" WHERE id = ${shopId}`;
    });

    it("rejects duplicate account per companyLocation per shop", async () => {
      const now = new Date();
      const shopId = `shop-acc-${TEST_SUFFIX}`;
      const locationGid = "gid://shopify/CompanyLocation/999";

      await sql`
        INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt")
        VALUES (${shopId}, ${`acc-${TEST_SUFFIX}.myshopify.com`}, ${now}, ${now})
      `;

      await sql`
        INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyLocationId", name, "createdAt", "updatedAt")
        VALUES ('acc1-${TEST_SUFFIX}', ${shopId}, 'COMPANY', ${locationGid}, 'Acc1', ${now}, ${now})
      `;

      // Should reject duplicate companyLocationId for same shop
      await expect(
        sql`
          INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyLocationId", name, "createdAt", "updatedAt")
          VALUES ('acc2-${TEST_SUFFIX}', ${shopId}, 'COMPANY', ${locationGid}, 'Acc2', ${now}, ${now})
        `
      ).rejects.toThrow(/unique/i);

      await sql`DELETE FROM "Shop" WHERE id = ${shopId}`;
    });

    it("rejects duplicate account per customer per shop", async () => {
      const now = new Date();
      const shopId = `shop-cust-${TEST_SUFFIX}`;
      const customerGid = "gid://shopify/Customer/888";

      await sql`
        INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt")
        VALUES (${shopId}, ${`cust-${TEST_SUFFIX}.myshopify.com`}, ${now}, ${now})
      `;

      await sql`
        INSERT INTO "BuyerAccount" (id, "shopId", kind, "customerId", name, "createdAt", "updatedAt")
        VALUES ('acc1-${TEST_SUFFIX}', ${shopId}, 'TAGGED_CUSTOMER', ${customerGid}, 'Cust1', ${now}, ${now})
      `;

      // Should reject duplicate customerId for same shop
      await expect(
        sql`
          INSERT INTO "BuyerAccount" (id, "shopId", kind, "customerId", name, "createdAt", "updatedAt")
          VALUES ('acc2-${TEST_SUFFIX}', ${shopId}, 'TAGGED_CUSTOMER', ${customerGid}, 'Cust2', ${now}, ${now})
        `
      ).rejects.toThrow(/unique/i);

      await sql`DELETE FROM "Shop" WHERE id = ${shopId}`;
    });

    it("allows NULL UTR (multiple payments without UTR)", async () => {
      const now = new Date();
      const shopId = `shop-null-utr-${TEST_SUFFIX}`;
      const importId = `import-null-utr-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt")
        VALUES (${shopId}, ${`null-utr-${TEST_SUFFIX}.myshopify.com`}, ${now}, ${now})
      `;

      await sql`
        INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
        VALUES (${importId}, ${shopId}, 'hdfc', 'test.csv', 2, ${now})
      `;

      // Both payments have NULL UTR - should be allowed
      await sql`
        INSERT INTO "Payment" (id, "shopId", "importId", "valueDate", amount, utr, narration, "createdAt", "updatedAt")
        VALUES ('pay1-null-${TEST_SUFFIX}', ${shopId}, ${importId}, ${now}, '1000.00', NULL, 'test1', ${now}, ${now})
      `;

      await sql`
        INSERT INTO "Payment" (id, "shopId", "importId", "valueDate", amount, utr, narration, "createdAt", "updatedAt")
        VALUES ('pay2-null-${TEST_SUFFIX}', ${shopId}, ${importId}, ${now}, '2000.00', NULL, 'test2', ${now}, ${now})
      `;

      const payments = await sql<PaymentRow[]>`SELECT * FROM "Payment" WHERE "shopId" = ${shopId}`;
      expect(payments).toHaveLength(2);

      await sql`DELETE FROM "Shop" WHERE id = ${shopId}`;
    });
  });

  describe("Cascade Delete", () => {
    it("deleting a shop cascades to all dependent rows", async () => {
      const now = new Date();
      const shopId = `shop-cascade-${TEST_SUFFIX}`;
      const accountId = `account-cascade-${TEST_SUFFIX}`;
      const invoiceId = `invoice-cascade-${TEST_SUFFIX}`;
      const importId = `import-cascade-${TEST_SUFFIX}`;
      const paymentId = `payment-cascade-${TEST_SUFFIX}`;
      const matchId = `match-cascade-${TEST_SUFFIX}`;
      const ruleId = `rule-cascade-${TEST_SUFFIX}`;
      const logId = `log-cascade-${TEST_SUFFIX}`;
      const sourceId = `source-cascade-${TEST_SUFFIX}`;
      const aliasId = `alias-cascade-${TEST_SUFFIX}`;
      const eventId = `event-cascade-${TEST_SUFFIX}`;

      // Create complete hierarchy
      await sql`
        INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt")
        VALUES (${shopId}, ${`cascade-${TEST_SUFFIX}.myshopify.com`}, ${now}, ${now})
      `;

      await sql`
        INSERT INTO "AccountSource" (id, "shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")
        VALUES (${sourceId}, ${shopId}, 'test', 30, ${now}, ${now})
      `;

      await sql`
        INSERT INTO "BuyerAccount" (id, "shopId", kind, name, "createdAt", "updatedAt")
        VALUES (${accountId}, ${shopId}, 'COMPANY', 'Test', ${now}, ${now})
      `;

      await sql`
        INSERT INTO "PayerAlias" (id, "buyerAccountId", "payerKey", "createdAt")
        VALUES (${aliasId}, ${accountId}, 'test key', ${now})
      `;

      await sql`
        INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", name, total, outstanding, "issuedAt", status, "createdAt", "updatedAt")
        VALUES (${invoiceId}, ${shopId}, ${accountId}, '#1', '100.00', '100.00', ${now}, 'open', ${now}, ${now})
      `;

      await sql`
        INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
        VALUES (${importId}, ${shopId}, 'hdfc', 'test.csv', 1, ${now})
      `;

      await sql`
        INSERT INTO "Payment" (id, "shopId", "importId", "valueDate", amount, narration, "createdAt", "updatedAt")
        VALUES (${paymentId}, ${shopId}, ${importId}, ${now}, '100.00', 'test', ${now}, ${now})
      `;

      await sql`
        INSERT INTO "Match" (id, "paymentId", "invoiceId", amount, score, reasons, "createdAt", "updatedAt")
        VALUES (${matchId}, ${paymentId}, ${invoiceId}, '100.00', 80, '{}', ${now}, ${now})
      `;

      await sql`
        INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, "createdAt", "updatedAt")
        VALUES (${ruleId}, ${shopId}, 0, 'email', ${now}, ${now})
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "ruleId", "invoiceId", "sentAt")
        VALUES (${logId}, ${ruleId}, ${invoiceId}, ${now})
      `;

      await sql`
        INSERT INTO "AuditEvent" (id, "shopId", actor, type, data, at)
        VALUES (${eventId}, ${shopId}, 'test', 'test.event', '{}', ${now})
      `;

      // Verify everything exists
      const [shop] = await sql`SELECT * FROM "Shop" WHERE id = ${shopId}`;
      expect(shop).toBeDefined();

      // Delete shop
      await sql`DELETE FROM "Shop" WHERE id = ${shopId}`;

      // Verify cascade deleted everything
      const [deletedShop] = await sql`SELECT * FROM "Shop" WHERE id = ${shopId}`;
      expect(deletedShop).toBeUndefined();

      const [deletedSource] = await sql`SELECT * FROM "AccountSource" WHERE id = ${sourceId}`;
      expect(deletedSource).toBeUndefined();

      const [deletedAccount] = await sql`SELECT * FROM "BuyerAccount" WHERE id = ${accountId}`;
      expect(deletedAccount).toBeUndefined();

      const [deletedAlias] = await sql`SELECT * FROM "PayerAlias" WHERE id = ${aliasId}`;
      expect(deletedAlias).toBeUndefined();

      const [deletedInvoice] = await sql`SELECT * FROM "Invoice" WHERE id = ${invoiceId}`;
      expect(deletedInvoice).toBeUndefined();

      const [deletedImport] = await sql`SELECT * FROM "BankImport" WHERE id = ${importId}`;
      expect(deletedImport).toBeUndefined();

      const [deletedPayment] = await sql`SELECT * FROM "Payment" WHERE id = ${paymentId}`;
      expect(deletedPayment).toBeUndefined();

      const [deletedMatch] = await sql`SELECT * FROM "Match" WHERE id = ${matchId}`;
      expect(deletedMatch).toBeUndefined();

      const [deletedRule] = await sql`SELECT * FROM "ReminderRule" WHERE id = ${ruleId}`;
      expect(deletedRule).toBeUndefined();

      const [deletedLog] = await sql`SELECT * FROM "ReminderLog" WHERE id = ${logId}`;
      expect(deletedLog).toBeUndefined();

      const [deletedEvent] = await sql`SELECT * FROM "AuditEvent" WHERE id = ${eventId}`;
      expect(deletedEvent).toBeUndefined();
    });
  });

  describe("Decimal Money Fields", () => {
    it("handles decimal money fields correctly", async () => {
      const now = new Date();
      const shopId = `shop-money-${TEST_SUFFIX}`;
      const accountId = `account-money-${TEST_SUFFIX}`;
      const invoiceId = `invoice-money-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt")
        VALUES (${shopId}, ${`money-${TEST_SUFFIX}.myshopify.com`}, ${now}, ${now})
      `;

      await sql`
        INSERT INTO "BuyerAccount" (id, "shopId", kind, name, "creditLimit", "createdAt", "updatedAt")
        VALUES (${accountId}, ${shopId}, 'COMPANY', 'Test', '99999999999999.99', ${now}, ${now})
      `;

      await sql`
        INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", name, total, outstanding, "issuedAt", status, "createdAt", "updatedAt")
        VALUES (${invoiceId}, ${shopId}, ${accountId}, '#1', '12345678901234.56', '12345678901234.56', ${now}, 'open', ${now}, ${now})
      `;

      const [account] = await sql<BuyerAccountRow[]>`SELECT * FROM "BuyerAccount" WHERE id = ${accountId}`;
      expect(account.creditLimit).toBe("99999999999999.99");

      const [invoice] = await sql<InvoiceRow[]>`SELECT * FROM "Invoice" WHERE id = ${invoiceId}`;
      expect(invoice.total).toBe("12345678901234.56");
      expect(invoice.outstanding).toBe("12345678901234.56");

      await sql`DELETE FROM "Shop" WHERE id = ${shopId}`;
    });

    it("handles small decimal amounts correctly", async () => {
      const now = new Date();
      const shopId = `shop-small-${TEST_SUFFIX}`;
      const accountId = `account-small-${TEST_SUFFIX}`;
      const invoiceId = `invoice-small-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt")
        VALUES (${shopId}, ${`small-${TEST_SUFFIX}.myshopify.com`}, ${now}, ${now})
      `;

      await sql`
        INSERT INTO "BuyerAccount" (id, "shopId", kind, name, "creditLimit", "createdAt", "updatedAt")
        VALUES (${accountId}, ${shopId}, 'COMPANY', 'Test', '0.01', ${now}, ${now})
      `;

      await sql`
        INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", name, total, outstanding, "issuedAt", status, "createdAt", "updatedAt")
        VALUES (${invoiceId}, ${shopId}, ${accountId}, '#1', '0.01', '0.00', ${now}, 'open', ${now}, ${now})
      `;

      const [account] = await sql<BuyerAccountRow[]>`SELECT * FROM "BuyerAccount" WHERE id = ${accountId}`;
      expect(account.creditLimit).toBe("0.01");

      const [invoice] = await sql<InvoiceRow[]>`SELECT * FROM "Invoice" WHERE id = ${invoiceId}`;
      expect(invoice.total).toBe("0.01");
      expect(invoice.outstanding).toBe("0.00");

      await sql`DELETE FROM "Shop" WHERE id = ${shopId}`;
    });
  });
});
