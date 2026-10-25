/**
 * DB-backed integration tests for S8 reconcile_customers_drafts migration.
 *
 * Tests that the CHECK constraints on s6_bulk_operations:
 * 1. Have exactly one constraint for reconcile_stage and one for bulk_type
 * 2. Constraints contain all four expected values
 * 3. Accept valid values and reject invalid values
 *
 * Uses pg16-pgmq:v1.5.1 container with all migrations applied.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "../../../app/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("S8 reconcile_customers_drafts migration CHECK constraints", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-s8check";
  const TEST_SHOP_DOMAIN = `test-s8check-${TEST_SUFFIX}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    await sql`DELETE FROM s6_bulk_operations WHERE shop = ${TEST_SHOP_DOMAIN}`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM s6_bulk_operations WHERE shop = ${TEST_SHOP_DOMAIN}`;
  });

  describe("pg_constraint verification", () => {
    it("has exactly one check constraint referencing reconcile_stage", async () => {
      const constraints = await sql<{ conname: string; condef: string }[]>`
        SELECT c.conname, pg_get_constraintdef(c.oid) as condef
        FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        WHERE t.relname = 's6_bulk_operations'
          AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) LIKE '%reconcile_stage%'
      `;

      expect(constraints).toHaveLength(1);
      expect(constraints[0].conname).toBe("s6_bulk_operations_reconcile_stage_check");
    });

    it("has exactly one check constraint referencing bulk_type", async () => {
      const constraints = await sql<{ conname: string; condef: string }[]>`
        SELECT c.conname, pg_get_constraintdef(c.oid) as condef
        FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        WHERE t.relname = 's6_bulk_operations'
          AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) LIKE '%bulk_type%'
      `;

      expect(constraints).toHaveLength(1);
      expect(constraints[0].conname).toBe("s6_bulk_operations_bulk_type_check");
    });

    it("reconcile_stage constraint contains all four expected values", async () => {
      const [constraint] = await sql<{ condef: string }[]>`
        SELECT pg_get_constraintdef(c.oid) as condef
        FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        WHERE t.relname = 's6_bulk_operations'
          AND c.conname = 's6_bulk_operations_reconcile_stage_check'
      `;

      expect(constraint).toBeDefined();
      expect(constraint.condef).toContain("'companies'");
      expect(constraint.condef).toContain("'orders'");
      expect(constraint.condef).toContain("'customers'");
      expect(constraint.condef).toContain("'draft_orders'");
    });

    it("bulk_type constraint contains all four expected values", async () => {
      const [constraint] = await sql<{ condef: string }[]>`
        SELECT pg_get_constraintdef(c.oid) as condef
        FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        WHERE t.relname = 's6_bulk_operations'
          AND c.conname = 's6_bulk_operations_bulk_type_check'
      `;

      expect(constraint).toBeDefined();
      expect(constraint.condef).toContain("'companies'");
      expect(constraint.condef).toContain("'orders'");
      expect(constraint.condef).toContain("'customers'");
      expect(constraint.condef).toContain("'draft_orders'");
    });
  });

  describe("reconcile_stage CHECK accepts/rejects", () => {
    it("accepts reconcile_stage 'companies'", async () => {
      await expect(
        sql`
          INSERT INTO s6_bulk_operations (shop, bulk_operation_id, bulk_type, origin, reconcile_stage, status)
          VALUES (${TEST_SHOP_DOMAIN}, 'gid://shopify/BulkOperation/companies-1', 'companies', 'reconcile', 'companies', 'CREATED')
        `
      ).resolves.not.toThrow();
    });

    it("accepts reconcile_stage 'orders'", async () => {
      await expect(
        sql`
          INSERT INTO s6_bulk_operations (shop, bulk_operation_id, bulk_type, origin, reconcile_stage, status)
          VALUES (${TEST_SHOP_DOMAIN}, 'gid://shopify/BulkOperation/orders-1', 'orders', 'reconcile', 'orders', 'CREATED')
        `
      ).resolves.not.toThrow();
    });

    it("accepts reconcile_stage 'customers'", async () => {
      await expect(
        sql`
          INSERT INTO s6_bulk_operations (shop, bulk_operation_id, bulk_type, origin, reconcile_stage, status)
          VALUES (${TEST_SHOP_DOMAIN}, 'gid://shopify/BulkOperation/customers-1', 'customers', 'reconcile', 'customers', 'CREATED')
        `
      ).resolves.not.toThrow();
    });

    it("accepts reconcile_stage 'draft_orders'", async () => {
      await expect(
        sql`
          INSERT INTO s6_bulk_operations (shop, bulk_operation_id, bulk_type, origin, reconcile_stage, status)
          VALUES (${TEST_SHOP_DOMAIN}, 'gid://shopify/BulkOperation/drafts-1', 'draft_orders', 'reconcile', 'draft_orders', 'CREATED')
        `
      ).resolves.not.toThrow();
    });

    it("accepts reconcile_stage NULL", async () => {
      await expect(
        sql`
          INSERT INTO s6_bulk_operations (shop, bulk_operation_id, bulk_type, origin, reconcile_stage, status)
          VALUES (${TEST_SHOP_DOMAIN}, 'gid://shopify/BulkOperation/null-stage', 'companies', 'initial', NULL, 'CREATED')
        `
      ).resolves.not.toThrow();
    });

    it("rejects unknown reconcile_stage value", async () => {
      await expect(
        sql`
          INSERT INTO s6_bulk_operations (shop, bulk_operation_id, bulk_type, origin, reconcile_stage, status)
          VALUES (${TEST_SHOP_DOMAIN}, 'gid://shopify/BulkOperation/unknown-1', 'companies', 'reconcile', 'unknown_stage', 'CREATED')
        `
      ).rejects.toThrow(/violates check constraint/i);
    });
  });

  describe("bulk_type CHECK accepts/rejects", () => {
    it("accepts bulk_type 'companies'", async () => {
      await expect(
        sql`
          INSERT INTO s6_bulk_operations (shop, bulk_operation_id, bulk_type, origin, status)
          VALUES (${TEST_SHOP_DOMAIN}, 'gid://shopify/BulkOperation/bt-companies', 'companies', 'initial', 'CREATED')
        `
      ).resolves.not.toThrow();
    });

    it("accepts bulk_type 'orders'", async () => {
      await expect(
        sql`
          INSERT INTO s6_bulk_operations (shop, bulk_operation_id, bulk_type, origin, status)
          VALUES (${TEST_SHOP_DOMAIN}, 'gid://shopify/BulkOperation/bt-orders', 'orders', 'initial', 'CREATED')
        `
      ).resolves.not.toThrow();
    });

    it("accepts bulk_type 'customers'", async () => {
      await expect(
        sql`
          INSERT INTO s6_bulk_operations (shop, bulk_operation_id, bulk_type, origin, status)
          VALUES (${TEST_SHOP_DOMAIN}, 'gid://shopify/BulkOperation/bt-customers', 'customers', 'initial', 'CREATED')
        `
      ).resolves.not.toThrow();
    });

    it("accepts bulk_type 'draft_orders'", async () => {
      await expect(
        sql`
          INSERT INTO s6_bulk_operations (shop, bulk_operation_id, bulk_type, origin, status)
          VALUES (${TEST_SHOP_DOMAIN}, 'gid://shopify/BulkOperation/bt-drafts', 'draft_orders', 'initial', 'CREATED')
        `
      ).resolves.not.toThrow();
    });

    it("rejects unknown bulk_type value", async () => {
      await expect(
        sql`
          INSERT INTO s6_bulk_operations (shop, bulk_operation_id, bulk_type, origin, status)
          VALUES (${TEST_SHOP_DOMAIN}, 'gid://shopify/BulkOperation/bt-unknown', 'unknown_type', 'initial', 'CREATED')
        `
      ).rejects.toThrow(/violates check constraint/i);
    });
  });
});
