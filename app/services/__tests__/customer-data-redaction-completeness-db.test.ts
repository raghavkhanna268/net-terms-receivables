/**
 * Customer data export and redaction completeness tests (Sequential DB).
 *
 * This test verifies that:
 * 1. generateCustomerDataExport includes data from ALL tables that hold customer data
 * 2. redactCustomer clears/anonymizes ALL customer PII across all tables
 * 3. Neither operation leaks PII to logs (regression guard)
 * 4. Cross-customer and cross-shop isolation is maintained
 *
 * Uses real database operations against the test DB.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import {
  generateCustomerDataExport,
  redactCustomer,
} from "../compliance/compliance.server";
import { safeLog } from "~/lib/log.server";
import { customerGid, orderGid, draftOrderGid, companyGid, companyLocationGid } from "../../../tests/helpers/gid";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

/**
 * PINNED LIST: Tables whose data generateCustomerDataExport MUST include.
 *
 * Each entry has a reason matching the actual code behavior in main.
 */
const EXPORT_MUST_CONTAIN: Record<string, string> = {
  s8_tagged_customers: "taggedCustomer field: email, displayName, tags, tagActive, createdAt",
  s8_draft_orders: "draftOrders array: draft orders linked via buyer_account_id to customer's BuyerAccount",
  BuyerAccount: "buyerAccount field: the TAGGED_CUSTOMER account, plus b2bMainContactAccounts for COMPANY accounts where customer is main contact",
  Invoice: "invoices array: all invoices for the customer's BuyerAccount",
  Match: "paymentMatches array: match metadata (amount, state) for customer's invoices",
};

/**
 * PINNED LIST: Tables with customer links that are NOT in the export.
 *
 * Each entry has a reason why it's excluded from export but may be touched by redaction.
 */
const REDACTION_ONLY_OR_NOT_CUSTOMER_DATA: Record<string, string> = {
  Payment: "Intentionally excluded from export - narration/payerText may contain third-party PII from bank statements; redactCustomer clears them",
  PayerAlias: "Implementation detail - learned payer keys from matching; not customer data for export; deleted on redaction",
  ReminderLog: "Operational data - reminder send history linked via Invoice; not customer PII; preserved on redaction",
  s22_data_requests: "Meta table - tracks data request itself, not customer data to export; deleted on redaction to remove stored export",
  rejected_matches: "Merchant match-rejection history (ids and timestamp only, rejectedBy is a merchant staff user id); no buyer PII; not exported; preserved on redaction",
};

/**
 * PINNED LIST: All tables with customer-identifying data.
 * Union of EXPORT_MUST_CONTAIN and REDACTION_ONLY_OR_NOT_CUSTOMER_DATA.
 */
const CUSTOMER_DATA_TABLES = [
  ...Object.keys(EXPORT_MUST_CONTAIN),
  ...Object.keys(REDACTION_ONLY_OR_NOT_CUSTOMER_DATA),
] as const;

