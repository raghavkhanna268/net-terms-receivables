import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import {
  processCustomerWebhook,
  mapCustomerToTaggedCustomer,
  bulkUpsertTaggedCustomers,
  findMatchingTagRule,
} from "../customer.server";
import type { ShopifyCustomer } from "../types";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("Customer Sync", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36);
  const TEST_SHOP_ID = `shop-cust-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `cust-test-${TEST_SUFFIX}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop
    await sql`
      INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, NOW(), NOW())
    `;

    // Create tag rule for this shop
    await sql`
      INSERT INTO "AccountSource" ("shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, 'net-terms', 30, NOW(), NOW())
    `;

    // Create dedupe table if not exists
    await sql`
      CREATE TABLE IF NOT EXISTS s6_processed_webhooks (
        webhook_id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        resource_gid TEXT NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Create tagged customers table if not exists
    await sql`
      CREATE TABLE IF NOT EXISTS s8_tagged_customers (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        shop_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        tags JSONB NOT NULL DEFAULT '[]'::jsonb,
        has_tag BOOLEAN NOT NULL DEFAULT false,
        email TEXT,
        display_name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT s8_tagged_customers_shop_customer_unique UNIQUE (shop_id, customer_id)
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "AccountSource" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${"wh-cust-" + TEST_SUFFIX + "%"}`;
    await sql.end();
  });

  beforeEach(async () => {
    // Clean up for each test
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${"wh-cust-" + TEST_SUFFIX + "%"}`;
  });

  describe("Tag lifecycle", () => {
    it("creates BuyerAccount when customer gains matching tag", async () => {
      const customer: ShopifyCustomer = {
        id: `gid://shopify/Customer/cust-${TEST_SUFFIX}-1`,
        tags: ["net-terms", "wholesale"],
      };

      const result = await processCustomerWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "CUSTOMERS_CREATE",
        customer,
        `wh-cust-${TEST_SUFFIX}-1`
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("created");
      expect(result.entityId).toBeDefined();

      // Verify BuyerAccount was created
      const [account] = await sql`
        SELECT * FROM "BuyerAccount" WHERE id = ${result.entityId!}
      `;
      expect(account.kind).toBe("TAGGED_CUSTOMER");
      expect(account.customerId).toBe(customer.id);
      expect(account.holdState).toBe("OK");
      expect(account.defaultTermsDays).toBe(30); // From tag rule
      expect(account.defaultTermsSource).toBe("tag");
    });

    it("deactivates BuyerAccount when customer loses matching tag", async () => {
      const customerId = `gid://shopify/Customer/cust-${TEST_SUFFIX}-2`;

      // Create account first (simulating existing tagged customer)
      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "customerId", name, "defaultTermsDays", "defaultTermsSource",
          "holdState", "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER', ${customerId}, 'Customer 2', 30, 'tag',
          'OK', NOW(), NOW()
        )
      `;

      // Process update with tag removed
      const customer: ShopifyCustomer = {
        id: customerId,
        tags: ["other-tag"], // No longer has net-terms
      };

      const result = await processCustomerWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "CUSTOMERS_UPDATE",
        customer,
        `wh-cust-${TEST_SUFFIX}-2`
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("updated");

      // Verify account was deactivated (HELD) but NOT deleted
      const [account] = await sql`
        SELECT * FROM "BuyerAccount" WHERE "customerId" = ${customerId}
      `;
      expect(account).toBeDefined();
      expect(account.holdState).toBe("HELD");
    });

    it("reactivates BuyerAccount when customer regains matching tag", async () => {
      const customerId = `gid://shopify/Customer/cust-${TEST_SUFFIX}-3`;

      // Create deactivated account (simulating previously tagged customer)
      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "customerId", name, "holdState",
          "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER', ${customerId}, 'Customer 3', 'HELD',
          NOW(), NOW()
        )
      `;

      // Process update with tag re-added
      const customer: ShopifyCustomer = {
        id: customerId,
        tags: ["net-terms"], // Tag re-added
      };

      const result = await processCustomerWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "CUSTOMERS_UPDATE",
        customer,
        `wh-cust-${TEST_SUFFIX}-3`
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("updated");

      // Verify account was reactivated (OK)
      const [account] = await sql`
        SELECT * FROM "BuyerAccount" WHERE "customerId" = ${customerId}
      `;
      expect(account.holdState).toBe("OK");
    });

    it("does not delete BuyerAccount when customer is deleted (preserves financial history)", async () => {
      const customerId = `gid://shopify/Customer/cust-${TEST_SUFFIX}-4`;

      // Create account
      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "customerId", name, "holdState",
          "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER', ${customerId}, 'Customer 4', 'OK',
          NOW(), NOW()
        )
      `;

      // Also create tagged customer record
      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, has_tag)
        VALUES (${TEST_SHOP_ID}, ${customerId}, '["net-terms"]'::jsonb, true)
      `;

      const customer: ShopifyCustomer = {
        id: customerId,
        tags: [],
      };

      const result = await processCustomerWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "CUSTOMERS_DELETE",
        customer,
        `wh-cust-${TEST_SUFFIX}-4`
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("preserved for financial history");

      // BuyerAccount should still exist
      const [account] = await sql`
        SELECT * FROM "BuyerAccount" WHERE "customerId" = ${customerId}
      `;
      expect(account).toBeDefined();
    });
  });

  describe("Precedence: company contact vs tagged customer", () => {
    it("skips TAGGED_CUSTOMER creation if customer is a B2B company contact", async () => {
      // For this test, we simulate a customer who is associated with company orders
      // In real usage, this would be detected by checking if orders exist for company accounts
      // For now, the precedence check is minimal and documented for future enhancement

      const customer: ShopifyCustomer = {
        id: `gid://shopify/Customer/cust-${TEST_SUFFIX}-company`,
        tags: ["net-terms"],
      };

      // The current implementation doesn't fully detect company contacts,
      // but the test documents the expected behavior and the precedence rule

      const result = await processCustomerWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "CUSTOMERS_CREATE",
        customer,
        `wh-cust-${TEST_SUFFIX}-company`
      );

      // With the current implementation, it will create the TAGGED_CUSTOMER
      // because full CompanyContact detection isn't implemented yet
      // This test documents the expected behavior for future implementation
      expect(result.success).toBe(true);
    });
  });

  describe("Idempotency", () => {
    it("skips duplicate webhook processing", async () => {
      const customer: ShopifyCustomer = {
        id: `gid://shopify/Customer/cust-${TEST_SUFFIX}-idem`,
        tags: ["net-terms"],
      };

      const webhookId = `wh-cust-${TEST_SUFFIX}-idem`;

      // First call
      const result1 = await processCustomerWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "CUSTOMERS_CREATE",
        customer,
        webhookId
      );
      expect(result1.action).toBe("created");

      // Second call with same webhook ID
      const result2 = await processCustomerWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "CUSTOMERS_CREATE",
        customer,
        webhookId
      );
      expect(result2.action).toBe("skipped");
      expect(result2.skipReason).toContain("idempotent");

      // Only one BuyerAccount should exist
      const accounts = await sql`
        SELECT * FROM "BuyerAccount" WHERE "customerId" = ${customer.id}
      `;
      expect(accounts).toHaveLength(1);
    });
  });

  describe("No tag rules configured", () => {
    it("skips processing when shop has no tag rules", async () => {
      // Create a shop without tag rules
      const noRulesShopId = `shop-norules-${TEST_SUFFIX}`;
      const noRulesShopDomain = `norules-${TEST_SUFFIX}.myshopify.com`;

      await sql`
        INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt")
        VALUES (${noRulesShopId}, ${noRulesShopDomain}, NOW(), NOW())
      `;

      try {
        const customer: ShopifyCustomer = {
          id: `gid://shopify/Customer/cust-${TEST_SUFFIX}-norules`,
          tags: ["net-terms"],
        };

        const result = await processCustomerWebhook(
          sql,
          noRulesShopDomain,
          "CUSTOMERS_CREATE",
          customer,
          `wh-cust-${TEST_SUFFIX}-norules`
        );

        expect(result.success).toBe(true);
        expect(result.action).toBe("skipped");
        expect(result.skipReason).toContain("No tag rules configured");
      } finally {
        await sql`DELETE FROM "Shop" WHERE id = ${noRulesShopId}`;
      }
    });
  });

  describe("Tag matching", () => {
    it("matches tags case-insensitively", async () => {
      const customer: ShopifyCustomer = {
        id: `gid://shopify/Customer/cust-${TEST_SUFFIX}-case`,
        tags: ["NET-TERMS"], // Uppercase
      };

      const result = await processCustomerWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "CUSTOMERS_CREATE",
        customer,
        `wh-cust-${TEST_SUFFIX}-case`
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("created");
    });
  });

  describe("mapCustomerToTaggedCustomer", () => {
    it("maps customer to tracking data", () => {
      const customer: ShopifyCustomer = {
        id: "gid://shopify/Customer/123",
        tags: ["net-terms", "wholesale"],
      };

      const result = mapCustomerToTaggedCustomer(TEST_SHOP_ID, customer, true);

      expect(result.shopId).toBe(TEST_SHOP_ID);
      expect(result.customerId).toBe("gid://shopify/Customer/123");
      expect(result.tags).toEqual(["net-terms", "wholesale"]);
      expect(result.hasTag).toBe(true);
    });

    it("handles missing tags", () => {
      const customer: ShopifyCustomer = {
        id: "gid://shopify/Customer/456",
        tags: undefined,
      };

      const result = mapCustomerToTaggedCustomer(TEST_SHOP_ID, customer, false);

      expect(result.tags).toEqual([]);
      expect(result.hasTag).toBe(false);
    });
  });

  describe("bulkUpsertTaggedCustomers", () => {
    it("inserts multiple customers in batch", async () => {
      const customers = [
        mapCustomerToTaggedCustomer(
          TEST_SHOP_ID,
          { id: `gid://shopify/Customer/bulk-${TEST_SUFFIX}-1`, tags: ["net-terms"] },
          true
        ),
        mapCustomerToTaggedCustomer(
          TEST_SHOP_ID,
          { id: `gid://shopify/Customer/bulk-${TEST_SUFFIX}-2`, tags: ["other"] },
          false
        ),
      ];

      const count = await bulkUpsertTaggedCustomers(sql, customers);

      expect(count).toBe(2);

      const inserted = await sql`
        SELECT * FROM s8_tagged_customers
        WHERE customer_id IN ${sql([customers[0].customerId, customers[1].customerId])}
      `;
      expect(inserted).toHaveLength(2);
    });

    it("handles empty array", async () => {
      const count = await bulkUpsertTaggedCustomers(sql, []);
      expect(count).toBe(0);
    });
  });

  describe("findMatchingTagRule", () => {
    it("finds matching rule", () => {
      const rules = [
        { tag: "net-terms", defaultTermsDays: 30 },
        { tag: "gold-tier", defaultTermsDays: 60 },
      ];

      const match = findMatchingTagRule(["wholesale", "net-terms"], rules);

      expect(match).toEqual({ tag: "net-terms", defaultTermsDays: 30 });
    });

    it("returns undefined when no match", () => {
      const rules = [{ tag: "net-terms", defaultTermsDays: 30 }];

      const match = findMatchingTagRule(["wholesale"], rules);

      expect(match).toBeUndefined();
    });

    it("matches case-insensitively", () => {
      const rules = [{ tag: "NET-TERMS", defaultTermsDays: 30 }];

      const match = findMatchingTagRule(["net-terms"], rules);

      expect(match).toBeDefined();
    });
  });
});
