/**
 * DB-backed integration tests for v1.1 reconcile delete-missing.
 *
 * Tests the full-reconcile delete-missing feature:
 * (a) After a COMPLETE RECONCILE_DRAFT_ORDERS bulk run, mark local s8_draft_orders
 *     rows with status open or invoice_sent that were NOT seen as closed.
 * (b) After a COMPLETE tagged-customer reconcile, set tag_active=false on local
 *     tagged customers not present in the export.
 *
 * Safety requirements:
 * - Scope every update strictly to that shop (shop_id in WHERE)
 * - Soft only: mark closed or inactive, never hard-delete
 * - Never touch redacted rows (excluded explicitly via strpos)
 * - Never touch rows with NULL last_seen_bulk_op_id (webhook upserts)
 * - Only close/deactivate rows with a different last_seen_bulk_op_id than the current op
 *
 * Uses native PostgreSQL with all migrations applied.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { closeMissingDraftOrders, getPendingExposure } from "../draft-order.server";
import { deactivateMissingTaggedCustomers } from "../customer.server";
import * as creditRecompute from "~/services/credit-status-recompute.server";
import {
  saveBulkOperationProgress,
  claimBulkCompletion,
  acquireProcessingLease,
  handleReconcileDeleteMissing,
  type BulkOperationStatusResult,
} from "../bulk-jsonl-processor.server";

vi.mock("../../drain/admin-client.server", () => ({
  adminGraphQL: vi.fn(),
  BULK_OPERATION_STATUS_QUERY: "mock-query",
}));

vi.mock("~/lib/request-context.server", () => ({
  getRequestEnv: vi.fn(() => ({ CUSTOMER_PII_FIELDS: "1" })),
  getRequestSql: vi.fn(() => ({})),
  getRequestWaitUntil: vi.fn(() => () => {}),
  requestContext: { getStore: vi.fn() },
}));

vi.mock("~/shopify.server", () => ({
  sessionStorage: {},
  shopify: {},
}));

vi.mock("~/services/sync/company.server", () => ({
  isWebhookProcessed: vi.fn().mockResolvedValue(false),
  markWebhookProcessed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("~/services/sync/company-location.server", () => ({
  mapCompanyLocationToBuyerAccount: vi.fn(() => ({})),
  bulkUpsertBuyerAccounts: vi.fn().mockResolvedValue(0),
}));

vi.mock("~/services/sync/order.server", () => ({
  mapOrderToInvoiceWithEligibility: vi.fn(() => ({ invoiceData: {}, outstandingMissing: false })),
  bulkUpsertInvoices: vi.fn().mockResolvedValue(0),
}));

vi.mock("~/lib/invoice-eligibility", () => ({
  checkOrderEligibility: vi.fn().mockResolvedValue({ eligible: true, buyerAccountId: "buyer-mock" }),
  getEligibilityContext: vi.fn().mockResolvedValue({ shop: { id: "shop-123" } }),
  isTerminalFinancialStatus: vi.fn().mockReturnValue(false),
}));

vi.mock("~/services/sync/customer.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("../customer.server")>();
  return {
    ...original,
    processBulkCustomer: vi.fn().mockResolvedValue({ success: true, action: "skipped" }),
    getTagRules: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("~/services/sync/draft-order.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("../draft-order.server")>();
  return {
    ...original,
    processBulkDraftOrder: vi.fn().mockResolvedValue({ success: true, action: "upserted" }),
    mapDraftOrderToDraft: vi.fn().mockReturnValue({
      draftOrderId: "test-draft-id",
      name: "#TEST",
      total: "1000.00",
      hasPaymentTerms: true,
      status: "open",
    }),
  };
});

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("v1.1 reconcile delete-missing (DB-backed)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-v11dm";
  const TEST_SHOP_ID = `shop-v11dm-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-v11dm-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `account-v11dm-${TEST_SUFFIX}`;
  const TEST_COMPANY_ID = `company-v11dm-${TEST_SUFFIX}`;
  const TEST_LOCATION_ID = `location-v11dm-${TEST_SUFFIX}`;

  const SHOP_B_ID = `shop-v11dm-b-${TEST_SUFFIX}`;
  const SHOP_B_DOMAIN = `test-v11dm-b-${TEST_SUFFIX}.myshopify.com`;

  const CURRENT_BULK_OP_ID = `bulk-op-current-${TEST_SUFFIX}`;
  const OLD_BULK_OP_ID = `bulk-op-old-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${SHOP_B_ID}, ${SHOP_B_DOMAIN}, 'INR', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "createdAt", "updatedAt"
      ) VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY', ${TEST_COMPANY_ID}, ${TEST_LOCATION_ID}, 'Test V11 Company',
        NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "AccountSource" ("id", "shopId", "tag", "defaultTermsDays", "createdAt", "updatedAt")
      VALUES (
        ${"as-v11dm-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, 'net-terms', 30, NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM s6_bulk_operations WHERE shop IN (${TEST_SHOP_DOMAIN}, ${SHOP_B_DOMAIN})`;
    await sql`DELETE FROM s8_draft_orders WHERE shop_id IN (${TEST_SHOP_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id IN (${TEST_SHOP_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "AccountSource" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN (${TEST_SHOP_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "Shop" WHERE id IN (${TEST_SHOP_ID}, ${SHOP_B_ID})`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM s8_draft_orders WHERE shop_id IN (${TEST_SHOP_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id IN (${TEST_SHOP_ID}, ${SHOP_B_ID})`;
  });

  describe("closeMissingDraftOrders", () => {
    it("closes drafts with a different last_seen_bulk_op_id", async () => {
      const draftMissing = `draft-order-missing-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES (
          ${TEST_SHOP_ID}, ${draftMissing}, ${TEST_ACCOUNT_ID}, '#MISSING', '1000.00',
          true, 'open', NOW(), NOW(), ${OLD_BULK_OP_ID}
        )
      `;

      const { closedCount } = await closeMissingDraftOrders(sql, TEST_SHOP_ID, CURRENT_BULK_OP_ID);

      expect(closedCount).toBe(1);

      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftMissing}
      `;
      expect(row.status).toBe("closed");
    });

    it("does NOT close drafts with matching last_seen_bulk_op_id (seen in current run)", async () => {
      const draftSeen = `draft-order-seen-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES (
          ${TEST_SHOP_ID}, ${draftSeen}, ${TEST_ACCOUNT_ID}, '#SEEN', '2000.00',
          true, 'open', NOW(), NOW(), ${CURRENT_BULK_OP_ID}
        )
      `;

      const { closedCount } = await closeMissingDraftOrders(sql, TEST_SHOP_ID, CURRENT_BULK_OP_ID);

      expect(closedCount).toBe(0);

      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftSeen}
      `;
      expect(row.status).toBe("open");
    });

    it("does NOT close drafts with NULL last_seen_bulk_op_id (webhook upserts)", async () => {
      const draftWebhook = `draft-order-webhook-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES (
          ${TEST_SHOP_ID}, ${draftWebhook}, ${TEST_ACCOUNT_ID}, '#WEBHOOK', '3000.00',
          true, 'open', NOW(), NOW(), NULL
        )
      `;

      const { closedCount } = await closeMissingDraftOrders(sql, TEST_SHOP_ID, CURRENT_BULK_OP_ID);

      expect(closedCount).toBe(0);

      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftWebhook}
      `;
      expect(row.status).toBe("open");
    });

    it("does NOT touch another shop's rows (scoped by shop_id)", async () => {
      const draftShopB = `draft-order-shopb-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, name, total,
          has_payment_terms, status, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES (
          ${SHOP_B_ID}, ${draftShopB}, '#SHOPB', '3000.00',
          true, 'open', NOW(), NOW(), ${OLD_BULK_OP_ID}
        )
      `;

      const { closedCount } = await closeMissingDraftOrders(sql, TEST_SHOP_ID, CURRENT_BULK_OP_ID);

      expect(closedCount).toBe(0);

      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftShopB}
      `;
      expect(row.status).toBe("open");
    });

    it("only closes open and invoice_sent drafts, not completed or closed ones", async () => {
      const draftOpen = `draft-order-status-open-${TEST_SUFFIX}`;
      const draftSent = `draft-order-status-sent-${TEST_SUFFIX}`;
      const draftCompleted = `draft-order-status-completed-${TEST_SUFFIX}`;
      const draftClosed = `draft-order-status-closed-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s8_draft_orders (shop_id, draft_order_id, name, total, has_payment_terms, status, created_at, updated_at, last_seen_bulk_op_id)
        VALUES
          (${TEST_SHOP_ID}, ${draftOpen}, '#OPEN', '1000.00', true, 'open', NOW(), NOW(), ${OLD_BULK_OP_ID}),
          (${TEST_SHOP_ID}, ${draftSent}, '#SENT', '2000.00', true, 'invoice_sent', NOW(), NOW(), ${OLD_BULK_OP_ID}),
          (${TEST_SHOP_ID}, ${draftCompleted}, '#COMPLETED', '3000.00', true, 'completed', NOW(), NOW(), ${OLD_BULK_OP_ID}),
          (${TEST_SHOP_ID}, ${draftClosed}, '#CLOSED', '4000.00', true, 'closed', NOW(), NOW(), ${OLD_BULK_OP_ID})
      `;

      const { closedCount } = await closeMissingDraftOrders(sql, TEST_SHOP_ID, CURRENT_BULK_OP_ID);

      expect(closedCount).toBe(2);

      const rows = await sql<{ draft_order_id: string; status: string }[]>`
        SELECT draft_order_id, status FROM s8_draft_orders
        WHERE shop_id = ${TEST_SHOP_ID}
        ORDER BY draft_order_id
      `;

      const openRow = rows.find((r) => r.draft_order_id === draftOpen);
      const sentRow = rows.find((r) => r.draft_order_id === draftSent);
      const completedRow = rows.find((r) => r.draft_order_id === draftCompleted);
      const closedRow = rows.find((r) => r.draft_order_id === draftClosed);

      expect(openRow?.status).toBe("closed");
      expect(sentRow?.status).toBe("closed");
      expect(completedRow?.status).toBe("completed");
      expect(closedRow?.status).toBe("closed");
    });

    it("does NOT touch redacted rows (buyer account with _redacted_ in customerId)", async () => {
      const redactedCustomerId = `customer-redacted-cust-${TEST_SUFFIX}_redacted_1698500000000`;
      const redactedAccountId = `account-redacted-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "customerId", name, "createdAt", "updatedAt"
        ) VALUES (
          ${redactedAccountId}, ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER', ${redactedCustomerId}, 'Redacted Customer',
          NOW(), NOW()
        )
      `;

      const draftRedacted = `draft-order-redacted-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES (
          ${TEST_SHOP_ID}, ${draftRedacted}, ${redactedAccountId}, '#REDACTED', '5000.00',
          true, 'open', NOW(), NOW(), ${OLD_BULK_OP_ID}
        )
      `;

      const { closedCount } = await closeMissingDraftOrders(sql, TEST_SHOP_ID, CURRENT_BULK_OP_ID);

      expect(closedCount).toBe(0);

      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftRedacted}
      `;
      expect(row.status).toBe("open");

      await sql`DELETE FROM s8_draft_orders WHERE draft_order_id = ${draftRedacted}`;
      await sql`DELETE FROM "BuyerAccount" WHERE id = ${redactedAccountId}`;
    });

    it("returns affected account IDs for recompute", async () => {
      const draft1 = `draft-order-affected1-${TEST_SUFFIX}`;
      const draft2 = `draft-order-affected2-${TEST_SUFFIX}`;
      const account2Id = `account-v11dm-2-${TEST_SUFFIX}`;
      const company2Id = `company2-v11dm-${TEST_SUFFIX}`;
      const location2Id = `location2-v11dm-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name, "createdAt", "updatedAt"
        ) VALUES (
          ${account2Id}, ${TEST_SHOP_ID}, 'COMPANY', ${company2Id}, ${location2Id}, 'Test V11 Company 2', NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO s8_draft_orders (shop_id, draft_order_id, buyer_account_id, name, total, has_payment_terms, status, created_at, updated_at, last_seen_bulk_op_id)
        VALUES
          (${TEST_SHOP_ID}, ${draft1}, ${TEST_ACCOUNT_ID}, '#AFF1', '1000.00', true, 'open', NOW(), NOW(), ${OLD_BULK_OP_ID}),
          (${TEST_SHOP_ID}, ${draft2}, ${account2Id}, '#AFF2', '2000.00', true, 'open', NOW(), NOW(), ${OLD_BULK_OP_ID})
      `;

      const { closedCount, affectedAccountIds } = await closeMissingDraftOrders(sql, TEST_SHOP_ID, CURRENT_BULK_OP_ID);

      expect(closedCount).toBe(2);
      expect(affectedAccountIds).toHaveLength(2);
      expect(affectedAccountIds).toContain(TEST_ACCOUNT_ID);
      expect(affectedAccountIds).toContain(account2Id);

      await sql`DELETE FROM "BuyerAccount" WHERE id = ${account2Id}`;
    });

    it("handles draft with null buyer_account_id correctly", async () => {
      const draftNullAccount = `draft-order-null-account-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES (
          ${TEST_SHOP_ID}, ${draftNullAccount}, NULL, '#NULLACCOUNT', '6000.00',
          true, 'open', NOW(), NOW(), ${OLD_BULK_OP_ID}
        )
      `;

      const { closedCount, affectedAccountIds } = await closeMissingDraftOrders(sql, TEST_SHOP_ID, CURRENT_BULK_OP_ID);

      expect(closedCount).toBe(1);
      expect(affectedAccountIds).toHaveLength(0);

      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftNullAccount}
      `;
      expect(row.status).toBe("closed");
    });
  });

  describe("deactivateMissingTaggedCustomers (conservative)", () => {
    function mockAdminGraphQL(existingIds: string[]) {
      const existingSet = new Set(existingIds);
      return vi.fn().mockImplementation(async (_shop: string, _query: string, vars: { ids: string[] }) => ({
        success: true,
        data: {
          nodes: vars.ids.map((id) => (existingSet.has(id) ? { id } : null)),
        },
      }));
    }

    function mockAdminGraphQLFailure() {
      return vi.fn().mockResolvedValue({
        success: false,
        error: "Network error",
        retryable: true,
      });
    }

    it("deactivates customers gone from Shopify (nodes returns null)", async () => {
      const customerGone = `customer-gone-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO s8_tagged_customers (
          shop_id, customer_id, tags, tag_active, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES (
          ${TEST_SHOP_ID}, ${customerGone}, '["net-terms"]'::jsonb, true,
          NOW(), NOW(), ${OLD_BULK_OP_ID}
        )
      `;

      const adminMock = mockAdminGraphQL([]);
      const { deactivatedCount, skippedMismatchCount, skippedOutstandingCount } = await deactivateMissingTaggedCustomers(
        sql, TEST_SHOP_ID, TEST_SHOP_DOMAIN, CURRENT_BULK_OP_ID, adminMock
      );

      expect(deactivatedCount).toBe(1);
      expect(skippedMismatchCount).toBe(0);
      expect(skippedOutstandingCount).toBe(0);

      const [row] = await sql<{ tag_active: boolean; tag_deactivated_at: Date | null }[]>`
        SELECT tag_active, tag_deactivated_at FROM s8_tagged_customers WHERE customer_id = ${customerGone}
      `;
      expect(row.tag_active).toBe(false);
      expect(row.tag_deactivated_at).not.toBeNull();
    });

    it("does NOT deactivate customers still in Shopify but no longer matching tag rule (mismatch never deactivates)", async () => {
      const customerStillExists = `customer-still-exists-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO s8_tagged_customers (
          shop_id, customer_id, tags, tag_active, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES (
          ${TEST_SHOP_ID}, ${customerStillExists}, '["net-terms"]'::jsonb, true,
          NOW(), NOW(), ${OLD_BULK_OP_ID}
        )
      `;

      const adminMock = mockAdminGraphQL([customerStillExists]);
      const { deactivatedCount, skippedMismatchCount, skippedOutstandingCount } = await deactivateMissingTaggedCustomers(
        sql, TEST_SHOP_ID, TEST_SHOP_DOMAIN, CURRENT_BULK_OP_ID, adminMock
      );

      expect(deactivatedCount).toBe(0);
      expect(skippedMismatchCount).toBe(1);
      expect(skippedOutstandingCount).toBe(0);

      const [row] = await sql<{ tag_active: boolean }[]>`
        SELECT tag_active FROM s8_tagged_customers WHERE customer_id = ${customerStillExists}
      `;
      expect(row.tag_active).toBe(true);
    });

    it("does NOT deactivate gone customer with outstanding balance (open invoice)", async () => {
      const customerWithBalance = `customer-has-balance-${TEST_SUFFIX}`;
      const accountId = `account-has-balance-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "customerId", name, "createdAt", "updatedAt"
        ) VALUES (
          ${accountId}, ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER', ${customerWithBalance}, 'Customer With Balance',
          NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status, "issuedAt", "createdAt", "updatedAt"
        ) VALUES (
          ${"inv-balance-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, ${accountId}, ${"order-balance-" + TEST_SUFFIX},
          '#INV-BALANCE', 1000.00, 500.00, 'open', NOW(), NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO s8_tagged_customers (
          shop_id, customer_id, tags, tag_active, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES (
          ${TEST_SHOP_ID}, ${customerWithBalance}, '["net-terms"]'::jsonb, true,
          NOW(), NOW(), ${OLD_BULK_OP_ID}
        )
      `;

      const adminMock = mockAdminGraphQL([]);
      const { deactivatedCount, skippedMismatchCount, skippedOutstandingCount } = await deactivateMissingTaggedCustomers(
        sql, TEST_SHOP_ID, TEST_SHOP_DOMAIN, CURRENT_BULK_OP_ID, adminMock
      );

      expect(deactivatedCount).toBe(0);
      expect(skippedMismatchCount).toBe(0);
      expect(skippedOutstandingCount).toBe(1);

      const [row] = await sql<{ tag_active: boolean }[]>`
        SELECT tag_active FROM s8_tagged_customers WHERE customer_id = ${customerWithBalance}
      `;
      expect(row.tag_active).toBe(true);

      await sql`DELETE FROM "Invoice" WHERE id = ${"inv-balance-" + TEST_SUFFIX}`;
      await sql`DELETE FROM "BuyerAccount" WHERE id = ${accountId}`;
    });

    it("does NOT deactivate gone customer with open draft orders", async () => {
      const customerWithDraft = `customer-has-draft-${TEST_SUFFIX}`;
      const accountId = `account-has-draft-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "customerId", name, "createdAt", "updatedAt"
        ) VALUES (
          ${accountId}, ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER', ${customerWithDraft}, 'Customer With Draft',
          NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total, has_payment_terms, status, created_at, updated_at
        ) VALUES (
          ${TEST_SHOP_ID}, ${"draft-order-draft-skip-" + TEST_SUFFIX}, ${accountId}, '#DRAFT-SKIP', '500.00',
          true, 'open', NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO s8_tagged_customers (
          shop_id, customer_id, tags, tag_active, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES (
          ${TEST_SHOP_ID}, ${customerWithDraft}, '["net-terms"]'::jsonb, true,
          NOW(), NOW(), ${OLD_BULK_OP_ID}
        )
      `;

      const adminMock = mockAdminGraphQL([]);
      const { deactivatedCount, skippedMismatchCount, skippedOutstandingCount } = await deactivateMissingTaggedCustomers(
        sql, TEST_SHOP_ID, TEST_SHOP_DOMAIN, CURRENT_BULK_OP_ID, adminMock
      );

      expect(deactivatedCount).toBe(0);
      expect(skippedMismatchCount).toBe(0);
      expect(skippedOutstandingCount).toBe(1);

      const [row] = await sql<{ tag_active: boolean }[]>`
        SELECT tag_active FROM s8_tagged_customers WHERE customer_id = ${customerWithDraft}
      `;
      expect(row.tag_active).toBe(true);

      await sql`DELETE FROM s8_draft_orders WHERE draft_order_id = ${"draft-order-draft-skip-" + TEST_SUFFIX}`;
      await sql`DELETE FROM "BuyerAccount" WHERE id = ${accountId}`;
    });

    it("Shopify read failure deactivates nothing", async () => {
      const customerMissing = `customer-api-fail-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO s8_tagged_customers (
          shop_id, customer_id, tags, tag_active, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES (
          ${TEST_SHOP_ID}, ${customerMissing}, '["net-terms"]'::jsonb, true,
          NOW(), NOW(), ${OLD_BULK_OP_ID}
        )
      `;

      const adminMock = mockAdminGraphQLFailure();
      const { deactivatedCount, skippedMismatchCount, skippedOutstandingCount } = await deactivateMissingTaggedCustomers(
        sql, TEST_SHOP_ID, TEST_SHOP_DOMAIN, CURRENT_BULK_OP_ID, adminMock
      );

      expect(deactivatedCount).toBe(0);
      expect(skippedMismatchCount).toBe(0);
      expect(skippedOutstandingCount).toBe(0);

      const [row] = await sql<{ tag_active: boolean }[]>`
        SELECT tag_active FROM s8_tagged_customers WHERE customer_id = ${customerMissing}
      `;
      expect(row.tag_active).toBe(true);
    });

    it("does NOT deactivate customers with matching last_seen_bulk_op_id (seen in current run)", async () => {
      const customerSeen = `customer-seen-cust-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO s8_tagged_customers (
          shop_id, customer_id, tags, tag_active, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES (
          ${TEST_SHOP_ID}, ${customerSeen}, '["net-terms"]'::jsonb, true,
          NOW(), NOW(), ${CURRENT_BULK_OP_ID}
        )
      `;

      const adminMock = mockAdminGraphQL([]);
      const { deactivatedCount } = await deactivateMissingTaggedCustomers(
        sql, TEST_SHOP_ID, TEST_SHOP_DOMAIN, CURRENT_BULK_OP_ID, adminMock
      );

      expect(deactivatedCount).toBe(0);
      expect(adminMock).not.toHaveBeenCalled();

      const [row] = await sql<{ tag_active: boolean }[]>`
        SELECT tag_active FROM s8_tagged_customers WHERE customer_id = ${customerSeen}
      `;
      expect(row.tag_active).toBe(true);
    });

    it("does NOT deactivate customers with NULL last_seen_bulk_op_id (webhook upserts)", async () => {
      const customerWebhook = `customer-webhook-cust-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO s8_tagged_customers (
          shop_id, customer_id, tags, tag_active, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES (
          ${TEST_SHOP_ID}, ${customerWebhook}, '["net-terms"]'::jsonb, true,
          NOW(), NOW(), NULL
        )
      `;

      const adminMock = mockAdminGraphQL([]);
      const { deactivatedCount } = await deactivateMissingTaggedCustomers(
        sql, TEST_SHOP_ID, TEST_SHOP_DOMAIN, CURRENT_BULK_OP_ID, adminMock
      );

      expect(deactivatedCount).toBe(0);
      expect(adminMock).not.toHaveBeenCalled();

      const [row] = await sql<{ tag_active: boolean }[]>`
        SELECT tag_active FROM s8_tagged_customers WHERE customer_id = ${customerWebhook}
      `;
      expect(row.tag_active).toBe(true);
    });

    it("does NOT touch another shop's rows (scoped by shop_id)", async () => {
      const customerShopB = `customer-shopb-cust-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO s8_tagged_customers (
          shop_id, customer_id, tags, tag_active, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES (
          ${SHOP_B_ID}, ${customerShopB}, '["net-terms"]'::jsonb, true,
          NOW(), NOW(), ${OLD_BULK_OP_ID}
        )
      `;

      const adminMock = mockAdminGraphQL([]);
      const { deactivatedCount } = await deactivateMissingTaggedCustomers(
        sql, TEST_SHOP_ID, TEST_SHOP_DOMAIN, CURRENT_BULK_OP_ID, adminMock
      );

      expect(deactivatedCount).toBe(0);
      expect(adminMock).not.toHaveBeenCalled();

      const [row] = await sql<{ tag_active: boolean }[]>`
        SELECT tag_active FROM s8_tagged_customers WHERE customer_id = ${customerShopB}
      `;
      expect(row.tag_active).toBe(true);
    });

    it("does NOT touch redacted rows (customer_id containing _redacted_)", async () => {
      const customerRedacted = `customer-redacted-cust-${TEST_SUFFIX}_redacted_1698500000000`;
      await sql`
        INSERT INTO s8_tagged_customers (
          shop_id, customer_id, tags, tag_active, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES (
          ${TEST_SHOP_ID}, ${customerRedacted}, '["net-terms"]'::jsonb, true,
          NOW(), NOW(), ${OLD_BULK_OP_ID}
        )
      `;

      const adminMock = mockAdminGraphQL([]);
      const { deactivatedCount } = await deactivateMissingTaggedCustomers(
        sql, TEST_SHOP_ID, TEST_SHOP_DOMAIN, CURRENT_BULK_OP_ID, adminMock
      );

      expect(deactivatedCount).toBe(0);
      expect(adminMock).not.toHaveBeenCalled();

      const [row] = await sql<{ tag_active: boolean }[]>`
        SELECT tag_active FROM s8_tagged_customers WHERE customer_id = ${customerRedacted}
      `;
      expect(row.tag_active).toBe(true);
    });

    it("only deactivates tag_active=true customers, not already inactive ones", async () => {
      const customerActive = `customer-active-${TEST_SUFFIX}`;
      const customerInactive = `customer-inactive-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, created_at, updated_at, last_seen_bulk_op_id)
        VALUES
          (${TEST_SHOP_ID}, ${customerActive}, '["net-terms"]'::jsonb, true, NOW(), NOW(), ${OLD_BULK_OP_ID}),
          (${TEST_SHOP_ID}, ${customerInactive}, '["net-terms"]'::jsonb, false, NOW(), NOW(), ${OLD_BULK_OP_ID})
      `;

      const adminMock = mockAdminGraphQL([]);
      const { deactivatedCount } = await deactivateMissingTaggedCustomers(
        sql, TEST_SHOP_ID, TEST_SHOP_DOMAIN, CURRENT_BULK_OP_ID, adminMock
      );

      expect(deactivatedCount).toBe(1);

      const rows = await sql<{ customer_id: string; tag_active: boolean }[]>`
        SELECT customer_id, tag_active FROM s8_tagged_customers
        WHERE shop_id = ${TEST_SHOP_ID}
      `;

      const activeRow = rows.find((r) => r.customer_id === customerActive);
      const inactiveRow = rows.find((r) => r.customer_id === customerInactive);

      expect(activeRow?.tag_active).toBe(false);
      expect(inactiveRow?.tag_active).toBe(false);
    });

    it("sets tag_deactivated_at and updated_at on deactivation", async () => {
      const customerMissing = `customer-timestamp-cust-${TEST_SUFFIX}`;
      const originalUpdatedAt = new Date("2026-01-01T00:00:00Z");
      await sql`
        INSERT INTO s8_tagged_customers (
          shop_id, customer_id, tags, tag_active, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES (
          ${TEST_SHOP_ID}, ${customerMissing}, '["net-terms"]'::jsonb, true,
          NOW(), ${originalUpdatedAt}, ${OLD_BULK_OP_ID}
        )
      `;

      const beforeDeactivation = new Date();
      const adminMock = mockAdminGraphQL([]);
      await deactivateMissingTaggedCustomers(sql, TEST_SHOP_ID, TEST_SHOP_DOMAIN, CURRENT_BULK_OP_ID, adminMock);

      const [row] = await sql<{ tag_deactivated_at: Date; updated_at: Date }[]>`
        SELECT tag_deactivated_at, updated_at FROM s8_tagged_customers WHERE customer_id = ${customerMissing}
      `;

      expect(row.tag_deactivated_at.getTime()).toBeGreaterThanOrEqual(beforeDeactivation.getTime());
      expect(row.updated_at.getTime()).toBeGreaterThanOrEqual(beforeDeactivation.getTime());
    });
  });

  describe("mixed scenarios", () => {
    it("handles a mix of seen, unseen, null, and redacted rows correctly", async () => {
      const draftSeen = `draft-order-mix-seen-${TEST_SUFFIX}`;
      const draftUnseen = `draft-order-mix-unseen-${TEST_SUFFIX}`;
      const draftNull = `draft-order-mix-null-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s8_draft_orders (shop_id, draft_order_id, buyer_account_id, name, total, has_payment_terms, status, created_at, updated_at, last_seen_bulk_op_id)
        VALUES
          (${TEST_SHOP_ID}, ${draftSeen}, ${TEST_ACCOUNT_ID}, '#SEEN', '1000.00', true, 'open', NOW(), NOW(), ${CURRENT_BULK_OP_ID}),
          (${TEST_SHOP_ID}, ${draftUnseen}, ${TEST_ACCOUNT_ID}, '#UNSEEN', '2000.00', true, 'invoice_sent', NOW(), NOW(), ${OLD_BULK_OP_ID}),
          (${TEST_SHOP_ID}, ${draftNull}, ${TEST_ACCOUNT_ID}, '#NULL', '3000.00', true, 'open', NOW(), NOW(), NULL)
      `;

      const { closedCount } = await closeMissingDraftOrders(sql, TEST_SHOP_ID, CURRENT_BULK_OP_ID);

      expect(closedCount).toBe(1);

      const rows = await sql<{ draft_order_id: string; status: string }[]>`
        SELECT draft_order_id, status FROM s8_draft_orders
        WHERE shop_id = ${TEST_SHOP_ID}
        ORDER BY draft_order_id
      `;

      const seenRow = rows.find((r) => r.draft_order_id === draftSeen);
      const unseenRow = rows.find((r) => r.draft_order_id === draftUnseen);
      const nullRow = rows.find((r) => r.draft_order_id === draftNull);

      expect(seenRow?.status).toBe("open");
      expect(unseenRow?.status).toBe("closed");
      expect(nullRow?.status).toBe("open");
    });

    it("handles empty tables gracefully", async () => {
      const { closedCount } = await closeMissingDraftOrders(sql, TEST_SHOP_ID, CURRENT_BULK_OP_ID);
      const adminMock = vi.fn().mockResolvedValue({ success: true, data: { nodes: [] } });
      const { deactivatedCount, skippedMismatchCount, skippedOutstandingCount } = await deactivateMissingTaggedCustomers(
        sql, TEST_SHOP_ID, TEST_SHOP_DOMAIN, CURRENT_BULK_OP_ID, adminMock
      );

      expect(closedCount).toBe(0);
      expect(deactivatedCount).toBe(0);
      expect(skippedMismatchCount).toBe(0);
      expect(skippedOutstandingCount).toBe(0);
    });
  });

  describe("getPendingExposure excludes closed status", () => {
    it("excludes 'closed' status from exposure, same as 'completed'", async () => {
      const draftOpen = `draft-order-exp-open-${TEST_SUFFIX}`;
      const draftSent = `draft-order-exp-sent-${TEST_SUFFIX}`;
      const draftCompleted = `draft-order-exp-completed-${TEST_SUFFIX}`;
      const draftClosed = `draft-order-exp-closed-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s8_draft_orders (shop_id, draft_order_id, buyer_account_id, name, total, has_payment_terms, status, created_at, updated_at)
        VALUES
          (${TEST_SHOP_ID}, ${draftOpen}, ${TEST_ACCOUNT_ID}, '#OPEN', '1000.00', true, 'open', NOW(), NOW()),
          (${TEST_SHOP_ID}, ${draftSent}, ${TEST_ACCOUNT_ID}, '#SENT', '2000.00', true, 'invoice_sent', NOW(), NOW()),
          (${TEST_SHOP_ID}, ${draftCompleted}, ${TEST_ACCOUNT_ID}, '#COMPLETED', '3000.00', true, 'completed', NOW(), NOW()),
          (${TEST_SHOP_ID}, ${draftClosed}, ${TEST_ACCOUNT_ID}, '#CLOSED', '4000.00', true, 'closed', NOW(), NOW())
      `;

      const exposure = await getPendingExposure(sql, TEST_ACCOUNT_ID);

      expect(exposure).toBe("3000.00");
    });

    it("exposure is unchanged for open and invoice_sent statuses", async () => {
      const draft1 = `draft-order-exp-unchanged1-${TEST_SUFFIX}`;
      const draft2 = `draft-order-exp-unchanged2-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s8_draft_orders (shop_id, draft_order_id, buyer_account_id, name, total, has_payment_terms, status, created_at, updated_at)
        VALUES
          (${TEST_SHOP_ID}, ${draft1}, ${TEST_ACCOUNT_ID}, '#U1', '5000.00', true, 'open', NOW(), NOW()),
          (${TEST_SHOP_ID}, ${draft2}, ${TEST_ACCOUNT_ID}, '#U2', '7000.00', true, 'invoice_sent', NOW(), NOW())
      `;

      const exposure = await getPendingExposure(sql, TEST_ACCOUNT_ID);

      expect(exposure).toBe("12000.00");
    });
  });

  describe("Status pins: getPendingExposure counts by status", () => {
    it("counts 'open' status in exposure", async () => {
      const draftId = `draft-order-pin-open-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO s8_draft_orders (shop_id, draft_order_id, buyer_account_id, name, total, has_payment_terms, status, created_at, updated_at)
        VALUES (${TEST_SHOP_ID}, ${draftId}, ${TEST_ACCOUNT_ID}, '#PIN-OPEN', '1000.00', true, 'open', NOW(), NOW())
      `;
      const exposure = await getPendingExposure(sql, TEST_ACCOUNT_ID);
      expect(exposure).toBe("1000.00");
    });

    it("counts 'invoice_sent' status in exposure", async () => {
      const draftId = `draft-order-pin-sent-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO s8_draft_orders (shop_id, draft_order_id, buyer_account_id, name, total, has_payment_terms, status, created_at, updated_at)
        VALUES (${TEST_SHOP_ID}, ${draftId}, ${TEST_ACCOUNT_ID}, '#PIN-SENT', '2000.00', true, 'invoice_sent', NOW(), NOW())
      `;
      const exposure = await getPendingExposure(sql, TEST_ACCOUNT_ID);
      expect(exposure).toBe("2000.00");
    });

    it("excludes 'completed' status from exposure", async () => {
      const draftId = `draft-order-pin-completed-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO s8_draft_orders (shop_id, draft_order_id, buyer_account_id, name, total, has_payment_terms, status, created_at, updated_at)
        VALUES (${TEST_SHOP_ID}, ${draftId}, ${TEST_ACCOUNT_ID}, '#PIN-COMPLETED', '3000.00', true, 'completed', NOW(), NOW())
      `;
      const exposure = await getPendingExposure(sql, TEST_ACCOUNT_ID);
      expect(exposure).toBe("0.00");
    });

    it("excludes 'closed' status from exposure", async () => {
      const draftId = `draft-order-pin-closed-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO s8_draft_orders (shop_id, draft_order_id, buyer_account_id, name, total, has_payment_terms, status, created_at, updated_at)
        VALUES (${TEST_SHOP_ID}, ${draftId}, ${TEST_ACCOUNT_ID}, '#PIN-CLOSED', '4000.00', true, 'closed', NOW(), NOW())
      `;
      const exposure = await getPendingExposure(sql, TEST_ACCOUNT_ID);
      expect(exposure).toBe("0.00");
    });
  });

  describe("Transaction rollback: enqueue failure rolls back close", () => {
    it("drafts stay open when flagAccountsForRecompute throws (transaction rollback)", async () => {
      const draftId = `draft-order-tx-rollback-${TEST_SUFFIX}`;
      
      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES (
          ${TEST_SHOP_ID}, ${draftId}, ${TEST_ACCOUNT_ID}, '#TX-ROLLBACK', '1000.00',
          true, 'open', NOW(), NOW(), ${OLD_BULK_OP_ID}
        )
      `;

      const flagSpy = vi.spyOn(creditRecompute, "flagAccountsForRecompute")
        .mockRejectedValueOnce(new Error("Simulated enqueue failure"));

      let errorThrown = false;
      try {
        await sql.begin(async (tx) => {
          const { closedCount, affectedAccountIds } = await closeMissingDraftOrders(
            tx,
            TEST_SHOP_ID,
            CURRENT_BULK_OP_ID
          );
          if (closedCount > 0 && affectedAccountIds.length > 0) {
            await creditRecompute.flagAccountsForRecompute(
              sql,
              TEST_SHOP_DOMAIN,
              affectedAccountIds,
              tx
            );
          }
        });
      } catch {
        errorThrown = true;
      }

      expect(errorThrown).toBe(true);

      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftId}
      `;
      expect(row.status).toBe("open");

      flagSpy.mockRestore();
    });
  });

  describe("lines_read DB tests", () => {
    it("(a) NULL lines_read at resume under-counts and closes nothing", async () => {
      const mockGetStatus = vi.fn<(shop: string, bulkOperationId: string) => Promise<BulkOperationStatusResult>>().mockResolvedValue({
        success: true,
        data: {
          id: "test-id",
          status: "COMPLETED",
          url: "https://example.com/results.jsonl",
          fileSize: 1000,
          objectCount: "100",
          errorCode: null,
          partialDataUrl: null,
        },
      });

      const bulkOpId = `bulk-op-null-resume-${TEST_SUFFIX}`;
      const draftMissing = `draft-order-null-resume-draft-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES (
          ${TEST_SHOP_ID}, ${draftMissing}, ${TEST_ACCOUNT_ID}, '#NULL-RESUME', '1000.00',
          true, 'open', NOW(), NOW(), ${OLD_BULK_OP_ID}
        )
      `;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, byte_offset, lines_read
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'draft_orders', 'reconcile', 'draft_orders',
          NOW(), 5000, 50
        )
      `;

      const leaseToken = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(leaseToken).not.toBeNull();

      await sql`
        UPDATE s6_bulk_operations
        SET lines_read = NULL
        WHERE bulk_operation_id = ${bulkOpId}
      `;

      const claimed = await claimBulkCompletion(sql, bulkOpId, TEST_SHOP_DOMAIN, leaseToken!);
      expect(claimed).toBe(true);

      const [opRow] = await sql<{ lines_processed: string | null; lines_read: string | null }[]>`
        SELECT lines_processed, lines_read FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(opRow.lines_read).toBe("0");
      expect(opRow.lines_processed).toBe("0");

      await handleReconcileDeleteMissing(sql, TEST_SHOP_DOMAIN, bulkOpId, "draft_orders", mockGetStatus);

      const [draftRow] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftMissing}
      `;
      expect(draftRow.status).toBe("open");

      await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}`;
    });

    it("(b) retry with stale token is rejected and lines_read unchanged", async () => {
      const bulkOpId = `bulk-op-stale-token-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, byte_offset, lines_read
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'draft_orders', 'reconcile', 'draft_orders',
          NOW(), 1000, 10
        )
      `;

      const tokenA = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(tokenA).not.toBeNull();

      await sql`
        UPDATE s6_bulk_operations
        SET processing_lease_until = NOW() - INTERVAL '1 second'
        WHERE bulk_operation_id = ${bulkOpId}
      `;

      const tokenB = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(tokenB).not.toBeNull();
      expect(tokenB).not.toBe(tokenA);

      const { rowUpdated } = await saveBulkOperationProgress(sql, bulkOpId, 2000, tokenA!, undefined, { linesInChunk: 20 });
      expect(rowUpdated).toBe(false);

      const [opRow] = await sql<{ lines_read: string | null }[]>`
        SELECT lines_read FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(opRow.lines_read).toBe("10");

      await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}`;
    });

    it("(b) replay of same offset is rejected and lines_read unchanged", async () => {
      const bulkOpId = `bulk-op-same-offset-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, byte_offset, lines_read
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'draft_orders', 'reconcile', 'draft_orders',
          NOW(), 2000, 20
        )
      `;

      const leaseToken = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(leaseToken).not.toBeNull();

      const { rowUpdated } = await saveBulkOperationProgress(sql, bulkOpId, 2000, leaseToken!, undefined, { linesInChunk: 15 });
      expect(rowUpdated).toBe(false);

      const [opRow] = await sql<{ lines_read: string | null }[]>`
        SELECT lines_read FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(opRow.lines_read).toBe("20");

      await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}`;
    });

    it("(c) only lines_processed == objectCount allows close; objectCount-1 closes nothing", async () => {
      const mockGetStatus = vi.fn<(shop: string, bulkOperationId: string) => Promise<BulkOperationStatusResult>>().mockResolvedValue({
        success: true,
        data: {
          id: "test-id",
          status: "COMPLETED",
          url: "https://example.com/results.jsonl",
          fileSize: 1000,
          objectCount: "100",
          errorCode: null,
          partialDataUrl: null,
        },
      });

      const bulkOpId = `bulk-op-mismatch-minus1-${TEST_SUFFIX}`;
      const draftMissing = `draft-order-mismatch-m1-draft-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES (
          ${TEST_SHOP_ID}, ${draftMissing}, ${TEST_ACCOUNT_ID}, '#MISMATCH-M1', '1000.00',
          true, 'open', NOW(), NOW(), ${OLD_BULK_OP_ID}
        )
      `;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, byte_offset, lines_read, lines_processed, completed_at
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'draft_orders', 'reconcile', 'draft_orders',
          NOW(), 5000, 99, 99, NOW()
        )
      `;

      await handleReconcileDeleteMissing(sql, TEST_SHOP_DOMAIN, bulkOpId, "draft_orders", mockGetStatus);

      const [draftRow] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftMissing}
      `;
      expect(draftRow.status).toBe("open");

      await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}`;
    });

    it("(c) only lines_processed == objectCount allows close; objectCount+1 closes nothing", async () => {
      const mockGetStatus = vi.fn<(shop: string, bulkOperationId: string) => Promise<BulkOperationStatusResult>>().mockResolvedValue({
        success: true,
        data: {
          id: "test-id",
          status: "COMPLETED",
          url: "https://example.com/results.jsonl",
          fileSize: 1000,
          objectCount: "100",
          errorCode: null,
          partialDataUrl: null,
        },
      });

      const bulkOpId = `bulk-op-mismatch-plus1-${TEST_SUFFIX}`;
      const draftMissing = `draft-order-mismatch-p1-draft-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES (
          ${TEST_SHOP_ID}, ${draftMissing}, ${TEST_ACCOUNT_ID}, '#MISMATCH-P1', '1000.00',
          true, 'open', NOW(), NOW(), ${OLD_BULK_OP_ID}
        )
      `;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, byte_offset, lines_read, lines_processed, completed_at
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'draft_orders', 'reconcile', 'draft_orders',
          NOW(), 5000, 101, 101, NOW()
        )
      `;

      await handleReconcileDeleteMissing(sql, TEST_SHOP_DOMAIN, bulkOpId, "draft_orders", mockGetStatus);

      const [draftRow] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftMissing}
      `;
      expect(draftRow.status).toBe("open");

      await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}`;
    });

    it("forward progress increments lines_read correctly", async () => {
      const bulkOpId = `bulk-op-forward-progress-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, byte_offset, lines_read
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'draft_orders', 'reconcile', 'draft_orders',
          NOW(), 0, NULL
        )
      `;

      const leaseToken = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(leaseToken).not.toBeNull();

      const { rowUpdated: update1 } = await saveBulkOperationProgress(sql, bulkOpId, 1000, leaseToken!, undefined, { linesInChunk: 10 });
      expect(update1).toBe(true);

      const [row1] = await sql<{ lines_read: string | null }[]>`
        SELECT lines_read FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row1.lines_read).toBe("10");

      const { rowUpdated: update2 } = await saveBulkOperationProgress(sql, bulkOpId, 2000, leaseToken!, undefined, { linesInChunk: 15 });
      expect(update2).toBe(true);

      const [row2] = await sql<{ lines_read: string | null }[]>`
        SELECT lines_read FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row2.lines_read).toBe("25");

      const { rowUpdated: update3 } = await saveBulkOperationProgress(sql, bulkOpId, 3000, leaseToken!, undefined, { linesInChunk: 5 });
      expect(update3).toBe(true);

      const [row3] = await sql<{ lines_read: string | null }[]>`
        SELECT lines_read FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row3.lines_read).toBe("30");

      await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}`;
    });

    it("claimBulkCompletion adds finalLinesInChunk to lines_read and lines_processed", async () => {
      const bulkOpId = `bulk-op-claim-sets-processed-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, byte_offset, lines_read
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'draft_orders', 'reconcile', 'draft_orders',
          NOW(), 5000, 80
        )
      `;

      const leaseToken = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(leaseToken).not.toBeNull();

      const claimed = await claimBulkCompletion(sql, bulkOpId, TEST_SHOP_DOMAIN, leaseToken!, 20);
      expect(claimed).toBe(true);

      const [opRow] = await sql<{ lines_processed: string | null; lines_read: string | null }[]>`
        SELECT lines_processed, lines_read FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(opRow.lines_read).toBe("100");
      expect(opRow.lines_processed).toBe("100");

      await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}`;
    });
  });

  describe("Completeness guard tests (each closes nothing)", () => {
    it("guard: status != COMPLETED closes nothing", async () => {
      const mockGetStatus = vi.fn<(shop: string, bulkOperationId: string) => Promise<BulkOperationStatusResult>>().mockResolvedValue({
        success: true,
        data: {
          id: "test-id",
          status: "RUNNING",
          url: "https://example.com/results.jsonl",
          fileSize: 1000,
          objectCount: "100",
          errorCode: null,
          partialDataUrl: null,
        },
      });

      const bulkOpId = `bulk-op-guard-status-${TEST_SUFFIX}`;
      const draftMissing = `draft-order-guard-status-draft-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES (
          ${TEST_SHOP_ID}, ${draftMissing}, ${TEST_ACCOUNT_ID}, '#GUARD-STATUS', '1000.00',
          true, 'open', NOW(), NOW(), ${OLD_BULK_OP_ID}
        )
      `;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, byte_offset, lines_read, lines_processed, completed_at
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'draft_orders', 'reconcile', 'draft_orders',
          NOW(), 5000, 100, 100, NOW()
        )
      `;

      await handleReconcileDeleteMissing(sql, TEST_SHOP_DOMAIN, bulkOpId, "draft_orders", mockGetStatus);

      const [draftRow] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftMissing}
      `;
      expect(draftRow.status).toBe("open");

      await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}`;
    });

    it("guard: errorCode set closes nothing", async () => {
      const mockGetStatus = vi.fn<(shop: string, bulkOperationId: string) => Promise<BulkOperationStatusResult>>().mockResolvedValue({
        success: true,
        data: {
          id: "test-id",
          status: "COMPLETED",
          url: "https://example.com/results.jsonl",
          fileSize: 1000,
          objectCount: "100",
          errorCode: "ACCESS_DENIED",
          partialDataUrl: null,
        },
      });

      const bulkOpId = `bulk-op-guard-errorcode-${TEST_SUFFIX}`;
      const draftMissing = `draft-order-guard-errorcode-draft-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES (
          ${TEST_SHOP_ID}, ${draftMissing}, ${TEST_ACCOUNT_ID}, '#GUARD-ERRORCODE', '1000.00',
          true, 'open', NOW(), NOW(), ${OLD_BULK_OP_ID}
        )
      `;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, byte_offset, lines_read, lines_processed, completed_at
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'draft_orders', 'reconcile', 'draft_orders',
          NOW(), 5000, 100, 100, NOW()
        )
      `;

      await handleReconcileDeleteMissing(sql, TEST_SHOP_DOMAIN, bulkOpId, "draft_orders", mockGetStatus);

      const [draftRow] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftMissing}
      `;
      expect(draftRow.status).toBe("open");

      await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}`;
    });

    it("guard: partialDataUrl set closes nothing", async () => {
      const mockGetStatus = vi.fn<(shop: string, bulkOperationId: string) => Promise<BulkOperationStatusResult>>().mockResolvedValue({
        success: true,
        data: {
          id: "test-id",
          status: "COMPLETED",
          url: "https://example.com/results.jsonl",
          fileSize: 1000,
          objectCount: "100",
          errorCode: null,
          partialDataUrl: "https://example.com/partial.jsonl",
        },
      });

      const bulkOpId = `bulk-op-guard-partial-${TEST_SUFFIX}`;
      const draftMissing = `draft-order-guard-partial-draft-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES (
          ${TEST_SHOP_ID}, ${draftMissing}, ${TEST_ACCOUNT_ID}, '#GUARD-PARTIAL', '1000.00',
          true, 'open', NOW(), NOW(), ${OLD_BULK_OP_ID}
        )
      `;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, byte_offset, lines_read, lines_processed, completed_at
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'draft_orders', 'reconcile', 'draft_orders',
          NOW(), 5000, 100, 100, NOW()
        )
      `;

      await handleReconcileDeleteMissing(sql, TEST_SHOP_DOMAIN, bulkOpId, "draft_orders", mockGetStatus);

      const [draftRow] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftMissing}
      `;
      expect(draftRow.status).toBe("open");

      await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}`;
    });

    it("guard: not the newest COMPLETED reconcile op of the stage closes nothing", async () => {
      const mockGetStatus = vi.fn<(shop: string, bulkOperationId: string) => Promise<BulkOperationStatusResult>>().mockResolvedValue({
        success: true,
        data: {
          id: "test-id",
          status: "COMPLETED",
          url: "https://example.com/results.jsonl",
          fileSize: 1000,
          objectCount: "100",
          errorCode: null,
          partialDataUrl: null,
        },
      });

      const olderBulkOpId = `bulk-op-guard-older-${TEST_SUFFIX}`;
      const newerBulkOpId = `bulk-op-guard-newer-${TEST_SUFFIX}`;
      const draftMissing = `draft-order-guard-newest-draft-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES (
          ${TEST_SHOP_ID}, ${draftMissing}, ${TEST_ACCOUNT_ID}, '#GUARD-NEWEST', '1000.00',
          true, 'open', NOW(), NOW(), ${OLD_BULK_OP_ID}
        )
      `;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, byte_offset, lines_read, lines_processed, completed_at
        ) VALUES (
          ${olderBulkOpId}, ${TEST_SHOP_DOMAIN}, 'draft_orders', 'reconcile', 'draft_orders',
          NOW() - INTERVAL '1 hour', 5000, 100, 100, NOW() - INTERVAL '1 hour'
        )
      `;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, byte_offset, lines_read, lines_processed, completed_at
        ) VALUES (
          ${newerBulkOpId}, ${TEST_SHOP_DOMAIN}, 'draft_orders', 'reconcile', 'draft_orders',
          NOW(), 5000, 100, 100, NOW()
        )
      `;

      await handleReconcileDeleteMissing(sql, TEST_SHOP_DOMAIN, olderBulkOpId, "draft_orders", mockGetStatus);

      const [draftRow] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftMissing}
      `;
      expect(draftRow.status).toBe("open");

      await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id IN (${olderBulkOpId}, ${newerBulkOpId})`;
    });

    it("lines_processed == objectCount DOES close drafts when all guards pass", async () => {
      const mockGetStatus = vi.fn<(shop: string, bulkOperationId: string) => Promise<BulkOperationStatusResult>>().mockResolvedValue({
        success: true,
        data: {
          id: "test-id",
          status: "COMPLETED",
          url: "https://example.com/results.jsonl",
          fileSize: 1000,
          objectCount: "100",
          errorCode: null,
          partialDataUrl: null,
        },
      });

      const bulkOpId = `bulk-op-positive-close-${TEST_SUFFIX}`;
      const draftMissing = `draft-order-positive-close-draft-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES (
          ${TEST_SHOP_ID}, ${draftMissing}, ${TEST_ACCOUNT_ID}, '#POSITIVE-CLOSE', '1000.00',
          true, 'open', NOW(), NOW(), ${OLD_BULK_OP_ID}
        )
      `;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, byte_offset, lines_read, lines_processed, completed_at
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'draft_orders', 'reconcile', 'draft_orders',
          NOW(), 5000, 100, 100, NOW()
        )
      `;

      await handleReconcileDeleteMissing(sql, TEST_SHOP_DOMAIN, bulkOpId, "draft_orders", mockGetStatus);

      const [draftRow] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftMissing}
      `;
      expect(draftRow.status).toBe("closed");

      await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}`;
    });
  });

  describe("Empty result (objectCount 0) behavior", () => {
    it("objectCount 0 skips delete-missing: drafts, customers, and locations stay untouched (Team Lead decision)", async () => {
      const mockGetStatus = vi.fn<(shop: string, bulkOperationId: string) => Promise<BulkOperationStatusResult>>().mockResolvedValue({
        success: true,
        data: {
          id: "test-id",
          status: "COMPLETED",
          url: null,
          fileSize: null,
          objectCount: "0",
          errorCode: null,
          partialDataUrl: null,
        },
      });

      const bulkOpId = `bulk-op-empty-result-${TEST_SUFFIX}`;
      const draftMissing = `draft-order-empty-result-draft-${TEST_SUFFIX}`;
      const customerMissing = `customer-empty-result-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES (
          ${TEST_SHOP_ID}, ${draftMissing}, ${TEST_ACCOUNT_ID}, '#EMPTY-RESULT', '1000.00',
          true, 'open', NOW(), NOW(), ${OLD_BULK_OP_ID}
        )
      `;

      await sql`
        INSERT INTO s8_tagged_customers (
          shop_id, customer_id, tags, tag_active, last_seen_bulk_op_id, created_at, updated_at
        ) VALUES (
          ${TEST_SHOP_ID}, ${customerMissing}, '["net-terms"]'::jsonb, true, ${OLD_BULK_OP_ID}, NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, byte_offset, lines_read, lines_processed, completed_at
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'draft_orders', 'reconcile', 'draft_orders',
          NOW(), 0, 0, 0, NOW()
        )
      `;

      await handleReconcileDeleteMissing(sql, TEST_SHOP_DOMAIN, bulkOpId, "draft_orders", mockGetStatus);

      const [draftRow] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftMissing}
      `;
      expect(draftRow.status).toBe("open");

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, byte_offset, lines_read, lines_processed, completed_at
        ) VALUES (
          ${bulkOpId + '-cust'}, ${TEST_SHOP_DOMAIN}, 'customers', 'reconcile', 'customers',
          NOW(), 0, 0, 0, NOW()
        )
      `;

      await handleReconcileDeleteMissing(sql, TEST_SHOP_DOMAIN, bulkOpId + '-cust', "customers", mockGetStatus);

      const [customerRow] = await sql<{ tag_active: boolean }[]>`
        SELECT tag_active FROM s8_tagged_customers WHERE customer_id = ${customerMissing}
      `;
      expect(customerRow.tag_active).toBe(true);

      await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id LIKE ${bulkOpId + '%'}`;
      await sql`DELETE FROM s8_draft_orders WHERE draft_order_id = ${draftMissing}`;
      await sql`DELETE FROM s8_tagged_customers WHERE customer_id = ${customerMissing}`;
    });
  });

  describe("Deactivate race condition guards", () => {
    it("deactivateMissingTaggedCustomers respects shop_id and tag_active in final UPDATE", async () => {
      const bulkOpId = `bulk-op-deactivate-race-${TEST_SUFFIX}`;
      const customerId = `customer-deactivate-race-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s8_tagged_customers (
          shop_id, customer_id, tags, tag_active, last_seen_bulk_op_id, created_at, updated_at
        ) VALUES (
          ${TEST_SHOP_ID}, ${customerId}, '["net-terms"]'::jsonb, true, ${OLD_BULK_OP_ID}, NOW(), NOW()
        )
      `;

      const adminGraphQLMock = vi.fn().mockResolvedValue({
        success: true,
        data: { nodes: [] },
      });

      const result = await deactivateMissingTaggedCustomers(
        sql,
        TEST_SHOP_ID,
        TEST_SHOP_DOMAIN,
        bulkOpId,
        adminGraphQLMock
      );

      expect(result.deactivatedCount).toBe(1);

      const [row] = await sql<{ tag_active: boolean }[]>`
        SELECT tag_active FROM s8_tagged_customers WHERE customer_id = ${customerId}
      `;
      expect(row.tag_active).toBe(false);

      await sql`DELETE FROM s8_tagged_customers WHERE customer_id = ${customerId}`;
    });
  });

  describe("End-to-end processBulkOperation with delete-missing", () => {
    beforeEach(async () => {
      vi.clearAllMocks();
      vi.resetModules();
    });

    it("single-chunk export (empty result, objectCount 0): lines_processed == 0 but drafts stay open (Team Lead decision)", async () => {
      const { adminGraphQL } = await import("../../drain/admin-client.server");
      const { processBulkOperation } = await import("../bulk-jsonl-processor.server");
      const mockAdminGraphQL = vi.mocked(adminGraphQL);

      const bulkOpId = `bulk-op-e2e-single-chunk-${TEST_SUFFIX}`;
      const webhookId = `webhook-e2e-single-chunk-${TEST_SUFFIX}`;
      const draftMissingId = `draft-order-e2e-missing-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES (
          ${TEST_SHOP_ID}, ${draftMissingId}, ${TEST_ACCOUNT_ID}, '#E2E-MISSING', '1000.00',
          true, 'open', NOW(), NOW(), ${OLD_BULK_OP_ID}
        )
      `;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, byte_offset
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'draft_orders', 'reconcile', 'draft_orders', NOW(), 0
        )
      `;

      mockAdminGraphQL.mockResolvedValue({
        success: true,
        data: {
          node: {
            id: bulkOpId,
            status: "COMPLETED",
            objectCount: "0",
            fileSize: null,
            errorCode: null,
          }
        },
        retryable: false,
      });

      const result = await processBulkOperation(sql, {
        topic: "BULK_OPERATIONS_FINISH",
        shop: TEST_SHOP_DOMAIN,
        webhookId,
        enqueuedAt: new Date().toISOString(),
        bulkOperationId: bulkOpId,
        bulkType: "draft_orders",
      });

      expect(result.success).toBe(true);

      const [opRow] = await sql<{ lines_processed: string | null; lines_read: string | null }[]>`
        SELECT lines_processed, lines_read FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(opRow.lines_processed).toBe("0");
      expect(opRow.lines_read).toBe("0");

      const [draftRow] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftMissingId}
      `;
      expect(draftRow.status).toBe("open");

      await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}`;
      await sql`DELETE FROM s8_draft_orders WHERE draft_order_id = ${draftMissingId}`;
    });

    it("claimBulkCompletion with finalLinesInChunk simulates single-chunk export: lines_processed == objectCount", async () => {
      const mockGetStatus = vi.fn<(shop: string, bulkOperationId: string) => Promise<BulkOperationStatusResult>>().mockResolvedValue({
        success: true,
        data: {
          id: "test-id",
          status: "COMPLETED",
          url: "https://example.com/results.jsonl",
          fileSize: 1000,
          objectCount: "5",
          errorCode: null,
          partialDataUrl: null,
        },
      });

      const bulkOpId = `bulk-op-e2e-claim-single-${TEST_SUFFIX}`;
      const draftMissingId = `draft-order-e2e-claim-missing-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES (
          ${TEST_SHOP_ID}, ${draftMissingId}, ${TEST_ACCOUNT_ID}, '#E2E-CLAIM-MISSING', '1000.00',
          true, 'open', NOW(), NOW(), ${OLD_BULK_OP_ID}
        )
      `;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, byte_offset, lines_read
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'draft_orders', 'reconcile', 'draft_orders', NOW(), 5000, 0
        )
      `;

      const leaseToken = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(leaseToken).not.toBeNull();

      const claimed = await claimBulkCompletion(sql, bulkOpId, TEST_SHOP_DOMAIN, leaseToken!, 5);
      expect(claimed).toBe(true);

      const [opRow] = await sql<{ lines_processed: string | null; lines_read: string | null }[]>`
        SELECT lines_processed, lines_read FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(opRow.lines_read).toBe("5");
      expect(opRow.lines_processed).toBe("5");

      await handleReconcileDeleteMissing(sql, TEST_SHOP_DOMAIN, bulkOpId, "draft_orders", mockGetStatus);

      const [draftRow] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftMissingId}
      `;
      expect(draftRow.status).toBe("closed");

      await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}`;
      await sql`DELETE FROM s8_draft_orders WHERE draft_order_id = ${draftMissingId}`;
    });

    it("multi-chunk via saveBulkOperationProgress + claimBulkCompletion: lines_processed == objectCount", async () => {
      const mockGetStatus = vi.fn<(shop: string, bulkOperationId: string) => Promise<BulkOperationStatusResult>>().mockResolvedValue({
        success: true,
        data: {
          id: "test-id",
          status: "COMPLETED",
          url: "https://example.com/results.jsonl",
          fileSize: 2000,
          objectCount: "10",
          errorCode: null,
          partialDataUrl: null,
        },
      });

      const bulkOpId = `bulk-op-e2e-multi-chunk-${TEST_SUFFIX}`;
      const draftMissingId = `draft-order-e2e-multi-missing-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES (
          ${TEST_SHOP_ID}, ${draftMissingId}, ${TEST_ACCOUNT_ID}, '#E2E-MULTI-MISSING', '1000.00',
          true, 'open', NOW(), NOW(), ${OLD_BULK_OP_ID}
        )
      `;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, byte_offset
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'draft_orders', 'reconcile', 'draft_orders', NOW(), 0
        )
      `;

      const leaseToken = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(leaseToken).not.toBeNull();

      await saveBulkOperationProgress(sql, bulkOpId, 500, leaseToken!, undefined, { linesInChunk: 3 });
      await saveBulkOperationProgress(sql, bulkOpId, 1000, leaseToken!, undefined, { linesInChunk: 4 });

      const [midRow] = await sql<{ lines_read: string | null }[]>`
        SELECT lines_read FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(midRow.lines_read).toBe("7");

      const claimed = await claimBulkCompletion(sql, bulkOpId, TEST_SHOP_DOMAIN, leaseToken!, 3);
      expect(claimed).toBe(true);

      const [opRow] = await sql<{ lines_processed: string | null; lines_read: string | null }[]>`
        SELECT lines_processed, lines_read FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(opRow.lines_read).toBe("10");
      expect(opRow.lines_processed).toBe("10");

      await handleReconcileDeleteMissing(sql, TEST_SHOP_DOMAIN, bulkOpId, "draft_orders", mockGetStatus);

      const [draftRow] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftMissingId}
      `;
      expect(draftRow.status).toBe("closed");

      await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}`;
      await sql`DELETE FROM s8_draft_orders WHERE draft_order_id = ${draftMissingId}`;
    });

    it("(i) processBulkOperation E2E single-chunk (N>0): lines_processed == objectCount, unseen draft closed, seen draft open", async () => {
      const { adminGraphQL } = await import("../../drain/admin-client.server");
      const { processBulkOperation } = await import("../bulk-jsonl-processor.server");
      const { processBulkDraftOrder } = await import("../draft-order.server");
      const mockAdminGraphQL = vi.mocked(adminGraphQL);
      const mockProcessBulkDraftOrder = vi.mocked(processBulkDraftOrder);

      const bulkOpId = `bulk-op-e2e-nonempty-single-${TEST_SUFFIX}`;
      const webhookId = `webhook-e2e-nonempty-single-${TEST_SUFFIX}`;
      const draftSeenId = `draft-order-e2e-seen-single-${TEST_SUFFIX}`;
      const draftUnseenId = `draft-order-e2e-unseen-single-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES
          (${TEST_SHOP_ID}, ${draftSeenId}, ${TEST_ACCOUNT_ID}, '#E2E-SEEN', '1000.00', true, 'open', NOW(), NOW(), ${OLD_BULK_OP_ID}),
          (${TEST_SHOP_ID}, ${draftUnseenId}, ${TEST_ACCOUNT_ID}, '#E2E-UNSEEN', '2000.00', true, 'open', NOW(), NOW(), ${OLD_BULK_OP_ID})
      `;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, byte_offset
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'draft_orders', 'reconcile', 'draft_orders', NOW(), 0
        )
      `;

      const jsonlLine1 = JSON.stringify({
        id: draftSeenId,
        name: "#E2E-SEEN",
        createdAt: "2026-10-25T10:00:00Z",
        status: "open",
        totalPriceSet: { shopMoney: { amount: "1000.00", currencyCode: "INR" } },
        paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
      });
      const jsonlLine2 = JSON.stringify({
        id: `draft-order-e2e-extra1-${TEST_SUFFIX}`,
        name: "#E2E-EXTRA1",
        createdAt: "2026-10-25T11:00:00Z",
        status: "open",
        totalPriceSet: { shopMoney: { amount: "1500.00", currencyCode: "INR" } },
        paymentTerms: { id: "pt2", paymentTermsName: "Net 30", paymentTermsType: "NET" },
      });
      const jsonlLine3 = JSON.stringify({
        id: `draft-order-e2e-extra2-${TEST_SUFFIX}`,
        name: "#E2E-EXTRA2",
        createdAt: "2026-10-25T12:00:00Z",
        status: "open",
        totalPriceSet: { shopMoney: { amount: "2000.00", currencyCode: "INR" } },
        paymentTerms: { id: "pt3", paymentTermsName: "Net 30", paymentTermsType: "NET" },
      });
      const jsonlContent = [jsonlLine1, jsonlLine2, jsonlLine3].join("\n");
      const jsonlBytes = new TextEncoder().encode(jsonlContent);

      mockAdminGraphQL.mockResolvedValue({
        success: true,
        data: {
          node: {
            id: bulkOpId,
            status: "COMPLETED",
            objectCount: "3",
            fileSize: jsonlBytes.length,
            url: "https://example.com/results.jsonl",
            errorCode: null,
          }
        },
        retryable: false,
      });

      mockProcessBulkDraftOrder.mockImplementation(async (_sql, _shop, draftOrder) => {
        return {
          shopId: TEST_SHOP_ID,
          draftOrderId: draftOrder.id,
          buyerAccountId: TEST_ACCOUNT_ID,
          name: draftOrder.name,
          total: draftOrder.totalPriceSet?.shopMoney.amount ?? "0.00",
          hasPaymentTerms: true,
          status: (draftOrder.status ?? "open").toLowerCase(),
          createdAt: new Date(draftOrder.createdAt),
        };
      });

      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          status: 206,
          ok: true,
          statusText: "Partial Content",
          headers: new Headers({
            "Content-Range": `bytes 0-${jsonlBytes.length - 1}/${jsonlBytes.length}`,
          }),
          arrayBuffer: () => Promise.resolve(jsonlBytes.buffer),
        } as Response);
      });

      try {
        const result = await processBulkOperation(sql, {
          topic: "BULK_OPERATIONS_FINISH",
          shop: TEST_SHOP_DOMAIN,
          webhookId,
          enqueuedAt: new Date().toISOString(),
          bulkOperationId: bulkOpId,
          bulkType: "draft_orders",
        });

        expect(result.success).toBe(true);
        expect(result.status).toBe("complete");

        const [opRow] = await sql<{ lines_processed: string | null; lines_read: string | null }[]>`
          SELECT lines_processed, lines_read FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
        `;
        expect(opRow.lines_processed).toBe("3");
        expect(opRow.lines_read).toBe("3");

        const [seenDraft] = await sql<{ status: string; last_seen_bulk_op_id: string | null }[]>`
          SELECT status, last_seen_bulk_op_id FROM s8_draft_orders WHERE draft_order_id = ${draftSeenId}
        `;
        expect(seenDraft.last_seen_bulk_op_id).toBe(bulkOpId);
        expect(seenDraft.status).toBe("open");

        const [unseenDraft] = await sql<{ status: string; last_seen_bulk_op_id: string | null }[]>`
          SELECT status, last_seen_bulk_op_id FROM s8_draft_orders WHERE draft_order_id = ${draftUnseenId}
        `;
        expect(unseenDraft.last_seen_bulk_op_id).toBe(OLD_BULK_OP_ID);
        expect(unseenDraft.status).toBe("closed");
      } finally {
        global.fetch = originalFetch;
        await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}`;
        await sql`DELETE FROM s8_draft_orders WHERE draft_order_id IN (${draftSeenId}, ${draftUnseenId})`;
      }
    });

    it("(ii) processBulkOperation E2E multi-chunk (N>chunk): at least 2 progress saves, lines_processed == objectCount, unseen closed", async () => {
      const { adminGraphQL } = await import("../../drain/admin-client.server");
      const { processBulkOperation, DEFAULT_CHUNK_SIZE } = await import("../bulk-jsonl-processor.server");
      const { processBulkDraftOrder } = await import("../draft-order.server");
      const mockAdminGraphQL = vi.mocked(adminGraphQL);
      const mockProcessBulkDraftOrder = vi.mocked(processBulkDraftOrder);

      const bulkOpId = `bulk-op-e2e-nonempty-multi-${TEST_SUFFIX}`;
      const webhookId = `webhook-e2e-nonempty-multi-${TEST_SUFFIX}`;
      const draftSeenId = `draft-order-e2e-seen-multi-${TEST_SUFFIX}`;
      const draftUnseenId = `draft-order-e2e-unseen-multi-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at, updated_at, last_seen_bulk_op_id
        ) VALUES
          (${TEST_SHOP_ID}, ${draftSeenId}, ${TEST_ACCOUNT_ID}, '#E2E-MULTI-SEEN', '1000.00', true, 'open', NOW(), NOW(), ${OLD_BULK_OP_ID}),
          (${TEST_SHOP_ID}, ${draftUnseenId}, ${TEST_ACCOUNT_ID}, '#E2E-MULTI-UNSEEN', '2000.00', true, 'open', NOW(), NOW(), ${OLD_BULK_OP_ID})
      `;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, byte_offset
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'draft_orders', 'reconcile', 'draft_orders', NOW(), 0
        )
      `;

      const makeLine = (id: string, name: string, idx: number) => JSON.stringify({
        id,
        name,
        createdAt: `2026-10-25T${String(10 + idx).padStart(2, "0")}:00:00Z`,
        status: "open",
        totalPriceSet: { shopMoney: { amount: "1000.00", currencyCode: "INR" } },
        paymentTerms: { id: `pt${idx}`, paymentTermsName: "Net 30", paymentTermsType: "NET" },
      });

      const lines = [
        makeLine(draftSeenId, "#E2E-MULTI-SEEN", 0),
        makeLine(`draft-order-e2e-multi-extra1-${TEST_SUFFIX}`, "#EXTRA1", 1),
        makeLine(`draft-order-e2e-multi-extra2-${TEST_SUFFIX}`, "#EXTRA2", 2),
        makeLine(`draft-order-e2e-multi-extra3-${TEST_SUFFIX}`, "#EXTRA3", 3),
        makeLine(`draft-order-e2e-multi-extra4-${TEST_SUFFIX}`, "#EXTRA4", 4),
        makeLine(`draft-order-e2e-multi-extra5-${TEST_SUFFIX}`, "#EXTRA5", 5),
      ];
      const jsonlContent = lines.join("\n");
      const jsonlBytes = new TextEncoder().encode(jsonlContent);

      const smallChunkSize = Math.floor(jsonlBytes.length / 3);

      mockAdminGraphQL.mockResolvedValue({
        success: true,
        data: {
          node: {
            id: bulkOpId,
            status: "COMPLETED",
            objectCount: "6",
            fileSize: jsonlBytes.length,
            url: "https://example.com/results.jsonl",
            errorCode: null,
          }
        },
        retryable: false,
      });

      mockProcessBulkDraftOrder.mockImplementation(async (_sql, _shop, draftOrder) => {
        return {
          shopId: TEST_SHOP_ID,
          draftOrderId: draftOrder.id,
          buyerAccountId: TEST_ACCOUNT_ID,
          name: draftOrder.name,
          total: draftOrder.totalPriceSet?.shopMoney.amount ?? "0.00",
          hasPaymentTerms: true,
          status: (draftOrder.status ?? "open").toLowerCase(),
          createdAt: new Date(draftOrder.createdAt),
        };
      });

      const originalFetch = global.fetch;
      let fetchCallCount = 0;
      global.fetch = vi.fn().mockImplementation((url: string, options: RequestInit) => {
        fetchCallCount++;
        const rangeHeader = (options.headers as Record<string, string>)?.Range || "";
        const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d+)/);
        const start = rangeMatch ? parseInt(rangeMatch[1], 10) : 0;
        const requestedEnd = rangeMatch ? parseInt(rangeMatch[2], 10) : jsonlBytes.length - 1;
        const actualEnd = Math.min(requestedEnd, jsonlBytes.length - 1);
        const chunk = jsonlBytes.slice(start, actualEnd + 1);
        const isEof = actualEnd >= jsonlBytes.length - 1;

        return Promise.resolve({
          status: 206,
          ok: true,
          statusText: "Partial Content",
          headers: new Headers({
            "Content-Range": `bytes ${start}-${actualEnd}/${jsonlBytes.length}`,
          }),
          arrayBuffer: () => Promise.resolve(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)),
        } as Response);
      });

      try {
        const result = await processBulkOperation(sql, {
          topic: "BULK_OPERATIONS_FINISH",
          shop: TEST_SHOP_DOMAIN,
          webhookId,
          enqueuedAt: new Date().toISOString(),
          bulkOperationId: bulkOpId,
          bulkType: "draft_orders",
        });

        expect(result.success).toBe(true);
        expect(result.status).toBe("complete");

        const [opRow] = await sql<{ lines_processed: string | null; lines_read: string | null }[]>`
          SELECT lines_processed, lines_read FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
        `;
        expect(opRow.lines_processed).toBe("6");
        expect(opRow.lines_read).toBe("6");

        const [seenDraft] = await sql<{ status: string; last_seen_bulk_op_id: string | null }[]>`
          SELECT status, last_seen_bulk_op_id FROM s8_draft_orders WHERE draft_order_id = ${draftSeenId}
        `;
        expect(seenDraft.last_seen_bulk_op_id).toBe(bulkOpId);
        expect(seenDraft.status).toBe("open");

        const [unseenDraft] = await sql<{ status: string; last_seen_bulk_op_id: string | null }[]>`
          SELECT status, last_seen_bulk_op_id FROM s8_draft_orders WHERE draft_order_id = ${draftUnseenId}
        `;
        expect(unseenDraft.last_seen_bulk_op_id).toBe(OLD_BULK_OP_ID);
        expect(unseenDraft.status).toBe("closed");
      } finally {
        global.fetch = originalFetch;
        await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}`;
        await sql`DELETE FROM s8_draft_orders WHERE draft_order_id IN (${draftSeenId}, ${draftUnseenId})`;
      }
    });
  });
});