describeWithDb("Sequential DB: Customer Data Export and Redaction Completeness", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-completeness";

  // Shop 1 with customers A and B
  const SHOP_1_ID = `shop-1-${TEST_SUFFIX}`;
  const SHOP_1_DOMAIN = `test-shop1-${TEST_SUFFIX}.example.com`;

  // Shop 2 with customers C and D
  const SHOP_2_ID = `shop-2-${TEST_SUFFIX}`;
  const SHOP_2_DOMAIN = `test-shop2-${TEST_SUFFIX}.example.com`;

  // Customer IDs (numeric parts for GID construction)
  const CUSTOMER_A_NUM = 111001;
  const CUSTOMER_B_NUM = 111002;
  const CUSTOMER_C_NUM = 222001;
  const CUSTOMER_D_NUM = 222002;

  const CUSTOMER_A_GID = customerGid(CUSTOMER_A_NUM);
  const CUSTOMER_B_GID = customerGid(CUSTOMER_B_NUM);
  const CUSTOMER_C_GID = customerGid(CUSTOMER_C_NUM);
  const CUSTOMER_D_GID = customerGid(CUSTOMER_D_NUM);

  // Synthetic PII for testing
  const PII = {
    A: { email: "a@example.com", name: "Alice Aardvark" },
    B: { email: "b@example.com", name: "Bob Badger" },
    C: { email: "c@example.com", name: "Carol Crow" },
    D: { email: "d@example.com", name: "Diana Deer" },
  };

  // Resource IDs
  const ACCOUNT_A_ID = `acc-a-${TEST_SUFFIX}`;
  const ACCOUNT_B_ID = `acc-b-${TEST_SUFFIX}`;
  const ACCOUNT_C_ID = `acc-c-${TEST_SUFFIX}`;
  const ACCOUNT_D_ID = `acc-d-${TEST_SUFFIX}`;
  // B2B company account where customer A is the main contact
  const ACCOUNT_B2B_A_CONTACT_ID = `acc-b2b-a-contact-${TEST_SUFFIX}`;
  // B2B company account in shop 2 (must stay untouched)
  const ACCOUNT_B2B_SHOP2_ID = `acc-b2b-shop2-${TEST_SUFFIX}`;
  const IMPORT_1_ID = `import-1-${TEST_SUFFIX}`;
  const IMPORT_2_ID = `import-2-${TEST_SUFFIX}`;

  // Console spies for PII logging check
  let consoleLogSpy: MockInstance;
  let consoleDebugSpy: MockInstance;
  let consoleWarnSpy: MockInstance;
  let consoleErrorSpy: MockInstance;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create Shop 1
    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${SHOP_1_ID}, ${SHOP_1_DOMAIN}, 'INR', NOW(), NOW())
    `;

    // Create Shop 2
    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${SHOP_2_ID}, ${SHOP_2_DOMAIN}, 'INR', NOW(), NOW())
    `;

    // Create BankImports
    await sql`
      INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
      VALUES
        (${IMPORT_1_ID}, ${SHOP_1_ID}, 'test', 'shop1.csv', 10, NOW()),
        (${IMPORT_2_ID}, ${SHOP_2_ID}, 'test', 'shop2.csv', 10, NOW())
    `;

    // Create BuyerAccounts for tagged customers
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, name, "customerId", "createdAt", "updatedAt")
      VALUES
        (${ACCOUNT_A_ID}, ${SHOP_1_ID}, 'TAGGED_CUSTOMER', ${PII.A.name}, ${CUSTOMER_A_GID}, NOW(), NOW()),
        (${ACCOUNT_B_ID}, ${SHOP_1_ID}, 'TAGGED_CUSTOMER', ${PII.B.name}, ${CUSTOMER_B_GID}, NOW(), NOW()),
        (${ACCOUNT_C_ID}, ${SHOP_2_ID}, 'TAGGED_CUSTOMER', ${PII.C.name}, ${CUSTOMER_C_GID}, NOW(), NOW()),
        (${ACCOUNT_D_ID}, ${SHOP_2_ID}, 'TAGGED_CUSTOMER', ${PII.D.name}, ${CUSTOMER_D_GID}, NOW(), NOW())
    `;

    // Create B2B company account in shop 1 where customer A is the main contact
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, name, "companyId", "companyLocationId",
        "mainContactEmail", "mainContactName", "mainContactCustomerId",
        "createdAt", "updatedAt"
      )
      VALUES (
        ${ACCOUNT_B2B_A_CONTACT_ID}, ${SHOP_1_ID}, 'COMPANY', 'Acme Corp Location 1',
        ${companyGid(999001)}, ${companyLocationGid(999001)},
        ${PII.A.email}, ${PII.A.name}, ${CUSTOMER_A_GID},
        NOW(), NOW()
      )
    `;

    // Create B2B company account in shop 2 (must stay untouched by shop 1 redaction)
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, name, "companyId", "companyLocationId",
        "mainContactEmail", "mainContactName", "mainContactCustomerId",
        "createdAt", "updatedAt"
      )
      VALUES (
        ${ACCOUNT_B2B_SHOP2_ID}, ${SHOP_2_ID}, 'COMPANY', 'Shop2 Corp Location 1',
        ${companyGid(999002)}, ${companyLocationGid(999002)},
        ${PII.C.email}, ${PII.C.name}, ${CUSTOMER_C_GID},
        NOW(), NOW()
      )
    `;

    // Create ReminderRules for testing ReminderLogs
    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES
        (${'rule-1-' + TEST_SUFFIX}, ${SHOP_1_ID}, -3, 'email', true, NOW(), NOW()),
        (${'rule-2-' + TEST_SUFFIX}, ${SHOP_2_ID}, -3, 'email', true, NOW(), NOW())
    `;
  });

  afterAll(async () => {
    // Cleanup in FK order
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" IN (${SHOP_1_ID}, ${SHOP_2_ID})`;
    await sql`DELETE FROM "Match" WHERE "shopId" IN (${SHOP_1_ID}, ${SHOP_2_ID})`;
    await sql`DELETE FROM "Payment" WHERE "shopId" IN (${SHOP_1_ID}, ${SHOP_2_ID})`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" IN (${SHOP_1_ID}, ${SHOP_2_ID})`;
    await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" IN (${ACCOUNT_A_ID}, ${ACCOUNT_B_ID}, ${ACCOUNT_C_ID}, ${ACCOUNT_D_ID}, ${ACCOUNT_B2B_A_CONTACT_ID}, ${ACCOUNT_B2B_SHOP2_ID})`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id IN (${SHOP_1_ID}, ${SHOP_2_ID})`;
    await sql`DELETE FROM s8_draft_orders WHERE shop_id IN (${SHOP_1_ID}, ${SHOP_2_ID})`;
    await sql`DELETE FROM s22_data_requests WHERE shop_id IN (${SHOP_1_ID}, ${SHOP_2_ID})`;
    await sql`DELETE FROM "ReminderRule" WHERE "shopId" IN (${SHOP_1_ID}, ${SHOP_2_ID})`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" IN (${SHOP_1_ID}, ${SHOP_2_ID})`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN (${SHOP_1_ID}, ${SHOP_2_ID})`;
    await sql`DELETE FROM "Shop" WHERE id IN (${SHOP_1_ID}, ${SHOP_2_ID})`;
    await sql.end();
  });

  beforeEach(async () => {
    // Reset test data between tests
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" IN (${SHOP_1_ID}, ${SHOP_2_ID})`;
    await sql`DELETE FROM "Match" WHERE "shopId" IN (${SHOP_1_ID}, ${SHOP_2_ID})`;
    await sql`DELETE FROM "Payment" WHERE "shopId" IN (${SHOP_1_ID}, ${SHOP_2_ID})`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" IN (${SHOP_1_ID}, ${SHOP_2_ID})`;
    await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" IN (${ACCOUNT_A_ID}, ${ACCOUNT_B_ID}, ${ACCOUNT_C_ID}, ${ACCOUNT_D_ID}, ${ACCOUNT_B2B_A_CONTACT_ID}, ${ACCOUNT_B2B_SHOP2_ID})`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id IN (${SHOP_1_ID}, ${SHOP_2_ID})`;
    await sql`DELETE FROM s8_draft_orders WHERE shop_id IN (${SHOP_1_ID}, ${SHOP_2_ID})`;
    await sql`DELETE FROM s22_data_requests WHERE shop_id IN (${SHOP_1_ID}, ${SHOP_2_ID})`;

    // Reset BuyerAccounts to original state
    await sql`
      UPDATE "BuyerAccount"
      SET name = ${PII.A.name}, "customerId" = ${CUSTOMER_A_GID},
          "mainContactEmail" = NULL, "mainContactName" = NULL, "mainContactCustomerId" = NULL,
          "updatedAt" = NOW()
      WHERE id = ${ACCOUNT_A_ID}
    `;
    await sql`
      UPDATE "BuyerAccount"
      SET name = ${PII.B.name}, "customerId" = ${CUSTOMER_B_GID},
          "mainContactEmail" = NULL, "mainContactName" = NULL, "mainContactCustomerId" = NULL,
          "updatedAt" = NOW()
      WHERE id = ${ACCOUNT_B_ID}
    `;
    await sql`
      UPDATE "BuyerAccount"
      SET name = ${PII.C.name}, "customerId" = ${CUSTOMER_C_GID},
          "mainContactEmail" = NULL, "mainContactName" = NULL, "mainContactCustomerId" = NULL,
          "updatedAt" = NOW()
      WHERE id = ${ACCOUNT_C_ID}
    `;
    await sql`
      UPDATE "BuyerAccount"
      SET name = ${PII.D.name}, "customerId" = ${CUSTOMER_D_GID},
          "mainContactEmail" = NULL, "mainContactName" = NULL, "mainContactCustomerId" = NULL,
          "updatedAt" = NOW()
      WHERE id = ${ACCOUNT_D_ID}
    `;
    // Reset B2B account with A as main contact
    await sql`
      UPDATE "BuyerAccount"
      SET name = 'Acme Corp Location 1',
          "mainContactEmail" = ${PII.A.email}, "mainContactName" = ${PII.A.name}, "mainContactCustomerId" = ${CUSTOMER_A_GID},
          "updatedAt" = NOW()
      WHERE id = ${ACCOUNT_B2B_A_CONTACT_ID}
    `;
    // Reset B2B account in shop 2
    await sql`
      UPDATE "BuyerAccount"
      SET name = 'Shop2 Corp Location 1',
          "mainContactEmail" = ${PII.C.email}, "mainContactName" = ${PII.C.name}, "mainContactCustomerId" = ${CUSTOMER_C_GID},
          "updatedAt" = NOW()
      WHERE id = ${ACCOUNT_B2B_SHOP2_ID}
    `;

    // Spy on console methods
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleDebugSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  /**
   * Helper to seed all customer data for customer A in shop 1.
   */
  async function seedCustomerAData(): Promise<{
    invoiceId: string;
    paymentId: string;
    matchId: string;
    reminderLogId: string;
    draftOrderId: string;
    aliasId: string;
    dataRequestId: string;
  }> {
    const invoiceId = `inv-a-${TEST_SUFFIX}-${Date.now()}`;
    const paymentId = `pmt-a-${TEST_SUFFIX}-${Date.now()}`;
    const matchId = `match-a-${TEST_SUFFIX}-${Date.now()}`;
    const reminderLogId = `reminder-a-${TEST_SUFFIX}-${Date.now()}`;
    const draftOrderIdVal = `draft-a-${TEST_SUFFIX}-${Date.now()}`;
    const aliasId = `alias-a-${TEST_SUFFIX}-${Date.now()}`;
    const dataRequestId = `datareq-a-${TEST_SUFFIX}-${Date.now()}`;
    const orderIdNum = Date.now();
    const draftOrderGidNum = Date.now() + 1;

    // s8_tagged_customers
    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, email, display_name, created_at, updated_at)
      VALUES (${SHOP_1_ID}, ${CUSTOMER_A_GID}, '["net-terms"]'::jsonb, true, ${PII.A.email}, ${PII.A.name}, NOW(), NOW())
    `;

    // s8_draft_orders
    await sql`
      INSERT INTO s8_draft_orders (id, shop_id, draft_order_id, buyer_account_id, name, total, has_payment_terms, status, created_at, updated_at)
      VALUES (${draftOrderIdVal}, ${SHOP_1_ID}, ${draftOrderGid(draftOrderGidNum)}, ${ACCOUNT_A_ID}, '#D1', 5000.00, true, 'open', NOW(), NOW())
    `;

    // s22_data_requests
    await sql`
      INSERT INTO s22_data_requests (id, shop_id, customer_gid, request_id, received_at, status, export_data, completed_at, expires_at, created_at)
      VALUES (${dataRequestId}, ${SHOP_1_ID}, ${CUSTOMER_A_GID}, ${'req-' + dataRequestId}, NOW(), 'pending', NULL, NULL, NOW() + INTERVAL '30 days', NOW())
    `;

    // Invoice
    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status, "issuedAt", "createdAt", "updatedAt")
      VALUES (${invoiceId}, ${SHOP_1_ID}, ${ACCOUNT_A_ID}, ${orderGid(orderIdNum)}, '#INV-A1', 10000.00, 5000.00, 'open', NOW(), NOW(), NOW())
    `;

    // Payment
    await sql`
      INSERT INTO "Payment" (id, "shopId", "importId", "valueDate", amount, rail, narration, "payerText", status, "createdAt", "updatedAt")
      VALUES (${paymentId}, ${SHOP_1_ID}, ${IMPORT_1_ID}, NOW(), 5000.00, 'NEFT', ${'PAYMENT FROM ' + PII.A.name.toUpperCase()}, ${PII.A.name.toUpperCase()}, 'matched', NOW(), NOW())
    `;

    // Match
    await sql`
      INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
      VALUES (${matchId}, ${SHOP_1_ID}, ${paymentId}, ${invoiceId}, 5000.00, 95, '[]'::jsonb, 'confirmed', NOW(), NOW())
    `;

    // PayerAlias
    await sql`
      INSERT INTO "PayerAlias" (id, "buyerAccountId", "payerKey", "createdAt")
      VALUES (${aliasId}, ${ACCOUNT_A_ID}, ${'alice-aardvark-key'}, NOW())
    `;

    // ReminderLog
    const [rule] = await sql<{ id: string }[]>`
      SELECT id FROM "ReminderRule" WHERE "shopId" = ${SHOP_1_ID} LIMIT 1
    `;
    await sql`
      INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "sentAt")
      VALUES (${reminderLogId}, ${SHOP_1_ID}, ${rule.id}, ${invoiceId}, 'sent', NOW())
    `;

    return { invoiceId, paymentId, matchId, reminderLogId, draftOrderId: draftOrderIdVal, aliasId, dataRequestId };
  }

  /**
   * Helper to seed data for customer B in shop 1.
   */
  async function seedCustomerBData(): Promise<{
    invoiceId: string;
    paymentId: string;
    matchId: string;
  }> {
    const invoiceId = `inv-b-${TEST_SUFFIX}-${Date.now()}`;
    const paymentId = `pmt-b-${TEST_SUFFIX}-${Date.now()}`;
    const matchId = `match-b-${TEST_SUFFIX}-${Date.now()}`;
    const orderIdNum = Date.now() + 100;

    // s8_tagged_customers
    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, email, display_name, created_at, updated_at)
      VALUES (${SHOP_1_ID}, ${CUSTOMER_B_GID}, '["net-terms"]'::jsonb, true, ${PII.B.email}, ${PII.B.name}, NOW(), NOW())
    `;

    // Invoice
    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status, "issuedAt", "createdAt", "updatedAt")
      VALUES (${invoiceId}, ${SHOP_1_ID}, ${ACCOUNT_B_ID}, ${orderGid(orderIdNum)}, '#INV-B1', 8000.00, 8000.00, 'open', NOW(), NOW(), NOW())
    `;

    // Payment
    await sql`
      INSERT INTO "Payment" (id, "shopId", "importId", "valueDate", amount, rail, narration, "payerText", status, "createdAt", "updatedAt")
      VALUES (${paymentId}, ${SHOP_1_ID}, ${IMPORT_1_ID}, NOW(), 8000.00, 'RTGS', ${'PAYMENT FROM ' + PII.B.name.toUpperCase()}, ${PII.B.name.toUpperCase()}, 'matched', NOW(), NOW())
    `;

    // Match
    await sql`
      INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
      VALUES (${matchId}, ${SHOP_1_ID}, ${paymentId}, ${invoiceId}, 8000.00, 90, '[]'::jsonb, 'confirmed', NOW(), NOW())
    `;

    return { invoiceId, paymentId, matchId };
  }

  /**
   * Helper to seed data for customer C in shop 2.
   */
  async function seedCustomerCData(): Promise<{
    invoiceId: string;
    paymentId: string;
    matchId: string;
  }> {
    const invoiceId = `inv-c-${TEST_SUFFIX}-${Date.now()}`;
    const paymentId = `pmt-c-${TEST_SUFFIX}-${Date.now()}`;
    const matchId = `match-c-${TEST_SUFFIX}-${Date.now()}`;
    const orderIdNum = Date.now() + 200;

    // s8_tagged_customers
    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, email, display_name, created_at, updated_at)
      VALUES (${SHOP_2_ID}, ${CUSTOMER_C_GID}, '["wholesale"]'::jsonb, true, ${PII.C.email}, ${PII.C.name}, NOW(), NOW())
    `;

    // Invoice
    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status, "issuedAt", "createdAt", "updatedAt")
      VALUES (${invoiceId}, ${SHOP_2_ID}, ${ACCOUNT_C_ID}, ${orderGid(orderIdNum)}, '#INV-C1', 15000.00, 15000.00, 'open', NOW(), NOW(), NOW())
    `;

    // Payment
    await sql`
      INSERT INTO "Payment" (id, "shopId", "importId", "valueDate", amount, rail, narration, "payerText", status, "createdAt", "updatedAt")
      VALUES (${paymentId}, ${SHOP_2_ID}, ${IMPORT_2_ID}, NOW(), 15000.00, 'IMPS', ${'PAYMENT FROM ' + PII.C.name.toUpperCase()}, ${PII.C.name.toUpperCase()}, 'matched', NOW(), NOW())
    `;

    // Match
    await sql`
      INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
      VALUES (${matchId}, ${SHOP_2_ID}, ${paymentId}, ${invoiceId}, 15000.00, 88, '[]'::jsonb, 'pushed', NOW(), NOW())
    `;

    return { invoiceId, paymentId, matchId };
  }

  /**
   * Get all console output for PII leak detection.
   */
  function getAllConsoleOutput(): string[] {
    const allCalls = [
      ...consoleLogSpy.mock.calls,
      ...consoleDebugSpy.mock.calls,
      ...consoleWarnSpy.mock.calls,
      ...consoleErrorSpy.mock.calls,
    ];
    return allCalls.map((args) =>
      args
        .map((arg: unknown) => (typeof arg === "object" ? JSON.stringify(arg) : String(arg)))
        .join(" ")
    );
  }

  /**
   * Capture full-row JSON snapshot of all of B's rows across all tables.
   */
  async function snapshotCustomerBRows(): Promise<{
    account: unknown;
    tagged: unknown[];
    invoices: unknown[];
    payments: unknown[];
    matches: unknown[];
  }> {
    const [account] = await sql`SELECT to_jsonb(t) as row FROM "BuyerAccount" t WHERE id = ${ACCOUNT_B_ID}`;
    const tagged = await sql`SELECT to_jsonb(t) as row FROM s8_tagged_customers t WHERE shop_id = ${SHOP_1_ID} AND customer_id = ${CUSTOMER_B_GID}`;
    const invoices = await sql`SELECT to_jsonb(t) as row FROM "Invoice" t WHERE "buyerAccountId" = ${ACCOUNT_B_ID}`;
    const payments = await sql`SELECT to_jsonb(t) as row FROM "Payment" t WHERE "shopId" = ${SHOP_1_ID} AND id IN (
      SELECT m."paymentId" FROM "Match" m JOIN "Invoice" i ON m."invoiceId" = i.id WHERE i."buyerAccountId" = ${ACCOUNT_B_ID}
    )`;
    const matches = await sql`SELECT to_jsonb(t) as row FROM "Match" t WHERE t."invoiceId" IN (
      SELECT id FROM "Invoice" WHERE "buyerAccountId" = ${ACCOUNT_B_ID}
    )`;
    return {
      account: account?.row,
      tagged: tagged.map((r) => r.row),
      invoices: invoices.map((r) => r.row),
      payments: payments.map((r) => r.row),
      matches: matches.map((r) => r.row),
    };
  }

  /**
   * Capture full-row JSON snapshot of all of shop 2's customer-related rows.
   */
  async function snapshotShop2Rows(): Promise<{
    accounts: unknown[];
    tagged: unknown[];
    invoices: unknown[];
    payments: unknown[];
    matches: unknown[];
    draftOrders: unknown[];
    dataRequests: unknown[];
  }> {
    const accounts = await sql`SELECT to_jsonb(t) as row FROM "BuyerAccount" t WHERE "shopId" = ${SHOP_2_ID}`;
    const tagged = await sql`SELECT to_jsonb(t) as row FROM s8_tagged_customers t WHERE shop_id = ${SHOP_2_ID}`;
    const invoices = await sql`SELECT to_jsonb(t) as row FROM "Invoice" t WHERE "shopId" = ${SHOP_2_ID}`;
    const payments = await sql`SELECT to_jsonb(t) as row FROM "Payment" t WHERE "shopId" = ${SHOP_2_ID}`;
    const matches = await sql`SELECT to_jsonb(t) as row FROM "Match" t WHERE "shopId" = ${SHOP_2_ID}`;
    const draftOrders = await sql`SELECT to_jsonb(t) as row FROM s8_draft_orders t WHERE shop_id = ${SHOP_2_ID}`;
    const dataRequests = await sql`SELECT to_jsonb(t) as row FROM s22_data_requests t WHERE shop_id = ${SHOP_2_ID}`;
    return {
      accounts: accounts.map((r) => r.row),
      tagged: tagged.map((r) => r.row),
      invoices: invoices.map((r) => r.row),
      payments: payments.map((r) => r.row),
      matches: matches.map((r) => r.row),
      draftOrders: draftOrders.map((r) => r.row),
      dataRequests: dataRequests.map((r) => r.row),
    };
  }

  describe("Coverage Guard", () => {
    it("fails if a new table with customer FK or customer ID column exists that is not in CUSTOMER_DATA_TABLES", async () => {
      // Find tables with FK to BuyerAccount
      const fkToBuyerAccount = await sql<{ table_name: string }[]>`
        SELECT DISTINCT tc.table_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name
          AND tc.table_schema = ccu.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND (ccu.table_name = 'BuyerAccount' OR ccu.table_name = 's8_tagged_customers')
          AND tc.table_schema = 'public'
      `;

      // Find tables with customer ID columns (various naming conventions)
      const tablesWithCustomerCols = await sql<{ table_name: string; column_name: string }[]>`
        SELECT DISTINCT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (
            column_name IN ('customer_id', 'customerId', 'customer_gid', 'customerGid', 'mainContactCustomerId')
            OR column_name LIKE '%customer%'
          )
          AND table_name NOT LIKE '_prisma%'
          AND table_name NOT LIKE 'pg_%'
      `;

      // Combine and deduplicate
      const allCustomerTables = new Set<string>();
      for (const row of fkToBuyerAccount) {
        allCustomerTables.add(row.table_name);
      }
      for (const row of tablesWithCustomerCols) {
        allCustomerTables.add(row.table_name);
      }

      // Also add tables that link through Invoice (which links to BuyerAccount)
      const fkToInvoice = await sql<{ table_name: string }[]>`
        SELECT DISTINCT tc.table_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name
          AND tc.table_schema = ccu.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND ccu.table_name = 'Invoice'
          AND tc.table_schema = 'public'
      `;
      for (const row of fkToInvoice) {
        allCustomerTables.add(row.table_name);
      }

      // Check that all discovered tables are in our pinned list
      const pinnedSet = new Set(CUSTOMER_DATA_TABLES);
      const uncoveredTables: string[] = [];

      for (const table of allCustomerTables) {
        if (!pinnedSet.has(table)) {
          uncoveredTables.push(table);
        }
      }

      expect(
        uncoveredTables,
        `Uncovered tables with customer data: ${uncoveredTables.join(", ")}. ` +
          `Add them to CUSTOMER_DATA_TABLES or confirm they don't need export/redaction.`
      ).toHaveLength(0);
    });

    it("positive control: discovery query finds known customer tables BuyerAccount and s8_tagged_customers", async () => {
      // This ensures the information_schema queries actually work
      const tablesWithCustomerCols = await sql<{ table_name: string }[]>`
        SELECT DISTINCT table_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name IN ('customer_id', 'customerId', 'mainContactCustomerId')
      `;

      const tableNames = tablesWithCustomerCols.map((r) => r.table_name);
      expect(tableNames).toContain("BuyerAccount");
      expect(tableNames).toContain("s8_tagged_customers");
    });
  });

  describe("Case 1: generateCustomerDataExport completeness", () => {
    it("includes data from EVERY EXPORT_MUST_CONTAIN table with A's seeded rows", async () => {
      const seededA = await seedCustomerAData();

      const requestId = `req-export-${TEST_SUFFIX}`;
      const exportResult = await generateCustomerDataExport(
        sql,
        SHOP_1_ID,
        CUSTOMER_A_GID,
        requestId
      );

      // Verify export contains data from all EXPORT_MUST_CONTAIN tables
      expect(exportResult.customerGid).toBe(CUSTOMER_A_GID);

      // s8_tagged_customers
      expect(exportResult.data.taggedCustomer).not.toBeNull();
      expect(exportResult.data.taggedCustomer?.email).toBe(PII.A.email);
      expect(exportResult.data.taggedCustomer?.displayName).toBe(PII.A.name);
      expect(exportResult.data.taggedCustomer?.tags).toEqual(["net-terms"]);

      // BuyerAccount (TAGGED_CUSTOMER account)
      expect(exportResult.data.buyerAccount).not.toBeNull();
      expect(exportResult.data.buyerAccount?.id).toBe(ACCOUNT_A_ID);
      expect(exportResult.data.buyerAccount?.name).toBe(PII.A.name);

      // BuyerAccount (b2bMainContactAccounts - COMPANY accounts where A is main contact)
      expect(exportResult.data.b2bMainContactAccounts.length).toBe(1);
      expect(exportResult.data.b2bMainContactAccounts[0].id).toBe(ACCOUNT_B2B_A_CONTACT_ID);
      expect(exportResult.data.b2bMainContactAccounts[0].mainContactEmail).toBe(PII.A.email);
      expect(exportResult.data.b2bMainContactAccounts[0].mainContactName).toBe(PII.A.name);
      expect(exportResult.data.b2bMainContactAccounts[0].mainContactCustomerId).toBe(CUSTOMER_A_GID);

      // s8_draft_orders
      expect(exportResult.data.draftOrders.length).toBe(1);
      expect(exportResult.data.draftOrders[0].id).toBe(seededA.draftOrderId);
      expect(exportResult.data.draftOrders[0].name).toBe("#D1");

      // Invoice
      expect(exportResult.data.invoices.length).toBe(1);
      expect(exportResult.data.invoices[0].id).toBe(seededA.invoiceId);
      expect(exportResult.data.invoices[0].name).toBe("#INV-A1");

      // Match (via paymentMatches)
      expect(exportResult.data.paymentMatches.length).toBe(1);
      expect(exportResult.data.paymentMatches[0].id).toBe(seededA.matchId);
      expect(exportResult.data.paymentMatches[0].invoiceId).toBe(seededA.invoiceId);
    });

    it("export contains NOTHING from customer B (same shop, different customer)", async () => {
      await seedCustomerAData();
      const seededB = await seedCustomerBData();

      const requestId = `req-export-isolation-${TEST_SUFFIX}`;
      const exportResult = await generateCustomerDataExport(
        sql,
        SHOP_1_ID,
        CUSTOMER_A_GID,
        requestId
      );

      const exportJson = JSON.stringify(exportResult);

      // Must not contain B's PII
      expect(exportJson).not.toContain(PII.B.email);
      expect(exportJson).not.toContain(PII.B.name);
      expect(exportJson).not.toContain(CUSTOMER_B_GID);

      // Must not contain B's resources
      expect(exportJson).not.toContain(seededB.invoiceId);
      expect(exportJson).not.toContain(seededB.paymentId);
      expect(exportJson).not.toContain(seededB.matchId);
    });

    it("export contains NOTHING from shop 2", async () => {
      await seedCustomerAData();
      const seededC = await seedCustomerCData();

      const requestId = `req-export-shop-isolation-${TEST_SUFFIX}`;
      const exportResult = await generateCustomerDataExport(
        sql,
        SHOP_1_ID,
        CUSTOMER_A_GID,
        requestId
      );

      const exportJson = JSON.stringify(exportResult);

      // Must not contain C's PII
      expect(exportJson).not.toContain(PII.C.email);
      expect(exportJson).not.toContain(PII.C.name);
      expect(exportJson).not.toContain(CUSTOMER_C_GID);

      // Must not contain shop 2 resources
      expect(exportJson).not.toContain(seededC.invoiceId);
      expect(exportJson).not.toContain(SHOP_2_ID);
      expect(exportJson).not.toContain(SHOP_2_DOMAIN);
    });
  });

  describe("Case 2: redactCustomer completeness", () => {
    it("clears or anonymizes all PII fields for customer A in every table", async () => {
      const seededA = await seedCustomerAData();

      // Perform redaction
      const result = await redactCustomer(sql, SHOP_1_ID, CUSTOMER_A_GID);

      // Verify return counts
      expect(result.taggedCustomersDeleted).toBe(1);
      expect(result.buyerAccountAnonymized).toBe(true);
      expect(result.paymentsRedacted).toBe(1);
      expect(result.payerAliasesDeleted).toBe(1);
      expect(result.dataRequestsDeleted).toBe(1);
      expect(result.draftOrdersDeleted).toBe(1);
      expect(result.b2bMainContactsRedacted).toBe(1);

      // Verify BuyerAccount anonymized
      const [accountA] = await sql<{ name: string; customerId: string }[]>`
        SELECT name, "customerId" FROM "BuyerAccount" WHERE id = ${ACCOUNT_A_ID}
      `;
      expect(accountA.name).toBe("Redacted Customer");
      expect(accountA.customerId).toContain("_redacted_");

      // Verify B2B account mainContact fields nulled
      const [b2bAccount] = await sql<{
        mainContactEmail: string | null;
        mainContactName: string | null;
        mainContactCustomerId: string | null;
      }[]>`
        SELECT "mainContactEmail", "mainContactName", "mainContactCustomerId"
        FROM "BuyerAccount" WHERE id = ${ACCOUNT_B2B_A_CONTACT_ID}
      `;
      expect(b2bAccount.mainContactEmail).toBeNull();
      expect(b2bAccount.mainContactName).toBeNull();
      expect(b2bAccount.mainContactCustomerId).toBeNull();

      // Verify Payment PII redacted
      const [paymentA] = await sql<{ narration: string; payerText: string | null; amount: string; rail: string }[]>`
        SELECT narration, "payerText", amount::text, rail FROM "Payment" WHERE id = ${seededA.paymentId}
      `;
      expect(paymentA.narration).toBe("[REDACTED]");
      expect(paymentA.payerText).toBeNull();
      // Financial data preserved
      expect(paymentA.amount).toBe("5000.00");
      expect(paymentA.rail).toBe("NEFT");

      // Verify s8_tagged_customers deleted
      const taggedA = await sql<{ id: string }[]>`
        SELECT id FROM s8_tagged_customers WHERE shop_id = ${SHOP_1_ID} AND customer_id = ${CUSTOMER_A_GID}
      `;
      expect(taggedA).toHaveLength(0);

      // Verify s8_draft_orders deleted
      const draftsA = await sql<{ id: string }[]>`
        SELECT id FROM s8_draft_orders WHERE shop_id = ${SHOP_1_ID} AND buyer_account_id = ${ACCOUNT_A_ID}
      `;
      expect(draftsA).toHaveLength(0);

      // Verify s22_data_requests deleted
      const dataReqA = await sql<{ id: string }[]>`
        SELECT id FROM s22_data_requests WHERE shop_id = ${SHOP_1_ID} AND customer_gid = ${CUSTOMER_A_GID}
      `;
      expect(dataReqA).toHaveLength(0);

      // Verify PayerAlias deleted
      const aliasA = await sql<{ id: string }[]>`
        SELECT id FROM "PayerAlias" WHERE "buyerAccountId" = ${ACCOUNT_A_ID}
      `;
      expect(aliasA).toHaveLength(0);

      // Verify financial records preserved (Invoice, Match, ReminderLog still exist)
      const invoiceA = await sql<{ id: string; total: string; outstanding: string; status: string }[]>`
        SELECT id, total::text, outstanding::text, status FROM "Invoice" WHERE id = ${seededA.invoiceId}
      `;
      expect(invoiceA).toHaveLength(1);
      expect(invoiceA[0].total).toBe("10000.00");

      const matchA = await sql<{ id: string; amount: string; state: string }[]>`
        SELECT id, amount::text, state FROM "Match" WHERE id = ${seededA.matchId}
      `;
      expect(matchA).toHaveLength(1);
      expect(matchA[0].amount).toBe("5000.00");

      // Verify ReminderLog preserved (pinned as not deleted on redaction)
      const reminderLogA = await sql<{ id: string }[]>`
        SELECT id FROM "ReminderLog" WHERE id = ${seededA.reminderLogId}
      `;
      expect(reminderLogA).toHaveLength(1);
      expect(reminderLogA[0].id).toBe(seededA.reminderLogId);
    });

    it("customer B is byte-for-byte untouched (full-row snapshots)", async () => {
      await seedCustomerAData();
      await seedCustomerBData();

      // Capture B's full-row state BEFORE redaction
      const bBefore = await snapshotCustomerBRows();

      // Redact A
      await redactCustomer(sql, SHOP_1_ID, CUSTOMER_A_GID);

      // Capture B's full-row state AFTER redaction
      const bAfter = await snapshotCustomerBRows();

      // All of B's rows must be byte-for-byte identical
      expect(bAfter.account).toEqual(bBefore.account);
      expect(bAfter.tagged).toEqual(bBefore.tagged);
      expect(bAfter.invoices).toEqual(bBefore.invoices);
      expect(bAfter.payments).toEqual(bBefore.payments);
      expect(bAfter.matches).toEqual(bBefore.matches);
    });

    it("shop 2 is completely untouched (full-row snapshots)", async () => {
      await seedCustomerAData();
      await seedCustomerCData();

      // Capture shop 2's full-row state BEFORE redaction
      const shop2Before = await snapshotShop2Rows();

      // Redact A in shop 1
      await redactCustomer(sql, SHOP_1_ID, CUSTOMER_A_GID);

      // Capture shop 2's full-row state AFTER redaction
      const shop2After = await snapshotShop2Rows();

      // All of shop 2's rows must be byte-for-byte identical
      expect(shop2After.accounts).toEqual(shop2Before.accounts);
      expect(shop2After.tagged).toEqual(shop2Before.tagged);
      expect(shop2After.invoices).toEqual(shop2Before.invoices);
      expect(shop2After.payments).toEqual(shop2Before.payments);
      expect(shop2After.matches).toEqual(shop2Before.matches);
      expect(shop2After.draftOrders).toEqual(shop2Before.draftOrders);
      expect(shop2After.dataRequests).toEqual(shop2Before.dataRequests);
    });

    it("second redaction run is idempotent: all counts 0, row counts unchanged", async () => {
      await seedCustomerAData();

      // First redaction
      const result1 = await redactCustomer(sql, SHOP_1_ID, CUSTOMER_A_GID);
      expect(result1.buyerAccountAnonymized).toBe(true);
      expect(result1.taggedCustomersDeleted).toBe(1);
      expect(result1.draftOrdersDeleted).toBe(1);
      expect(result1.dataRequestsDeleted).toBe(1);
      expect(result1.payerAliasesDeleted).toBe(1);
      expect(result1.paymentsRedacted).toBe(1);
      expect(result1.b2bMainContactsRedacted).toBe(1);

      // Capture row counts after first redaction
      const taggedCount1 = await sql`SELECT COUNT(*) as cnt FROM s8_tagged_customers WHERE shop_id = ${SHOP_1_ID}`;
      const draftCount1 = await sql`SELECT COUNT(*) as cnt FROM s8_draft_orders WHERE shop_id = ${SHOP_1_ID}`;
      const dataReqCount1 = await sql`SELECT COUNT(*) as cnt FROM s22_data_requests WHERE shop_id = ${SHOP_1_ID}`;
      const aliasCount1 = await sql`SELECT COUNT(*) as cnt FROM "PayerAlias" WHERE "buyerAccountId" = ${ACCOUNT_A_ID}`;
      const invoiceCount1 = await sql`SELECT COUNT(*) as cnt FROM "Invoice" WHERE "shopId" = ${SHOP_1_ID}`;
      const matchCount1 = await sql`SELECT COUNT(*) as cnt FROM "Match" WHERE "shopId" = ${SHOP_1_ID}`;
      const paymentCount1 = await sql`SELECT COUNT(*) as cnt FROM "Payment" WHERE "shopId" = ${SHOP_1_ID}`;
      const reminderLogCount1 = await sql`SELECT COUNT(*) as cnt FROM "ReminderLog" WHERE "shopId" = ${SHOP_1_ID}`;

      // Second redaction
      const result2 = await redactCustomer(sql, SHOP_1_ID, CUSTOMER_A_GID);

      // Should report ALL zeros (already redacted)
      expect(result2.buyerAccountAnonymized).toBe(false);
      expect(result2.taggedCustomersDeleted).toBe(0);
      expect(result2.draftOrdersDeleted).toBe(0);
      expect(result2.dataRequestsDeleted).toBe(0);
      expect(result2.payerAliasesDeleted).toBe(0);
      expect(result2.paymentsRedacted).toBe(0);
      expect(result2.b2bMainContactsRedacted).toBe(0);

      // Row counts unchanged
      const taggedCount2 = await sql`SELECT COUNT(*) as cnt FROM s8_tagged_customers WHERE shop_id = ${SHOP_1_ID}`;
      const draftCount2 = await sql`SELECT COUNT(*) as cnt FROM s8_draft_orders WHERE shop_id = ${SHOP_1_ID}`;
      const dataReqCount2 = await sql`SELECT COUNT(*) as cnt FROM s22_data_requests WHERE shop_id = ${SHOP_1_ID}`;
      const aliasCount2 = await sql`SELECT COUNT(*) as cnt FROM "PayerAlias" WHERE "buyerAccountId" = ${ACCOUNT_A_ID}`;
      const invoiceCount2 = await sql`SELECT COUNT(*) as cnt FROM "Invoice" WHERE "shopId" = ${SHOP_1_ID}`;
      const matchCount2 = await sql`SELECT COUNT(*) as cnt FROM "Match" WHERE "shopId" = ${SHOP_1_ID}`;
      const paymentCount2 = await sql`SELECT COUNT(*) as cnt FROM "Payment" WHERE "shopId" = ${SHOP_1_ID}`;
      const reminderLogCount2 = await sql`SELECT COUNT(*) as cnt FROM "ReminderLog" WHERE "shopId" = ${SHOP_1_ID}`;

      expect(taggedCount2[0].cnt).toBe(taggedCount1[0].cnt);
      expect(draftCount2[0].cnt).toBe(draftCount1[0].cnt);
      expect(dataReqCount2[0].cnt).toBe(dataReqCount1[0].cnt);
      expect(aliasCount2[0].cnt).toBe(aliasCount1[0].cnt);
      expect(invoiceCount2[0].cnt).toBe(invoiceCount1[0].cnt);
      expect(matchCount2[0].cnt).toBe(matchCount1[0].cnt);
      expect(paymentCount2[0].cnt).toBe(paymentCount1[0].cnt);
      expect(reminderLogCount2[0].cnt).toBe(reminderLogCount1[0].cnt);
    });

    it("financial amounts on invoices, payments and matches are retained after redaction", async () => {
      const seededA = await seedCustomerAData();

      await redactCustomer(sql, SHOP_1_ID, CUSTOMER_A_GID);

      // Invoice amounts preserved
      const [invoice] = await sql<{ total: string; outstanding: string }[]>`
        SELECT total::text, outstanding::text FROM "Invoice" WHERE id = ${seededA.invoiceId}
      `;
      expect(invoice.total).toBe("10000.00");
      expect(invoice.outstanding).toBe("5000.00");

      // Payment amount preserved
      const [payment] = await sql<{ amount: string }[]>`
        SELECT amount::text FROM "Payment" WHERE id = ${seededA.paymentId}
      `;
      expect(payment.amount).toBe("5000.00");

      // Match amount preserved
      const [match] = await sql<{ amount: string }[]>`
        SELECT amount::text FROM "Match" WHERE id = ${seededA.matchId}
      `;
      expect(match.amount).toBe("5000.00");
    });
  });

  describe("Case 3: No PII in logs if logging is added (regression guard)", () => {
    it("positive control: console spy captures real safeLog output", () => {
      // Prove the spy works by calling safeLog with an allowlisted code
      safeLog("info", "test_positive_control", { shopId: "test-shop-id", count: 42 });

      const allOutput = getAllConsoleOutput();
      expect(allOutput.length).toBeGreaterThan(0);
      expect(allOutput.some((line) => line.includes("test_positive_control"))).toBe(true);
      expect(allOutput.some((line) => line.includes("test-shop-id"))).toBe(true);
    });

    it("generateCustomerDataExport logs contain no PII (names, emails)", async () => {
      await seedCustomerAData();
      await seedCustomerBData();

      const requestId = `req-log-${TEST_SUFFIX}`;
      await generateCustomerDataExport(sql, SHOP_1_ID, CUSTOMER_A_GID, requestId);

      const allOutput = getAllConsoleOutput().join("\n");

      // No customer names
      expect(allOutput).not.toContain(PII.A.name);
      expect(allOutput).not.toContain(PII.B.name);

      // No customer emails
      expect(allOutput).not.toContain(PII.A.email);
      expect(allOutput).not.toContain(PII.B.email);

      // No shop domain (would be redacted by safeLog)
      expect(allOutput).not.toContain(SHOP_1_DOMAIN);
    });

    it("redactCustomer logs contain no PII (names, emails)", async () => {
      await seedCustomerAData();
      await seedCustomerBData();

      await redactCustomer(sql, SHOP_1_ID, CUSTOMER_A_GID);

      const allOutput = getAllConsoleOutput().join("\n");

      // No customer names
      expect(allOutput).not.toContain(PII.A.name);
      expect(allOutput).not.toContain(PII.B.name);

      // No customer emails
      expect(allOutput).not.toContain(PII.A.email);
      expect(allOutput).not.toContain(PII.B.email);

      // No shop domain
      expect(allOutput).not.toContain(SHOP_1_DOMAIN);
    });
  });
});
