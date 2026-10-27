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

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("v1.1 reconcile delete-missing (DB-backed)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-v11dm";
  const TEST_SHOP_ID = `shop-v11dm-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-v11dm-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `account-v11dm-${TEST_SUFFIX}`;
  const TEST_COMPANY_ID = `gid://shopify/Company/co-v11dm-${TEST_SUFFIX}`;
  const TEST_LOCATION_ID = `gid://shopify/CompanyLocation/loc-v11dm-${TEST_SUFFIX}`;

  const SHOP_B_ID = `shop-v11dm-b-${TEST_SUFFIX}`;
  const SHOP_B_DOMAIN = `test-v11dm-b-${TEST_SUFFIX}.myshopify.com`;

  const CURRENT_BULK_OP_ID = `gid://shopify/BulkOperation/current-${TEST_SUFFIX}`;
  const OLD_BULK_OP_ID = `gid://shopify/BulkOperation/old-${TEST_SUFFIX}`;

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
      const draftMissing = `gid://shopify/DraftOrder/missing-${TEST_SUFFIX}`;
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
      const draftSeen = `gid://shopify/DraftOrder/seen-${TEST_SUFFIX}`;
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
      const draftWebhook = `gid://shopify/DraftOrder/webhook-${TEST_SUFFIX}`;
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
      const draftShopB = `gid://shopify/DraftOrder/shopb-${TEST_SUFFIX}`;
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
      const draftOpen = `gid://shopify/DraftOrder/status-open-${TEST_SUFFIX}`;
      const draftSent = `gid://shopify/DraftOrder/status-sent-${TEST_SUFFIX}`;
      const draftCompleted = `gid://shopify/DraftOrder/status-completed-${TEST_SUFFIX}`;
      const draftClosed = `gid://shopify/DraftOrder/status-closed-${TEST_SUFFIX}`;

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
      const redactedCustomerId = `gid://shopify/Customer/redacted-cust-${TEST_SUFFIX}_redacted_1698500000000`;
      const redactedAccountId = `account-redacted-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "customerId", name, "createdAt", "updatedAt"
        ) VALUES (
          ${redactedAccountId}, ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER', ${redactedCustomerId}, 'Redacted Customer',
          NOW(), NOW()
        )
      `;

      const draftRedacted = `gid://shopify/DraftOrder/redacted-${TEST_SUFFIX}`;
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
      const draft1 = `gid://shopify/DraftOrder/affected1-${TEST_SUFFIX}`;
      const draft2 = `gid://shopify/DraftOrder/affected2-${TEST_SUFFIX}`;
      const account2Id = `account-v11dm-2-${TEST_SUFFIX}`;
      const company2Id = `gid://shopify/Company/co2-v11dm-${TEST_SUFFIX}`;
      const location2Id = `gid://shopify/CompanyLocation/loc2-v11dm-${TEST_SUFFIX}`;

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
      const draftNullAccount = `gid://shopify/DraftOrder/null-account-${TEST_SUFFIX}`;
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
      const customerGone = `gid://shopify/Customer/gone-${TEST_SUFFIX}`;
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
      const customerStillExists = `gid://shopify/Customer/still-exists-${TEST_SUFFIX}`;
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
      const customerWithBalance = `gid://shopify/Customer/has-balance-${TEST_SUFFIX}`;
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
          ${"inv-balance-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, ${accountId}, ${"gid://shopify/Order/balance-" + TEST_SUFFIX},
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
      const customerWithDraft = `gid://shopify/Customer/has-draft-${TEST_SUFFIX}`;
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
          ${TEST_SHOP_ID}, ${"gid://shopify/DraftOrder/draft-skip-" + TEST_SUFFIX}, ${accountId}, '#DRAFT-SKIP', '500.00',
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

      await sql`DELETE FROM s8_draft_orders WHERE draft_order_id = ${"gid://shopify/DraftOrder/draft-skip-" + TEST_SUFFIX}`;
      await sql`DELETE FROM "BuyerAccount" WHERE id = ${accountId}`;
    });

    it("Shopify read failure deactivates nothing", async () => {
      const customerMissing = `gid://shopify/Customer/api-fail-${TEST_SUFFIX}`;
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
      const customerSeen = `gid://shopify/Customer/seen-cust-${TEST_SUFFIX}`;
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
      const customerWebhook = `gid://shopify/Customer/webhook-cust-${TEST_SUFFIX}`;
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
      const customerShopB = `gid://shopify/Customer/shopb-cust-${TEST_SUFFIX}`;
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
      const customerRedacted = `gid://shopify/Customer/redacted-cust-${TEST_SUFFIX}_redacted_1698500000000`;
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
      const customerActive = `gid://shopify/Customer/active-${TEST_SUFFIX}`;
      const customerInactive = `gid://shopify/Customer/inactive-${TEST_SUFFIX}`;

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
      const customerMissing = `gid://shopify/Customer/timestamp-cust-${TEST_SUFFIX}`;
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
      const draftSeen = `gid://shopify/DraftOrder/mix-seen-${TEST_SUFFIX}`;
      const draftUnseen = `gid://shopify/DraftOrder/mix-unseen-${TEST_SUFFIX}`;
      const draftNull = `gid://shopify/DraftOrder/mix-null-${TEST_SUFFIX}`;

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
      const draftOpen = `gid://shopify/DraftOrder/exp-open-${TEST_SUFFIX}`;
      const draftSent = `gid://shopify/DraftOrder/exp-sent-${TEST_SUFFIX}`;
      const draftCompleted = `gid://shopify/DraftOrder/exp-completed-${TEST_SUFFIX}`;
      const draftClosed = `gid://shopify/DraftOrder/exp-closed-${TEST_SUFFIX}`;

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
      const draft1 = `gid://shopify/DraftOrder/exp-unchanged1-${TEST_SUFFIX}`;
      const draft2 = `gid://shopify/DraftOrder/exp-unchanged2-${TEST_SUFFIX}`;

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
      const draftId = `gid://shopify/DraftOrder/pin-open-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO s8_draft_orders (shop_id, draft_order_id, buyer_account_id, name, total, has_payment_terms, status, created_at, updated_at)
        VALUES (${TEST_SHOP_ID}, ${draftId}, ${TEST_ACCOUNT_ID}, '#PIN-OPEN', '1000.00', true, 'open', NOW(), NOW())
      `;
      const exposure = await getPendingExposure(sql, TEST_ACCOUNT_ID);
      expect(exposure).toBe("1000.00");
    });

    it("counts 'invoice_sent' status in exposure", async () => {
      const draftId = `gid://shopify/DraftOrder/pin-sent-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO s8_draft_orders (shop_id, draft_order_id, buyer_account_id, name, total, has_payment_terms, status, created_at, updated_at)
        VALUES (${TEST_SHOP_ID}, ${draftId}, ${TEST_ACCOUNT_ID}, '#PIN-SENT', '2000.00', true, 'invoice_sent', NOW(), NOW())
      `;
      const exposure = await getPendingExposure(sql, TEST_ACCOUNT_ID);
      expect(exposure).toBe("2000.00");
    });

    it("excludes 'completed' status from exposure", async () => {
      const draftId = `gid://shopify/DraftOrder/pin-completed-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO s8_draft_orders (shop_id, draft_order_id, buyer_account_id, name, total, has_payment_terms, status, created_at, updated_at)
        VALUES (${TEST_SHOP_ID}, ${draftId}, ${TEST_ACCOUNT_ID}, '#PIN-COMPLETED', '3000.00', true, 'completed', NOW(), NOW())
      `;
      const exposure = await getPendingExposure(sql, TEST_ACCOUNT_ID);
      expect(exposure).toBe("0.00");
    });

    it("excludes 'closed' status from exposure", async () => {
      const draftId = `gid://shopify/DraftOrder/pin-closed-${TEST_SUFFIX}`;
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
      const draftId = `gid://shopify/DraftOrder/tx-rollback-${TEST_SUFFIX}`;
      
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

      const bulkOpId = `gid://shopify/BulkOperation/null-resume-${TEST_SUFFIX}`;
      const draftMissing = `gid://shopify/DraftOrder/null-resume-draft-${TEST_SUFFIX}`;

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
      const bulkOpId = `gid://shopify/BulkOperation/stale-token-${TEST_SUFFIX}`;

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
      const bulkOpId = `gid://shopify/BulkOperation/same-offset-${TEST_SUFFIX}`;

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

      const bulkOpId = `gid://shopify/BulkOperation/mismatch-minus1-${TEST_SUFFIX}`;
      const draftMissing = `gid://shopify/DraftOrder/mismatch-m1-draft-${TEST_SUFFIX}`;

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

      const bulkOpId = `gid://shopify/BulkOperation/mismatch-plus1-${TEST_SUFFIX}`;
      const draftMissing = `gid://shopify/DraftOrder/mismatch-p1-draft-${TEST_SUFFIX}`;

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
      const bulkOpId = `gid://shopify/BulkOperation/forward-progress-${TEST_SUFFIX}`;

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
      const bulkOpId = `gid://shopify/BulkOperation/claim-sets-processed-${TEST_SUFFIX}`;

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
          url: null,
          fileSize: null,
          objectCount: null,
          errorCode: null,
          partialDataUrl: null,
        },
      });

      const bulkOpId = `gid://shopify/BulkOperation/guard-status-${TEST_SUFFIX}`;
      const draftMissing = `gid://shopify/DraftOrder/guard-status-draft-${TEST_SUFFIX}`;

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

      const bulkOpId = `gid://shopify/BulkOperation/guard-errorcode-${TEST_SUFFIX}`;
      const draftMissing = `gid://shopify/DraftOrder/guard-errorcode-draft-${TEST_SUFFIX}`;

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

      const bulkOpId = `gid://shopify/BulkOperation/guard-partial-${TEST_SUFFIX}`;
      const draftMissing = `gid://shopify/DraftOrder/guard-partial-draft-${TEST_SUFFIX}`;

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

      const olderBulkOpId = `gid://shopify/BulkOperation/guard-older-${TEST_SUFFIX}`;
      const newerBulkOpId = `gid://shopify/BulkOperation/guard-newer-${TEST_SUFFIX}`;
      const draftMissing = `gid://shopify/DraftOrder/guard-newest-draft-${TEST_SUFFIX}`;

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

      const bulkOpId = `gid://shopify/BulkOperation/positive-close-${TEST_SUFFIX}`;
      const draftMissing = `gid://shopify/DraftOrder/positive-close-draft-${TEST_SUFFIX}`;

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
    it("objectCount 0 with lines_processed 0 passes guards and closes unseen drafts", async () => {
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

      const bulkOpId = `gid://shopify/BulkOperation/empty-result-${TEST_SUFFIX}`;
      const draftMissing = `gid://shopify/DraftOrder/empty-result-draft-${TEST_SUFFIX}`;

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
      expect(draftRow.status).toBe("closed");

      await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}`;
    });
  });

  describe("Deactivate race condition guards", () => {
    it("deactivateMissingTaggedCustomers respects shop_id and tag_active in final UPDATE", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/deactivate-race-${TEST_SUFFIX}`;
      const customerId = `gid://shopify/Customer/deactivate-race-${TEST_SUFFIX}`;

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
});
