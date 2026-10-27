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
 * - Act ONLY when the bulk operation finished successfully (COMPLETED, all pages consumed)
 * - Scope every update strictly to that shop (shop_id in WHERE)
 * - Soft only: mark closed or inactive, never hard-delete
 * - Never touch redacted rows (excluded explicitly)
 *
 * Uses native PostgreSQL with all migrations applied.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { closeMissingDraftOrders } from "../draft-order.server";
import { deactivateMissingTaggedCustomers } from "../customer.server";

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
    await sql`DELETE FROM s8_draft_orders WHERE shop_id IN (${TEST_SHOP_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id IN (${TEST_SHOP_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM s6_bulk_operations WHERE shop IN (${TEST_SHOP_DOMAIN}, ${SHOP_B_DOMAIN})`;
    await sql`DELETE FROM "AccountSource" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN (${TEST_SHOP_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "Shop" WHERE id IN (${TEST_SHOP_ID}, ${SHOP_B_ID})`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM s8_draft_orders WHERE shop_id IN (${TEST_SHOP_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id IN (${TEST_SHOP_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM s6_bulk_operations WHERE shop IN (${TEST_SHOP_DOMAIN}, ${SHOP_B_DOMAIN})`;
  });

  describe("closeMissingDraftOrders", () => {
    it("closes drafts not seen during a COMPLETE reconcile (updated_at < started_at)", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/dm-draft-close-${TEST_SUFFIX}`;
      const startedAt = new Date("2026-10-25T10:00:00Z");
      const completedAt = new Date("2026-10-25T10:05:00Z");

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, completed_at
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'draft_orders', 'reconcile', 'draft_orders',
          ${startedAt}, ${completedAt}
        )
      `;

      const draftMissing = `gid://shopify/DraftOrder/missing-${TEST_SUFFIX}`;
      const draftUpdatedBefore = new Date("2026-10-24T12:00:00Z");
      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at, updated_at
        ) VALUES (
          ${TEST_SHOP_ID}, ${draftMissing}, ${TEST_ACCOUNT_ID}, '#MISSING', '1000.00',
          true, 'open', ${draftUpdatedBefore}, ${draftUpdatedBefore}
        )
      `;

      const closedCount = await closeMissingDraftOrders(sql, TEST_SHOP_DOMAIN, bulkOpId);

      expect(closedCount.closedCount).toBe(1);

      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftMissing}
      `;
      expect(row.status).toBe("closed");
    });

    it("does NOT close drafts that were seen (updated_at >= started_at)", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/dm-draft-keep-${TEST_SUFFIX}`;
      const startedAt = new Date("2026-10-25T10:00:00Z");
      const completedAt = new Date("2026-10-25T10:05:00Z");

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, completed_at
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'draft_orders', 'reconcile', 'draft_orders',
          ${startedAt}, ${completedAt}
        )
      `;

      const draftSeen = `gid://shopify/DraftOrder/seen-${TEST_SUFFIX}`;
      const draftUpdatedAfter = new Date("2026-10-25T10:02:00Z");
      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at, updated_at
        ) VALUES (
          ${TEST_SHOP_ID}, ${draftSeen}, ${TEST_ACCOUNT_ID}, '#SEEN', '2000.00',
          true, 'open', NOW(), ${draftUpdatedAfter}
        )
      `;

      const closedCount = await closeMissingDraftOrders(sql, TEST_SHOP_DOMAIN, bulkOpId);

      expect(closedCount.closedCount).toBe(0);

      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftSeen}
      `;
      expect(row.status).toBe("open");
    });

    it("does NOT close drafts when op has no completed_at (partial/failed run)", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/dm-draft-partial-${TEST_SUFFIX}`;
      const startedAt = new Date("2026-10-25T10:00:00Z");

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'draft_orders', 'reconcile', 'draft_orders',
          ${startedAt}
        )
      `;

      const draftMissing = `gid://shopify/DraftOrder/partial-missing-${TEST_SUFFIX}`;
      const draftUpdatedBefore = new Date("2026-10-24T12:00:00Z");
      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at, updated_at
        ) VALUES (
          ${TEST_SHOP_ID}, ${draftMissing}, ${TEST_ACCOUNT_ID}, '#PARTIAL', '1000.00',
          true, 'open', ${draftUpdatedBefore}, ${draftUpdatedBefore}
        )
      `;

      const closedCount = await closeMissingDraftOrders(sql, TEST_SHOP_DOMAIN, bulkOpId);

      expect(closedCount.closedCount).toBe(0);

      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftMissing}
      `;
      expect(row.status).toBe("open");
    });

    it("does NOT touch another shop's rows (scoped by shop_id)", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/dm-draft-scope-${TEST_SUFFIX}`;
      const startedAt = new Date("2026-10-25T10:00:00Z");
      const completedAt = new Date("2026-10-25T10:05:00Z");

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, completed_at
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'draft_orders', 'reconcile', 'draft_orders',
          ${startedAt}, ${completedAt}
        )
      `;

      const draftShopB = `gid://shopify/DraftOrder/shopb-${TEST_SUFFIX}`;
      const draftUpdatedBefore = new Date("2026-10-24T12:00:00Z");
      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, name, total,
          has_payment_terms, status, created_at, updated_at
        ) VALUES (
          ${SHOP_B_ID}, ${draftShopB}, '#SHOPB', '3000.00',
          true, 'open', ${draftUpdatedBefore}, ${draftUpdatedBefore}
        )
      `;

      const closedCount = await closeMissingDraftOrders(sql, TEST_SHOP_DOMAIN, bulkOpId);

      expect(closedCount.closedCount).toBe(0);

      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftShopB}
      `;
      expect(row.status).toBe("open");
    });

    it("only closes open and invoice_sent drafts, not completed ones", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/dm-draft-status-${TEST_SUFFIX}`;
      const startedAt = new Date("2026-10-25T10:00:00Z");
      const completedAt = new Date("2026-10-25T10:05:00Z");
      const draftUpdatedBefore = new Date("2026-10-24T12:00:00Z");

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, completed_at
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'draft_orders', 'reconcile', 'draft_orders',
          ${startedAt}, ${completedAt}
        )
      `;

      const draftOpen = `gid://shopify/DraftOrder/status-open-${TEST_SUFFIX}`;
      const draftSent = `gid://shopify/DraftOrder/status-sent-${TEST_SUFFIX}`;
      const draftCompleted = `gid://shopify/DraftOrder/status-completed-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s8_draft_orders (shop_id, draft_order_id, name, total, has_payment_terms, status, created_at, updated_at)
        VALUES
          (${TEST_SHOP_ID}, ${draftOpen}, '#OPEN', '1000.00', true, 'open', ${draftUpdatedBefore}, ${draftUpdatedBefore}),
          (${TEST_SHOP_ID}, ${draftSent}, '#SENT', '2000.00', true, 'invoice_sent', ${draftUpdatedBefore}, ${draftUpdatedBefore}),
          (${TEST_SHOP_ID}, ${draftCompleted}, '#COMPLETED', '3000.00', true, 'completed', ${draftUpdatedBefore}, ${draftUpdatedBefore})
      `;

      const closedCount = await closeMissingDraftOrders(sql, TEST_SHOP_DOMAIN, bulkOpId);

      expect(closedCount.closedCount).toBe(2);

      const rows = await sql<{ draft_order_id: string; status: string }[]>`
        SELECT draft_order_id, status FROM s8_draft_orders
        WHERE shop_id = ${TEST_SHOP_ID}
        ORDER BY draft_order_id
      `;

      const openRow = rows.find((r) => r.draft_order_id === draftOpen);
      const sentRow = rows.find((r) => r.draft_order_id === draftSent);
      const completedRow = rows.find((r) => r.draft_order_id === draftCompleted);

      expect(openRow?.status).toBe("closed");
      expect(sentRow?.status).toBe("closed");
      expect(completedRow?.status).toBe("completed");
    });

    it("does NOT touch redacted rows (buyer account with _redacted_ customerId)", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/dm-draft-redact-${TEST_SUFFIX}`;
      const startedAt = new Date("2026-10-25T10:00:00Z");
      const completedAt = new Date("2026-10-25T10:05:00Z");
      const draftUpdatedBefore = new Date("2026-10-24T12:00:00Z");

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, completed_at
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'draft_orders', 'reconcile', 'draft_orders',
          ${startedAt}, ${completedAt}
        )
      `;

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
          has_payment_terms, status, created_at, updated_at
        ) VALUES (
          ${TEST_SHOP_ID}, ${draftRedacted}, ${redactedAccountId}, '#REDACTED', '5000.00',
          true, 'open', ${draftUpdatedBefore}, ${draftUpdatedBefore}
        )
      `;

      const closedCount = await closeMissingDraftOrders(sql, TEST_SHOP_DOMAIN, bulkOpId);

      expect(closedCount.closedCount).toBe(0);

      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftRedacted}
      `;
      expect(row.status).toBe("open");

      await sql`DELETE FROM s8_draft_orders WHERE draft_order_id = ${draftRedacted}`;
      await sql`DELETE FROM "BuyerAccount" WHERE id = ${redactedAccountId}`;
    });
  });

  describe("deactivateMissingTaggedCustomers", () => {
    it("deactivates customers not seen during a COMPLETE reconcile", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/dm-cust-deact-${TEST_SUFFIX}`;
      const startedAt = new Date("2026-10-25T10:00:00Z");
      const completedAt = new Date("2026-10-25T10:05:00Z");

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, completed_at
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'customers', 'reconcile', 'customers',
          ${startedAt}, ${completedAt}
        )
      `;

      const customerMissing = `gid://shopify/Customer/missing-cust-${TEST_SUFFIX}`;
      const customerUpdatedBefore = new Date("2026-10-24T12:00:00Z");
      await sql`
        INSERT INTO s8_tagged_customers (
          shop_id, customer_id, tags, tag_active, created_at, updated_at
        ) VALUES (
          ${TEST_SHOP_ID}, ${customerMissing}, '["net-terms"]'::jsonb, true,
          ${customerUpdatedBefore}, ${customerUpdatedBefore}
        )
      `;

      const deactivatedCount = await deactivateMissingTaggedCustomers(sql, TEST_SHOP_DOMAIN, bulkOpId);

      expect(deactivatedCount).toBe(1);

      const [row] = await sql<{ tag_active: boolean; tag_deactivated_at: Date | null }[]>`
        SELECT tag_active, tag_deactivated_at FROM s8_tagged_customers WHERE customer_id = ${customerMissing}
      `;
      expect(row.tag_active).toBe(false);
      expect(row.tag_deactivated_at).not.toBeNull();
    });

    it("does NOT deactivate customers that were seen (updated_at >= started_at)", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/dm-cust-keep-${TEST_SUFFIX}`;
      const startedAt = new Date("2026-10-25T10:00:00Z");
      const completedAt = new Date("2026-10-25T10:05:00Z");

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, completed_at
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'customers', 'reconcile', 'customers',
          ${startedAt}, ${completedAt}
        )
      `;

      const customerSeen = `gid://shopify/Customer/seen-cust-${TEST_SUFFIX}`;
      const customerUpdatedAfter = new Date("2026-10-25T10:02:00Z");
      await sql`
        INSERT INTO s8_tagged_customers (
          shop_id, customer_id, tags, tag_active, created_at, updated_at
        ) VALUES (
          ${TEST_SHOP_ID}, ${customerSeen}, '["net-terms"]'::jsonb, true,
          NOW(), ${customerUpdatedAfter}
        )
      `;

      const deactivatedCount = await deactivateMissingTaggedCustomers(sql, TEST_SHOP_DOMAIN, bulkOpId);

      expect(deactivatedCount).toBe(0);

      const [row] = await sql<{ tag_active: boolean }[]>`
        SELECT tag_active FROM s8_tagged_customers WHERE customer_id = ${customerSeen}
      `;
      expect(row.tag_active).toBe(true);
    });

    it("does NOT deactivate customers when op has no completed_at (partial/failed run)", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/dm-cust-partial-${TEST_SUFFIX}`;
      const startedAt = new Date("2026-10-25T10:00:00Z");

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'customers', 'reconcile', 'customers',
          ${startedAt}
        )
      `;

      const customerMissing = `gid://shopify/Customer/partial-cust-${TEST_SUFFIX}`;
      const customerUpdatedBefore = new Date("2026-10-24T12:00:00Z");
      await sql`
        INSERT INTO s8_tagged_customers (
          shop_id, customer_id, tags, tag_active, created_at, updated_at
        ) VALUES (
          ${TEST_SHOP_ID}, ${customerMissing}, '["net-terms"]'::jsonb, true,
          ${customerUpdatedBefore}, ${customerUpdatedBefore}
        )
      `;

      const deactivatedCount = await deactivateMissingTaggedCustomers(sql, TEST_SHOP_DOMAIN, bulkOpId);

      expect(deactivatedCount).toBe(0);

      const [row] = await sql<{ tag_active: boolean }[]>`
        SELECT tag_active FROM s8_tagged_customers WHERE customer_id = ${customerMissing}
      `;
      expect(row.tag_active).toBe(true);
    });

    it("does NOT touch another shop's rows (scoped by shop_id)", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/dm-cust-scope-${TEST_SUFFIX}`;
      const startedAt = new Date("2026-10-25T10:00:00Z");
      const completedAt = new Date("2026-10-25T10:05:00Z");

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, completed_at
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'customers', 'reconcile', 'customers',
          ${startedAt}, ${completedAt}
        )
      `;

      const customerShopB = `gid://shopify/Customer/shopb-cust-${TEST_SUFFIX}`;
      const customerUpdatedBefore = new Date("2026-10-24T12:00:00Z");
      await sql`
        INSERT INTO s8_tagged_customers (
          shop_id, customer_id, tags, tag_active, created_at, updated_at
        ) VALUES (
          ${SHOP_B_ID}, ${customerShopB}, '["net-terms"]'::jsonb, true,
          ${customerUpdatedBefore}, ${customerUpdatedBefore}
        )
      `;

      const deactivatedCount = await deactivateMissingTaggedCustomers(sql, TEST_SHOP_DOMAIN, bulkOpId);

      expect(deactivatedCount).toBe(0);

      const [row] = await sql<{ tag_active: boolean }[]>`
        SELECT tag_active FROM s8_tagged_customers WHERE customer_id = ${customerShopB}
      `;
      expect(row.tag_active).toBe(true);
    });

    it("does NOT touch redacted rows (customer_id containing _redacted_)", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/dm-cust-redact-${TEST_SUFFIX}`;
      const startedAt = new Date("2026-10-25T10:00:00Z");
      const completedAt = new Date("2026-10-25T10:05:00Z");

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, completed_at
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'customers', 'reconcile', 'customers',
          ${startedAt}, ${completedAt}
        )
      `;

      const customerRedacted = `gid://shopify/Customer/redacted-cust-${TEST_SUFFIX}_redacted_1698500000000`;
      const customerUpdatedBefore = new Date("2026-10-24T12:00:00Z");
      await sql`
        INSERT INTO s8_tagged_customers (
          shop_id, customer_id, tags, tag_active, created_at, updated_at
        ) VALUES (
          ${TEST_SHOP_ID}, ${customerRedacted}, '["net-terms"]'::jsonb, true,
          ${customerUpdatedBefore}, ${customerUpdatedBefore}
        )
      `;

      const deactivatedCount = await deactivateMissingTaggedCustomers(sql, TEST_SHOP_DOMAIN, bulkOpId);

      expect(deactivatedCount).toBe(0);

      const [row] = await sql<{ tag_active: boolean }[]>`
        SELECT tag_active FROM s8_tagged_customers WHERE customer_id = ${customerRedacted}
      `;
      expect(row.tag_active).toBe(true);
    });

    it("only deactivates tag_active=true customers, not already inactive ones", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/dm-cust-inactive-${TEST_SUFFIX}`;
      const startedAt = new Date("2026-10-25T10:00:00Z");
      const completedAt = new Date("2026-10-25T10:05:00Z");
      const customerUpdatedBefore = new Date("2026-10-24T12:00:00Z");

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, completed_at
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'customers', 'reconcile', 'customers',
          ${startedAt}, ${completedAt}
        )
      `;

      const customerActive = `gid://shopify/Customer/active-${TEST_SUFFIX}`;
      const customerInactive = `gid://shopify/Customer/inactive-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, created_at, updated_at)
        VALUES
          (${TEST_SHOP_ID}, ${customerActive}, '["net-terms"]'::jsonb, true, ${customerUpdatedBefore}, ${customerUpdatedBefore}),
          (${TEST_SHOP_ID}, ${customerInactive}, '["net-terms"]'::jsonb, false, ${customerUpdatedBefore}, ${customerUpdatedBefore})
      `;

      const deactivatedCount = await deactivateMissingTaggedCustomers(sql, TEST_SHOP_DOMAIN, bulkOpId);

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
  });

  describe("cross-feature scenarios", () => {
    it("a partial, failed or cancelled run changes nothing (drafts and customers)", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/dm-cross-partial-${TEST_SUFFIX}`;
      const startedAt = new Date("2026-10-25T10:00:00Z");

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, failure_count
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'draft_orders', 'reconcile', 'draft_orders',
          ${startedAt}, 5
        )
      `;

      const draftMissing = `gid://shopify/DraftOrder/cross-partial-${TEST_SUFFIX}`;
      const customerMissing = `gid://shopify/Customer/cross-partial-${TEST_SUFFIX}`;
      const updatedBefore = new Date("2026-10-24T12:00:00Z");

      await sql`
        INSERT INTO s8_draft_orders (shop_id, draft_order_id, name, total, has_payment_terms, status, created_at, updated_at)
        VALUES (${TEST_SHOP_ID}, ${draftMissing}, '#CROSS', '1000.00', true, 'open', ${updatedBefore}, ${updatedBefore})
      `;

      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, created_at, updated_at)
        VALUES (${TEST_SHOP_ID}, ${customerMissing}, '["net-terms"]'::jsonb, true, ${updatedBefore}, ${updatedBefore})
      `;

      const draftsClosed = await closeMissingDraftOrders(sql, TEST_SHOP_DOMAIN, bulkOpId);
      const customersDeactivated = await deactivateMissingTaggedCustomers(sql, TEST_SHOP_DOMAIN, bulkOpId);

      expect(draftsClosed.closedCount).toBe(0);
      expect(customersDeactivated).toBe(0);

      const [draftRow] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftMissing}
      `;
      const [customerRow] = await sql<{ tag_active: boolean }[]>`
        SELECT tag_active FROM s8_tagged_customers WHERE customer_id = ${customerMissing}
      `;

      expect(draftRow.status).toBe("open");
      expect(customerRow.tag_active).toBe(true);
    });
  });
});
