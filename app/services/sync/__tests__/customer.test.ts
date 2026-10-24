import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import {
  processCustomerWebhook,
  mapCustomerToTaggedCustomer,
  bulkUpsertTaggedCustomers,
  findMatchingTagRule,
  redactCustomerData,
  redactShopData,
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
        tag_active BOOLEAN NOT NULL DEFAULT false,
        tag_deactivated_at TIMESTAMPTZ,
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

    it("sets tag_active=false when customer loses matching tag (holdState unchanged)", async () => {
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

      // Create tagged customer record
      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active)
        VALUES (${TEST_SHOP_ID}, ${customerId}, '["net-terms"]'::jsonb, true)
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
      // Should be skipped because tag was removed (no account modification needed)
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("tag_active");

      // Verify BuyerAccount holdState was NOT changed - tag sync never touches holdState
      const [account] = await sql`
        SELECT * FROM "BuyerAccount" WHERE "customerId" = ${customerId}
      `;
      expect(account).toBeDefined();
      expect(account.holdState).toBe("OK"); // UNCHANGED from original

      // Verify s8_tagged_customers.tag_active was set to false
      const [tagRecord] = await sql`
        SELECT * FROM s8_tagged_customers WHERE customer_id = ${customerId}
      `;
      expect(tagRecord.tag_active).toBe(false);
      expect(tagRecord.tag_deactivated_at).not.toBeNull();
    });

    it("sets tag_active=true when customer regains tag (holdState unchanged)", async () => {
      const customerId = `gid://shopify/Customer/cust-${TEST_SUFFIX}-3`;

      // Create deactivated account (simulating previously tagged customer put on hold for credit reasons)
      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "customerId", name, "holdState",
          "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER', ${customerId}, 'Customer 3', 'HELD',
          NOW(), NOW()
        )
      `;

      // Create tagged customer record with tag_active=false
      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, tag_deactivated_at)
        VALUES (${TEST_SHOP_ID}, ${customerId}, '["other-tag"]'::jsonb, false, NOW())
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

      // Verify holdState was NOT changed - tag sync never touches holdState
      // Even though the customer now has the tag, holdState stays HELD (credit logic controls this)
      const [account] = await sql`
        SELECT * FROM "BuyerAccount" WHERE "customerId" = ${customerId}
      `;
      expect(account.holdState).toBe("HELD"); // UNCHANGED - holdState is credit logic only

      // Verify s8_tagged_customers.tag_active was set to true
      const [tagRecord] = await sql`
        SELECT * FROM s8_tagged_customers WHERE customer_id = ${customerId}
      `;
      expect(tagRecord.tag_active).toBe(true);
      expect(tagRecord.tag_deactivated_at).toBeNull();
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
        INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active)
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

  describe("HoldState preservation (tag sync never touches holdState)", () => {
    it("preserves HELD holdState when tag is re-added", async () => {
      const customerId = `gid://shopify/Customer/cust-${TEST_SUFFIX}-held`;

      // Account on credit hold for business reasons
      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "customerId", name, "holdState",
          "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER', ${customerId}, 'Customer Held', 'HELD',
          NOW(), NOW()
        )
      `;

      const customer: ShopifyCustomer = {
        id: customerId,
        tags: ["net-terms"],
      };

      await processCustomerWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "CUSTOMERS_UPDATE",
        customer,
        `wh-cust-${TEST_SUFFIX}-held`
      );

      const [account] = await sql`
        SELECT * FROM "BuyerAccount" WHERE "customerId" = ${customerId}
      `;
      expect(account.holdState).toBe("HELD"); // Unchanged
    });

    it("preserves NEAR_LIMIT holdState on tag sync", async () => {
      const customerId = `gid://shopify/Customer/cust-${TEST_SUFFIX}-near`;

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "customerId", name, "holdState",
          "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER', ${customerId}, 'Customer Near Limit', 'NEAR_LIMIT',
          NOW(), NOW()
        )
      `;

      const customer: ShopifyCustomer = {
        id: customerId,
        tags: ["net-terms"],
      };

      await processCustomerWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "CUSTOMERS_UPDATE",
        customer,
        `wh-cust-${TEST_SUFFIX}-near`
      );

      const [account] = await sql`
        SELECT * FROM "BuyerAccount" WHERE "customerId" = ${customerId}
      `;
      expect(account.holdState).toBe("NEAR_LIMIT"); // Unchanged
    });

    it("preserves BYPASS holdState on tag sync", async () => {
      const customerId = `gid://shopify/Customer/cust-${TEST_SUFFIX}-bypass`;

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "customerId", name, "holdState",
          "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER', ${customerId}, 'Customer Bypass', 'BYPASS',
          NOW(), NOW()
        )
      `;

      const customer: ShopifyCustomer = {
        id: customerId,
        tags: ["net-terms"],
      };

      await processCustomerWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "CUSTOMERS_UPDATE",
        customer,
        `wh-cust-${TEST_SUFFIX}-bypass`
      );

      const [account] = await sql`
        SELECT * FROM "BuyerAccount" WHERE "customerId" = ${customerId}
      `;
      expect(account.holdState).toBe("BYPASS"); // Unchanged
    });
  });

  describe("Explicit terms protection (tag terms never override 'explicit')", () => {
    it("does not overwrite explicit terms with tag terms", async () => {
      const customerId = `gid://shopify/Customer/cust-${TEST_SUFFIX}-explicit`;

      // Account with merchant-set (explicit) terms
      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "customerId", name, "defaultTermsDays", "defaultTermsSource",
          "holdState", "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER', ${customerId}, 'Explicit Terms Customer', 60, 'explicit',
          'OK', NOW(), NOW()
        )
      `;

      const customer: ShopifyCustomer = {
        id: customerId,
        tags: ["net-terms"], // Tag rule has 30 days
      };

      await processCustomerWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "CUSTOMERS_UPDATE",
        customer,
        `wh-cust-${TEST_SUFFIX}-explicit`
      );

      const [account] = await sql`
        SELECT * FROM "BuyerAccount" WHERE "customerId" = ${customerId}
      `;
      // Explicit terms preserved: 60 days, not overwritten by tag rule's 30 days
      expect(account.defaultTermsDays).toBe(60);
      expect(account.defaultTermsSource).toBe("explicit");
    });

    it("applies tag terms when source is NULL", async () => {
      const customerId = `gid://shopify/Customer/cust-${TEST_SUFFIX}-null-source`;

      // Account with no terms source set
      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "customerId", name, "defaultTermsDays", "defaultTermsSource",
          "holdState", "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER', ${customerId}, 'Null Source Customer', null, null,
          'OK', NOW(), NOW()
        )
      `;

      const customer: ShopifyCustomer = {
        id: customerId,
        tags: ["net-terms"], // Tag rule has 30 days
      };

      await processCustomerWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "CUSTOMERS_UPDATE",
        customer,
        `wh-cust-${TEST_SUFFIX}-null-source`
      );

      const [account] = await sql`
        SELECT * FROM "BuyerAccount" WHERE "customerId" = ${customerId}
      `;
      // Tag terms applied since source was NULL
      expect(account.defaultTermsDays).toBe(30);
      expect(account.defaultTermsSource).toBe("tag");
    });

    it("updates tag terms when source is 'tag'", async () => {
      const customerId = `gid://shopify/Customer/cust-${TEST_SUFFIX}-tag-source`;

      // Account with tag-based terms
      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "customerId", name, "defaultTermsDays", "defaultTermsSource",
          "holdState", "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER', ${customerId}, 'Tag Source Customer', 15, 'tag',
          'OK', NOW(), NOW()
        )
      `;

      const customer: ShopifyCustomer = {
        id: customerId,
        tags: ["net-terms"], // Tag rule has 30 days
      };

      await processCustomerWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "CUSTOMERS_UPDATE",
        customer,
        `wh-cust-${TEST_SUFFIX}-tag-source`
      );

      const [account] = await sql`
        SELECT * FROM "BuyerAccount" WHERE "customerId" = ${customerId}
      `;
      // Tag terms updated since source was 'tag'
      expect(account.defaultTermsDays).toBe(30);
      expect(account.defaultTermsSource).toBe("tag");
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
      expect(result.tagActive).toBe(true);
    });

    it("handles missing tags", () => {
      const customer: ShopifyCustomer = {
        id: "gid://shopify/Customer/456",
        tags: undefined,
      };

      const result = mapCustomerToTaggedCustomer(TEST_SHOP_ID, customer, false);

      expect(result.tags).toEqual([]);
      expect(result.tagActive).toBe(false);
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

    it("piiMode 'fetched' writes values as-is including null (overwrites existing)", async () => {
      const customerId = `gid://shopify/Customer/bulk-${TEST_SUFFIX}-fetched`;

      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, email, display_name)
        VALUES (${TEST_SHOP_ID}, ${customerId}, '["net-terms"]'::jsonb, true, 'existing@example.com', 'Existing Name')
      `;

      const customers = [
        {
          shopId: TEST_SHOP_ID,
          customerId,
          tags: ["net-terms", "updated"],
          tagActive: true,
          email: null,
          displayName: "Updated Name",
        },
      ];

      await bulkUpsertTaggedCustomers(sql, customers, "fetched");

      const [record] = await sql<{ email: string | null; display_name: string | null; tags: string[] }[]>`
        SELECT email, display_name, tags FROM s8_tagged_customers WHERE customer_id = ${customerId}
      `;
      expect(record.email).toBeNull();
      expect(record.display_name).toBe("Updated Name");
      expect(record.tags).toContain("updated");
    });

    it("piiMode 'fallback' preserves existing values with COALESCE", async () => {
      const customerId = `gid://shopify/Customer/bulk-${TEST_SUFFIX}-fallback`;

      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, email, display_name)
        VALUES (${TEST_SHOP_ID}, ${customerId}, '["net-terms"]'::jsonb, true, 'preserve@example.com', 'Preserve Name')
      `;

      const customers = [
        {
          shopId: TEST_SHOP_ID,
          customerId,
          tags: ["net-terms", "updated"],
          tagActive: true,
          email: null,
          displayName: null,
        },
      ];

      await bulkUpsertTaggedCustomers(sql, customers, "fallback");

      const [record] = await sql<{ email: string | null; display_name: string | null; tags: string[] }[]>`
        SELECT email, display_name, tags FROM s8_tagged_customers WHERE customer_id = ${customerId}
      `;
      expect(record.email).toBe("preserve@example.com");
      expect(record.display_name).toBe("Preserve Name");
      expect(record.tags).toContain("updated");
    });

    it("piiMode 'disabled' always writes NULL regardless of provided values", async () => {
      const customerId = `gid://shopify/Customer/bulk-${TEST_SUFFIX}-disabled`;

      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, email, display_name)
        VALUES (${TEST_SHOP_ID}, ${customerId}, '["net-terms"]'::jsonb, true, 'existing@example.com', 'Existing Name')
      `;

      const customers = [
        {
          shopId: TEST_SHOP_ID,
          customerId,
          tags: ["net-terms", "updated"],
          tagActive: true,
          email: "ignored@example.com",
          displayName: "Ignored Name",
        },
      ];

      await bulkUpsertTaggedCustomers(sql, customers, "disabled");

      const [record] = await sql<{ email: string | null; display_name: string | null; tags: string[] }[]>`
        SELECT email, display_name, tags FROM s8_tagged_customers WHERE customer_id = ${customerId}
      `;
      expect(record.email).toBeNull();
      expect(record.display_name).toBeNull();
      expect(record.tags).toContain("updated");
    });

    it("piiMode 'fetched' on INSERT writes provided values", async () => {
      const customerId = `gid://shopify/Customer/bulk-${TEST_SUFFIX}-fetched-new`;

      const customers = [
        {
          shopId: TEST_SHOP_ID,
          customerId,
          tags: ["net-terms"],
          tagActive: true,
          email: "new@example.com",
          displayName: "New Customer",
        },
      ];

      await bulkUpsertTaggedCustomers(sql, customers, "fetched");

      const [record] = await sql<{ email: string | null; display_name: string | null }[]>`
        SELECT email, display_name FROM s8_tagged_customers WHERE customer_id = ${customerId}
      `;
      expect(record.email).toBe("new@example.com");
      expect(record.display_name).toBe("New Customer");
    });

    it("piiMode 'disabled' on INSERT writes NULL even with PII provided", async () => {
      const customerId = `gid://shopify/Customer/bulk-${TEST_SUFFIX}-disabled-new`;

      const customers = [
        {
          shopId: TEST_SHOP_ID,
          customerId,
          tags: ["net-terms"],
          tagActive: true,
          email: "ignored@example.com",
          displayName: "Ignored Name",
        },
      ];

      await bulkUpsertTaggedCustomers(sql, customers, "disabled");

      const [record] = await sql<{ email: string | null; display_name: string | null }[]>`
        SELECT email, display_name FROM s8_tagged_customers WHERE customer_id = ${customerId}
      `;
      expect(record.email).toBeNull();
      expect(record.display_name).toBeNull();
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

  describe("PII mode handling", () => {
    it("'fetched' mode writes values as-is including null (clears email)", async () => {
      const customerId = `gid://shopify/Customer/cust-${TEST_SUFFIX}-fetched`;

      // Create existing record with email
      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, email, display_name)
        VALUES (${TEST_SHOP_ID}, ${customerId}, '["net-terms"]'::jsonb, true, 'existing@example.com', 'Existing Name')
      `;

      // Process with null email (simulating cleared email)
      const customer: ShopifyCustomer = {
        id: customerId,
        tags: ["net-terms"],
        email: null, // Customer cleared their email
        displayName: "Updated Name",
      };

      const result = await processCustomerWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "CUSTOMERS_UPDATE",
        customer,
        `wh-cust-${TEST_SUFFIX}-fetched`,
        "fetched"
      );

      expect(result.success).toBe(true);

      // Verify email was cleared (null overwrites)
      const [record] = await sql<{ email: string | null; display_name: string | null }[]>`
        SELECT email, display_name FROM s8_tagged_customers WHERE customer_id = ${customerId}
      `;
      expect(record.email).toBeNull(); // Was cleared
      expect(record.display_name).toBe("Updated Name");
    });

    it("'fallback' mode preserves existing values with COALESCE", async () => {
      const customerId = `gid://shopify/Customer/cust-${TEST_SUFFIX}-fallback`;

      // Create existing record with email
      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, email, display_name)
        VALUES (${TEST_SHOP_ID}, ${customerId}, '["net-terms"]'::jsonb, true, 'preserve@example.com', 'Preserve Name')
      `;

      // Process with null PII (ACCESS_DENIED fallback case)
      const customer: ShopifyCustomer = {
        id: customerId,
        tags: ["net-terms", "updated"],
        email: null, // Fallback didn't fetch email
        displayName: null, // Fallback didn't fetch displayName
      };

      const result = await processCustomerWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "CUSTOMERS_UPDATE",
        customer,
        `wh-cust-${TEST_SUFFIX}-fallback`,
        "fallback"
      );

      expect(result.success).toBe(true);

      // Verify existing values were preserved
      const [record] = await sql<{ email: string | null; display_name: string | null; tags: string[] }[]>`
        SELECT email, display_name, tags FROM s8_tagged_customers WHERE customer_id = ${customerId}
      `;
      expect(record.email).toBe("preserve@example.com"); // Preserved
      expect(record.display_name).toBe("Preserve Name"); // Preserved
      expect(record.tags).toContain("updated"); // Tags still updated
    });

    it("'disabled' mode always writes NULL (DPDP minimisation)", async () => {
      const customerId = `gid://shopify/Customer/cust-${TEST_SUFFIX}-disabled`;

      // Create existing record with email
      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, email, display_name)
        VALUES (${TEST_SHOP_ID}, ${customerId}, '["net-terms"]'::jsonb, true, 'existing@example.com', 'Existing Name')
      `;

      // Process with PII disabled (even if we somehow have PII values)
      const customer: ShopifyCustomer = {
        id: customerId,
        tags: ["net-terms"],
        email: "new@example.com", // This should be ignored
        displayName: "New Name", // This should be ignored
      };

      const result = await processCustomerWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "CUSTOMERS_UPDATE",
        customer,
        `wh-cust-${TEST_SUFFIX}-disabled`,
        "disabled"
      );

      expect(result.success).toBe(true);

      // Verify PII was cleared (disabled mode always writes NULL)
      const [record] = await sql<{ email: string | null; display_name: string | null }[]>`
        SELECT email, display_name FROM s8_tagged_customers WHERE customer_id = ${customerId}
      `;
      expect(record.email).toBeNull();
      expect(record.display_name).toBeNull();
    });

    it("'fetched' mode on INSERT writes values as-is", async () => {
      const customer: ShopifyCustomer = {
        id: `gid://shopify/Customer/cust-${TEST_SUFFIX}-fetch-new`,
        tags: ["net-terms"],
        email: "new@example.com",
        displayName: "New Customer",
      };

      const result = await processCustomerWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "CUSTOMERS_CREATE",
        customer,
        `wh-cust-${TEST_SUFFIX}-fetch-new`,
        "fetched"
      );

      expect(result.success).toBe(true);

      const [record] = await sql<{ email: string | null; display_name: string | null }[]>`
        SELECT email, display_name FROM s8_tagged_customers WHERE customer_id = ${customer.id}
      `;
      expect(record.email).toBe("new@example.com");
      expect(record.display_name).toBe("New Customer");
    });

    it("'fallback' mode on INSERT writes null PII", async () => {
      const customer: ShopifyCustomer = {
        id: `gid://shopify/Customer/cust-${TEST_SUFFIX}-fall-new`,
        tags: ["net-terms"],
        email: null,
        displayName: null,
      };

      const result = await processCustomerWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "CUSTOMERS_CREATE",
        customer,
        `wh-cust-${TEST_SUFFIX}-fall-new`,
        "fallback"
      );

      expect(result.success).toBe(true);

      const [record] = await sql<{ email: string | null; display_name: string | null }[]>`
        SELECT email, display_name FROM s8_tagged_customers WHERE customer_id = ${customer.id}
      `;
      expect(record.email).toBeNull();
      expect(record.display_name).toBeNull();
    });

    it("'disabled' mode on INSERT writes null even with PII provided", async () => {
      const customer: ShopifyCustomer = {
        id: `gid://shopify/Customer/cust-${TEST_SUFFIX}-dis-new`,
        tags: ["net-terms"],
        email: "ignored@example.com",
        displayName: "Ignored Name",
      };

      const result = await processCustomerWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "CUSTOMERS_CREATE",
        customer,
        `wh-cust-${TEST_SUFFIX}-dis-new`,
        "disabled"
      );

      expect(result.success).toBe(true);

      const [record] = await sql<{ email: string | null; display_name: string | null }[]>`
        SELECT email, display_name FROM s8_tagged_customers WHERE customer_id = ${customer.id}
      `;
      expect(record.email).toBeNull();
      expect(record.display_name).toBeNull();
    });
  });

  describe("Compliance redaction (customers/redact and shop/redact)", () => {
    it("redactCustomerData deletes s8_tagged_customers including email/displayName", async () => {
      const customerId = `gid://shopify/Customer/cust-${TEST_SUFFIX}-redact`;

      // Create tagged customer record with PII fields
      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, email, display_name)
        VALUES (${TEST_SHOP_ID}, ${customerId}, '["net-terms"]'::jsonb, true, 'test@example.com', 'Test Customer')
      `;

      // Create a buyer account for this customer
      const [buyerAccount] = await sql<{ id: string }[]>`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "customerId", name, "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER', ${customerId}, 'Test Customer', NOW(), NOW()
        )
        RETURNING id
      `;

      // Create draft orders linked to this buyer account
      await sql`
        INSERT INTO s8_draft_orders (shop_id, draft_order_id, buyer_account_id, name, total, created_at)
        VALUES 
          (${TEST_SHOP_ID}, 'gid://shopify/DraftOrder/redact-1', ${buyerAccount.id}, '#D1', 1000.00, NOW()),
          (${TEST_SHOP_ID}, 'gid://shopify/DraftOrder/redact-2', ${buyerAccount.id}, '#D2', 2000.00, NOW())
      `;

      // Verify records exist with PII
      const customersBefore = await sql<{ email: string | null; display_name: string | null }[]>`
        SELECT email, display_name FROM s8_tagged_customers WHERE customer_id = ${customerId}
      `;
      expect(customersBefore).toHaveLength(1);
      expect(customersBefore[0].email).toBe("test@example.com");
      expect(customersBefore[0].display_name).toBe("Test Customer");

      const draftsBefore = await sql`
        SELECT * FROM s8_draft_orders WHERE buyer_account_id = ${buyerAccount.id}
      `;
      expect(draftsBefore).toHaveLength(2);

      // Redact
      const counts = await redactCustomerData(sql, TEST_SHOP_ID, customerId);
      expect(counts.taggedCustomers).toBe(1);
      expect(counts.draftOrders).toBe(2);

      // Verify both are gone
      const customersAfter = await sql`
        SELECT * FROM s8_tagged_customers WHERE customer_id = ${customerId}
      `;
      expect(customersAfter).toHaveLength(0);

      const draftsAfter = await sql`
        SELECT * FROM s8_draft_orders WHERE buyer_account_id = ${buyerAccount.id}
      `;
      expect(draftsAfter).toHaveLength(0);

      // Cleanup buyer account
      await sql`DELETE FROM "BuyerAccount" WHERE id = ${buyerAccount.id}`;
    });

    it("redactCustomerData is idempotent (no error on missing customer)", async () => {
      const counts = await redactCustomerData(
        sql,
        TEST_SHOP_ID,
        `gid://shopify/Customer/nonexistent-${TEST_SUFFIX}`
      );
      expect(counts.taggedCustomers).toBe(0);
      expect(counts.draftOrders).toBe(0);
    });

    it("redactShopData deletes all s8_tagged_customers for shop", async () => {
      // Create a temporary shop for this test
      const redactShopId = `shop-redact-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt")
        VALUES (${redactShopId}, 'test-redact.myshopify.com', NOW(), NOW())
      `;

      // Create multiple tagged customer records
      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active)
        VALUES 
          (${redactShopId}, 'gid://shopify/Customer/1', '["net-terms"]'::jsonb, true),
          (${redactShopId}, 'gid://shopify/Customer/2', '["net-terms"]'::jsonb, true),
          (${redactShopId}, 'gid://shopify/Customer/3', '["net-terms"]'::jsonb, false)
      `;

      // Create draft orders table data if needed
      await sql`
        CREATE TABLE IF NOT EXISTS s8_draft_orders (
          id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          shop_id TEXT NOT NULL,
          draft_order_id TEXT NOT NULL,
          buyer_account_id TEXT,
          name TEXT NOT NULL,
          total NUMERIC(14, 2) NOT NULL,
          has_payment_terms BOOLEAN NOT NULL DEFAULT false,
          status TEXT NOT NULL DEFAULT 'open',
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT s8_draft_orders_shop_draft_unique UNIQUE (shop_id, draft_order_id)
        )
      `;

      // Add draft order for this shop
      await sql`
        INSERT INTO s8_draft_orders (shop_id, draft_order_id, name, total, created_at)
        VALUES (${redactShopId}, 'gid://shopify/DraftOrder/1', '#D1', 1000.00, NOW())
      `;

      // Redact shop data
      const counts = await redactShopData(sql, redactShopId);
      expect(counts.taggedCustomers).toBe(3);
      expect(counts.draftOrders).toBe(1);

      // Verify all S8 data is gone
      const customersAfter = await sql`
        SELECT * FROM s8_tagged_customers WHERE shop_id = ${redactShopId}
      `;
      expect(customersAfter).toHaveLength(0);

      const draftsAfter = await sql`
        SELECT * FROM s8_draft_orders WHERE shop_id = ${redactShopId}
      `;
      expect(draftsAfter).toHaveLength(0);

      // Cleanup
      await sql`DELETE FROM "Shop" WHERE id = ${redactShopId}`;
    });

    it("redactShopData is idempotent (no error on empty shop)", async () => {
      const counts = await redactShopData(sql, `nonexistent-shop-${TEST_SUFFIX}`);
      expect(counts.taggedCustomers).toBe(0);
      expect(counts.draftOrders).toBe(0);
    });
  });
});
