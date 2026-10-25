import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import {
  processCompanyLocationWebhook,
  mapCompanyLocationToBuyerAccount,
  bulkUpsertBuyerAccounts,
} from "../company-location.server";
import type { ShopifyCompanyLocation } from "../types";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("CompanyLocation Sync", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36);
  const TEST_SHOP_ID = `shop-loc-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `loc-test-${TEST_SUFFIX}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop
    await sql`
      INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, NOW(), NOW())
    `;

    // Create dedupe table if not exists (may not exist in clean CI DB)
    await sql`
      CREATE TABLE IF NOT EXISTS s6_processed_webhooks (
        webhook_id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        resource_gid TEXT NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${"wh-loc-" + TEST_SUFFIX + "%"}`;
    await sql.end();
  });

  beforeEach(async () => {
    // Clean up buyer accounts for this shop
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${"wh-loc-" + TEST_SUFFIX + "%"}`;
  });

  describe("processCompanyLocationWebhook", () => {
    it("creates BuyerAccount on COMPANY_LOCATIONS_CREATE", async () => {
      const location: ShopifyCompanyLocation = {
        id: `gid://shopify/CompanyLocation/loc-${TEST_SUFFIX}-1`,
        name: "Acme HQ",
        company: { id: `gid://shopify/Company/co-${TEST_SUFFIX}-1` },
        buyerExperienceConfiguration: {
          paymentTermsTemplate: {
            id: "pt1",
            name: "Net 30",
            dueInDays: 30,
            paymentTermsType: "NET",
          },
        },
      };

      const result = await processCompanyLocationWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "COMPANY_LOCATIONS_CREATE",
        location,
        `wh-loc-${TEST_SUFFIX}-1`
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("created");
      expect(result.entityId).toBeDefined();

      // Verify buyer account was created
      const [account] = await sql`
        SELECT * FROM "BuyerAccount" WHERE id = ${result.entityId!}
      `;
      expect(account.kind).toBe("COMPANY");
      expect(account.companyLocationId).toBe(location.id);
      expect(account.companyId).toBe(location.company.id);
      expect(account.name).toBe("Acme HQ");
      expect(account.defaultTermsDays).toBe(30);
    });

    it("updates BuyerAccount on COMPANY_LOCATIONS_UPDATE", async () => {
      const locationId = `gid://shopify/CompanyLocation/loc-${TEST_SUFFIX}-2`;
      const companyId = `gid://shopify/Company/co-${TEST_SUFFIX}-2`;

      // Create initial account
      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name, "defaultTermsDays",
          "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'COMPANY', ${companyId}, ${locationId}, 'Old Name', 15,
          NOW(), NOW()
        )
      `;

      const location: ShopifyCompanyLocation = {
        id: locationId,
        name: "New Name",
        company: { id: companyId },
        buyerExperienceConfiguration: {
          paymentTermsTemplate: {
            id: "pt2",
            name: "Net 45",
            dueInDays: 45,
            paymentTermsType: "NET",
          },
        },
      };

      const result = await processCompanyLocationWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "COMPANY_LOCATIONS_UPDATE",
        location,
        `wh-loc-${TEST_SUFFIX}-2`
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("updated");

      // Verify account was updated
      const [account] = await sql`
        SELECT * FROM "BuyerAccount" WHERE "companyLocationId" = ${locationId}
      `;
      expect(account.name).toBe("New Name");
      expect(account.defaultTermsDays).toBe(45);
    });

    it("skips DELETE and preserves account for financial history", async () => {
      const locationId = `gid://shopify/CompanyLocation/loc-${TEST_SUFFIX}-3`;
      const companyId = `gid://shopify/Company/co-${TEST_SUFFIX}-3`;

      // Create account
      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'COMPANY', ${companyId}, ${locationId}, 'To Delete',
          NOW(), NOW()
        )
      `;

      const location: ShopifyCompanyLocation = {
        id: locationId,
        name: "To Delete",
        company: { id: companyId },
      };

      const result = await processCompanyLocationWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "COMPANY_LOCATIONS_DELETE",
        location,
        `wh-loc-${TEST_SUFFIX}-3`
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("preserved for financial history");

      // Verify account still exists
      const [account] = await sql`
        SELECT * FROM "BuyerAccount" WHERE "companyLocationId" = ${locationId}
      `;
      expect(account).toBeDefined();
    });

    it("is idempotent - skips duplicate webhooks", async () => {
      const location: ShopifyCompanyLocation = {
        id: `gid://shopify/CompanyLocation/loc-${TEST_SUFFIX}-4`,
        name: "Idempotent Test",
        company: { id: `gid://shopify/Company/co-${TEST_SUFFIX}-4` },
      };

      const webhookId = `wh-loc-${TEST_SUFFIX}-4`;

      // First call
      const result1 = await processCompanyLocationWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "COMPANY_LOCATIONS_CREATE",
        location,
        webhookId
      );
      expect(result1.action).toBe("created");

      // Second call with same webhook ID
      const result2 = await processCompanyLocationWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "COMPANY_LOCATIONS_CREATE",
        location,
        webhookId
      );
      expect(result2.action).toBe("skipped");
      expect(result2.skipReason).toContain("idempotent");

      // Only one account should exist
      const accounts = await sql`
        SELECT * FROM "BuyerAccount" WHERE "companyLocationId" = ${location.id}
      `;
      expect(accounts).toHaveLength(1);
    });

    it("fails gracefully for unknown shop", async () => {
      const location: ShopifyCompanyLocation = {
        id: `gid://shopify/CompanyLocation/loc-${TEST_SUFFIX}-5`,
        name: "Unknown Shop",
        company: { id: `gid://shopify/Company/co-${TEST_SUFFIX}-5` },
      };

      const result = await processCompanyLocationWebhook(
        sql,
        "test-unknown-shop.myshopify.com",
        "COMPANY_LOCATIONS_CREATE",
        location,
        `wh-loc-${TEST_SUFFIX}-5`
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("shop_not_found");
      expect(result.errorCode).toBe("shop_not_found");
    });
  });

  describe("mapCompanyLocationToBuyerAccount", () => {
    it("maps location with payment terms", () => {
      const location: ShopifyCompanyLocation = {
        id: "gid://shopify/CompanyLocation/123",
        name: "Branch Office",
        company: { id: "gid://shopify/Company/456" },
        buyerExperienceConfiguration: {
          paymentTermsTemplate: {
            id: "pt1",
            name: "Net 60",
            dueInDays: 60,
            paymentTermsType: "NET",
          },
        },
      };

      const result = mapCompanyLocationToBuyerAccount("shop-id", location);

      expect(result.shopId).toBe("shop-id");
      expect(result.kind).toBe("COMPANY");
      expect(result.companyId).toBe("gid://shopify/Company/456");
      expect(result.companyLocationId).toBe("gid://shopify/CompanyLocation/123");
      expect(result.name).toBe("Branch Office");
      expect(result.defaultTermsDays).toBe(60);
      expect(result.defaultTermsSource).toBe("explicit");
    });

    it("maps location without payment terms", () => {
      const location: ShopifyCompanyLocation = {
        id: "gid://shopify/CompanyLocation/789",
        name: "No Terms",
        company: { id: "gid://shopify/Company/456" },
      };

      const result = mapCompanyLocationToBuyerAccount("shop-id", location);

      expect(result.defaultTermsDays).toBeNull();
      expect(result.defaultTermsSource).toBeNull();
    });

    it("uses billing address company name as fallback", () => {
      // Note: CompanyAddress.company was renamed to companyName in 2026-10
      const location: ShopifyCompanyLocation = {
        id: "gid://shopify/CompanyLocation/101",
        name: "",
        company: { id: "gid://shopify/Company/456" },
        billingAddress: {
          companyName: "Billing Corp",
        },
      };

      const result = mapCompanyLocationToBuyerAccount("shop-id", location);

      expect(result.name).toBe("Billing Corp");
    });

    it("uses location ID as last resort name", () => {
      const location: ShopifyCompanyLocation = {
        id: "gid://shopify/CompanyLocation/999",
        name: "",
        company: { id: "gid://shopify/Company/456" },
      };

      const result = mapCompanyLocationToBuyerAccount("shop-id", location);

      expect(result.name).toBe("Location 999");
    });
  });

  describe("bulkUpsertBuyerAccounts", () => {
    it("inserts multiple accounts in batch", async () => {
      const accounts = [
        mapCompanyLocationToBuyerAccount(TEST_SHOP_ID, {
          id: `gid://shopify/CompanyLocation/bulk-${TEST_SUFFIX}-1`,
          name: "Bulk 1",
          company: { id: `gid://shopify/Company/bulk-co-${TEST_SUFFIX}` },
        }),
        mapCompanyLocationToBuyerAccount(TEST_SHOP_ID, {
          id: `gid://shopify/CompanyLocation/bulk-${TEST_SUFFIX}-2`,
          name: "Bulk 2",
          company: { id: `gid://shopify/Company/bulk-co-${TEST_SUFFIX}` },
        }),
      ];

      const count = await bulkUpsertBuyerAccounts(sql, accounts);

      expect(count).toBe(2);

      const inserted = await sql`
        SELECT * FROM "BuyerAccount"
        WHERE "companyLocationId" IN ${sql([accounts[0].companyLocationId, accounts[1].companyLocationId])}
      `;
      expect(inserted).toHaveLength(2);
    });

    it("handles empty array", async () => {
      const count = await bulkUpsertBuyerAccounts(sql, []);
      expect(count).toBe(0);
    });

    it("upserts on conflict", async () => {
      const locationId = `gid://shopify/CompanyLocation/upsert-${TEST_SUFFIX}`;
      const companyId = `gid://shopify/Company/upsert-co-${TEST_SUFFIX}`;

      // Insert initial
      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'COMPANY', ${companyId}, ${locationId}, 'Original',
          NOW(), NOW()
        )
      `;

      const accounts = [
        mapCompanyLocationToBuyerAccount(TEST_SHOP_ID, {
          id: locationId,
          name: "Updated via Bulk",
          company: { id: companyId },
        }),
      ];

      await bulkUpsertBuyerAccounts(sql, accounts);

      const [updated] = await sql`
        SELECT * FROM "BuyerAccount" WHERE "companyLocationId" = ${locationId}
      `;
      expect(updated.name).toBe("Updated via Bulk");
    });

    it("gates new accounts when over limit with PLAN_GATING_ENFORCED=1", async () => {
      const originalEnv = process.env.PLAN_GATING_ENFORCED;
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      
      try {
        // T1: 'free' resolves to 'none' plan which has limit 0
        // Any new account is immediately over the limit
        await sql`
          UPDATE "Shop" 
          SET plan_key = 'free', plan_cached_at = NOW()
          WHERE id = ${TEST_SHOP_ID}
        `;

        // Insert a new account - should be gated since none plan has limit 0
        const newLocationId = `gid://shopify/CompanyLocation/${Date.now()}`;
        const newCompanyId = `gid://shopify/Company/${Date.now()}`;
        const accounts = [
          mapCompanyLocationToBuyerAccount(TEST_SHOP_ID, {
            id: newLocationId,
            name: "Over Limit Account",
            company: { id: newCompanyId },
          }),
        ];

        await bulkUpsertBuyerAccounts(sql, accounts);

        const [newAccount] = await sql`
          SELECT * FROM "BuyerAccount" WHERE "companyLocationId" = ${newLocationId}
        `;
        expect(newAccount).toBeDefined();
        expect(newAccount.name).toBe("Over Limit Account");
        expect(newAccount.gated_at).not.toBeNull(); // Should be gated
      } finally {
        if (originalEnv !== undefined) {
          (process.env as Record<string, string>).PLAN_GATING_ENFORCED = originalEnv;
        } else {
          delete (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED;
        }
      }
    });

    it("does not gate new accounts when PLAN_GATING_ENFORCED=false", async () => {
      const originalEnv = process.env.PLAN_GATING_ENFORCED;
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "false";
      
      try {
        // T1: 'free' resolves to 'none' plan which has limit 0
        // But gating is OFF, so accounts should NOT be gated
        await sql`
          UPDATE "Shop" 
          SET plan_key = 'free', plan_cached_at = NOW()
          WHERE id = ${TEST_SHOP_ID}
        `;

        // Insert a new account - should NOT be gated when flag is off
        const newLocationId = `gid://shopify/CompanyLocation/nogate-${Date.now()}`;
        const newCompanyId = `gid://shopify/Company/nogate-${Date.now()}`;
        const accounts = [
          mapCompanyLocationToBuyerAccount(TEST_SHOP_ID, {
            id: newLocationId,
            name: "Not Gated Account",
            company: { id: newCompanyId },
          }),
        ];

        await bulkUpsertBuyerAccounts(sql, accounts);

        const [newAccount] = await sql`
          SELECT * FROM "BuyerAccount" WHERE "companyLocationId" = ${newLocationId}
        `;
        expect(newAccount).toBeDefined();
        expect(newAccount.name).toBe("Not Gated Account");
        expect(newAccount.gated_at).toBeNull(); // Should NOT be gated
      } finally {
        if (originalEnv !== undefined) {
          (process.env as Record<string, string>).PLAN_GATING_ENFORCED = originalEnv;
        } else {
          delete (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED;
        }
      }
    });
  });

  describe("B2B main contact PII handling", () => {
    it("stores mainContact fields when CUSTOMER_PII_FIELDS=1", async () => {
      // mainContact is on Company, not Location (B2B recipient is the company's main contact)
      const location: ShopifyCompanyLocation = {
        id: `gid://shopify/CompanyLocation/pii-on-${TEST_SUFFIX}`,
        name: "PII On Company",
        company: {
          id: `gid://shopify/Company/pii-on-co-${TEST_SUFFIX}`,
          mainContact: {
            customer: {
              id: `gid://shopify/Customer/contact-${TEST_SUFFIX}`,
              email: "contact@example.com",
              displayName: "Contact Person",
            },
          },
        },
      };

      const result = await processCompanyLocationWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "COMPANY_LOCATIONS_CREATE",
        location,
        `wh-pii-on-${TEST_SUFFIX}`,
        { CUSTOMER_PII_FIELDS: "1" }
      );

      expect(result.success).toBe(true);

      const [account] = await sql`
        SELECT "mainContactEmail", "mainContactName", "mainContactCustomerId"
        FROM "BuyerAccount" WHERE "companyLocationId" = ${location.id}
      `;
      expect(account.mainContactEmail).toBe("contact@example.com");
      expect(account.mainContactName).toBe("Contact Person");
      expect(account.mainContactCustomerId).toBe(`gid://shopify/Customer/contact-${TEST_SUFFIX}`);
    });

    it("nulls mainContact fields when CUSTOMER_PII_FIELDS is off", async () => {
      // mainContact is on Company, not Location (B2B recipient is the company's main contact)
      const location: ShopifyCompanyLocation = {
        id: `gid://shopify/CompanyLocation/pii-off-${TEST_SUFFIX}`,
        name: "PII Off Company",
        company: {
          id: `gid://shopify/Company/pii-off-co-${TEST_SUFFIX}`,
          mainContact: {
            customer: {
              id: `gid://shopify/Customer/contact-piioff-${TEST_SUFFIX}`,
              email: "should-not-store@example.com",
              displayName: "Should Not Store",
            },
          },
        },
      };

      const result = await processCompanyLocationWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "COMPANY_LOCATIONS_CREATE",
        location,
        `wh-pii-off-${TEST_SUFFIX}`,
        {}
      );

      expect(result.success).toBe(true);

      const [account] = await sql`
        SELECT "mainContactEmail", "mainContactName", "mainContactCustomerId"
        FROM "BuyerAccount" WHERE "companyLocationId" = ${location.id}
      `;
      expect(account.mainContactEmail).toBeNull();
      expect(account.mainContactName).toBeNull();
      expect(account.mainContactCustomerId).toBeNull();
    });

    it("nulls existing mainContact fields when CUSTOMER_PII_FIELDS turns off", async () => {
      const locationId = `gid://shopify/CompanyLocation/pii-turnoff-${TEST_SUFFIX}`;
      const companyId = `gid://shopify/Company/pii-turnoff-co-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "mainContactEmail", "mainContactName", "mainContactCustomerId",
          "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'COMPANY', ${companyId}, ${locationId}, 'Turn Off PII',
          'was-stored@example.com', 'Was Stored', 'gid://shopify/Customer/was-stored',
          NOW(), NOW()
        )
      `;

      // mainContact is on Company, not Location (B2B recipient is the company's main contact)
      const location: ShopifyCompanyLocation = {
        id: locationId,
        name: "Turn Off PII",
        company: {
          id: companyId,
          mainContact: {
            customer: {
              id: "gid://shopify/Customer/new-contact",
              email: "new-contact@example.com",
              displayName: "New Contact",
            },
          },
        },
      };

      await processCompanyLocationWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "COMPANY_LOCATIONS_UPDATE",
        location,
        `wh-pii-turnoff-${TEST_SUFFIX}`,
        {}
      );

      const [account] = await sql`
        SELECT "mainContactEmail", "mainContactName", "mainContactCustomerId"
        FROM "BuyerAccount" WHERE "companyLocationId" = ${locationId}
      `;
      expect(account.mainContactEmail).toBeNull();
      expect(account.mainContactName).toBeNull();
      expect(account.mainContactCustomerId).toBeNull();
    });

    it("overwrites mainContact fields when contact changes", async () => {
      const locationId = `gid://shopify/CompanyLocation/contact-change-${TEST_SUFFIX}`;
      const companyId = `gid://shopify/Company/contact-change-co-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "mainContactEmail", "mainContactName", "mainContactCustomerId",
          "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'COMPANY', ${companyId}, ${locationId}, 'Contact Change',
          'old-contact@example.com', 'Old Contact', 'gid://shopify/Customer/old',
          NOW(), NOW()
        )
      `;

      // mainContact is on Company, not Location (B2B recipient is the company's main contact)
      const location: ShopifyCompanyLocation = {
        id: locationId,
        name: "Contact Change",
        company: {
          id: companyId,
          mainContact: {
            customer: {
              id: "gid://shopify/Customer/new",
              email: "new-contact@example.com",
              displayName: "New Contact",
            },
          },
        },
      };

      await processCompanyLocationWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "COMPANY_LOCATIONS_UPDATE",
        location,
        `wh-contact-change-${TEST_SUFFIX}`,
        { CUSTOMER_PII_FIELDS: "1" }
      );

      const [account] = await sql`
        SELECT "mainContactEmail", "mainContactName", "mainContactCustomerId"
        FROM "BuyerAccount" WHERE "companyLocationId" = ${locationId}
      `;
      expect(account.mainContactEmail).toBe("new-contact@example.com");
      expect(account.mainContactName).toBe("New Contact");
      expect(account.mainContactCustomerId).toBe("gid://shopify/Customer/new");
    });

    it("nulls mainContact fields when contact is removed", async () => {
      const locationId = `gid://shopify/CompanyLocation/contact-remove-${TEST_SUFFIX}`;
      const companyId = `gid://shopify/Company/contact-remove-co-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "mainContactEmail", "mainContactName", "mainContactCustomerId",
          "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'COMPANY', ${companyId}, ${locationId}, 'Contact Remove',
          'had-contact@example.com', 'Had Contact', 'gid://shopify/Customer/had',
          NOW(), NOW()
        )
      `;

      const location: ShopifyCompanyLocation = {
        id: locationId,
        name: "Contact Remove",
        company: { id: companyId },
      };

      await processCompanyLocationWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "COMPANY_LOCATIONS_UPDATE",
        location,
        `wh-contact-remove-${TEST_SUFFIX}`,
        { CUSTOMER_PII_FIELDS: "1" }
      );

      const [account] = await sql`
        SELECT "mainContactEmail", "mainContactName", "mainContactCustomerId"
        FROM "BuyerAccount" WHERE "companyLocationId" = ${locationId}
      `;
      expect(account.mainContactEmail).toBeNull();
      expect(account.mainContactName).toBeNull();
      expect(account.mainContactCustomerId).toBeNull();
    });
  });

  describe("shop/redact deletes BuyerAccount", () => {
    it("removes BuyerAccount row entirely on shop deletion", async () => {
      const { deleteShop } = await import("../../compliance/compliance.server");

      const redactShopId = `shop-redact-${TEST_SUFFIX}`;
      const redactDomain = `redact-test-${TEST_SUFFIX}.myshopify.com`;
      const locationId = `gid://shopify/CompanyLocation/redact-${TEST_SUFFIX}`;

      // Cleanup any leftover data from previous failed runs (belt and suspenders)
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${redactShopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${redactShopId}`;

      // Per #303: deleteShop skips erase when uninstalledAt IS NULL (shop reinstalled).
      // Set uninstalledAt to simulate a genuinely uninstalled shop awaiting redact.
      const uninstalledAt = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48h ago
      await sql`
        INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt", "uninstalledAt")
        VALUES (${redactShopId}, ${redactDomain}, NOW(), NOW(), ${uninstalledAt})
      `;

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "mainContactEmail", "mainContactName", "mainContactCustomerId",
          "createdAt", "updatedAt"
        ) VALUES (
          ${redactShopId}, 'COMPANY', 'gid://shopify/Company/redact-co',
          ${locationId}, 'To Be Deleted',
          'deleted@example.com', 'Deleted Contact', 'gid://shopify/Customer/deleted',
          NOW(), NOW()
        )
      `;

      const [before] = await sql<{ id: string }[]>`
        SELECT id FROM "BuyerAccount" WHERE "companyLocationId" = ${locationId}
      `;
      expect(before).toBeDefined();

      const result = await deleteShop(sql, redactDomain);
      expect(result.deleted).toBe(true);
      expect(result.skippedReinstalled).toBe(false);

      // BuyerAccount row should be gone (cascade delete)
      const after = await sql`
        SELECT id FROM "BuyerAccount" WHERE "companyLocationId" = ${locationId}
      `;
      expect(after).toHaveLength(0);
    });
  });
});
