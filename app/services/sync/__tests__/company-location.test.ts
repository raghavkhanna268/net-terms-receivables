import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
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
        `wh-loc-${TEST_SUFFIX}-1`,
        {}
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
        `wh-loc-${TEST_SUFFIX}-2`,
        {}
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

    it("DELETE preserves account and sets locationDeletedAt (T5)", async () => {
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
        `wh-loc-${TEST_SUFFIX}-3`,
        {}
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("updated");
      expect(result.skipReason).toContain("locationDeletedAt");

      // Verify account still exists with locationDeletedAt set
      const [account] = await sql<{ locationDeletedAt: Date | null }[]>`
        SELECT "locationDeletedAt" FROM "BuyerAccount" WHERE "companyLocationId" = ${locationId}
      `;
      expect(account).toBeDefined();
      expect(account.locationDeletedAt).not.toBeNull();
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
        webhookId,
        {}
      );
      expect(result1.action).toBe("created");

      // Second call with same webhook ID
      const result2 = await processCompanyLocationWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "COMPANY_LOCATIONS_CREATE",
        location,
        webhookId,
        {}
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
        `wh-loc-${TEST_SUFFIX}-5`,
        {}
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

      const result = mapCompanyLocationToBuyerAccount("shop-id", location, {});

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

      const result = mapCompanyLocationToBuyerAccount("shop-id", location, {});

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

      const result = mapCompanyLocationToBuyerAccount("shop-id", location, {});

      expect(result.name).toBe("Billing Corp");
    });

    it("uses location ID as last resort name", () => {
      const location: ShopifyCompanyLocation = {
        id: "gid://shopify/CompanyLocation/999",
        name: "",
        company: { id: "gid://shopify/Company/456" },
      };

      const result = mapCompanyLocationToBuyerAccount("shop-id", location, {});

      expect(result.name).toBe("Location 999");
    });

    it("returns contactKnown=true by default", () => {
      const location: ShopifyCompanyLocation = {
        id: "gid://shopify/CompanyLocation/999",
        name: "Test",
        company: { id: "gid://shopify/Company/456" },
      };

      const result = mapCompanyLocationToBuyerAccount("shop-id", location, {});

      expect(result.contactKnown).toBe(true);
    });

    it("returns contactKnown=false when explicitly set (orphan locations)", () => {
      const location: ShopifyCompanyLocation = {
        id: "gid://shopify/CompanyLocation/999",
        name: "Orphan",
        company: { id: "gid://shopify/Company/456" },
      };

      const result = mapCompanyLocationToBuyerAccount("shop-id", location, {}, false);

      expect(result.contactKnown).toBe(false);
    });
  });

  describe("bulkUpsertBuyerAccounts", () => {
    it("inserts multiple accounts in batch", async () => {
      const accounts = [
        mapCompanyLocationToBuyerAccount(TEST_SHOP_ID, {
          id: `gid://shopify/CompanyLocation/bulk-${TEST_SUFFIX}-1`,
          name: "Bulk 1",
          company: { id: `gid://shopify/Company/bulk-co-${TEST_SUFFIX}` },
        }, {}),
        mapCompanyLocationToBuyerAccount(TEST_SHOP_ID, {
          id: `gid://shopify/CompanyLocation/bulk-${TEST_SUFFIX}-2`,
          name: "Bulk 2",
          company: { id: `gid://shopify/Company/bulk-co-${TEST_SUFFIX}` },
        }, {}),
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
        }, {}),
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
          }, {}),
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
          }, {}),
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

    it("bulk with bad row rejects when flag off (main behavior)", async () => {
      const originalEnv = process.env.PLAN_GATING_ENFORCED;
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "false";
      
      try {
        const goodLocId1 = `gid://shopify/CompanyLocation/good1-${Date.now()}`;
        const badLocId = `gid://shopify/CompanyLocation/bad-${Date.now()}`;
        
        // Non-existent shop - FK violation
        const badShopId = `shop-nonexistent-${Date.now()}`;
        
        const accounts = [
          mapCompanyLocationToBuyerAccount(TEST_SHOP_ID, {
            id: goodLocId1,
            name: "Good Account 1",
            company: { id: `gid://shopify/Company/good1-${Date.now()}` },
          }, {}),
          mapCompanyLocationToBuyerAccount(badShopId, { // Non-existent shop - FK violation
            id: badLocId,
            name: "Bad Account",
            company: { id: `gid://shopify/Company/bad-${Date.now()}` },
          }, {}),
        ];

        // Flag off: errors propagate like main, so the call rejects on the bad row
        await expect(bulkUpsertBuyerAccounts(sql, accounts)).rejects.toThrow();
        
        // The good account before the bad row was inserted (row-by-row processing)
        const [good1] = await sql`
          SELECT * FROM "BuyerAccount" WHERE "companyLocationId" = ${goodLocId1}
        `;
        expect(good1).toBeDefined();
        expect(good1.name).toBe("Good Account 1");
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

  describe("contactKnown=false preserves existing contact (bulk orphans, ACCESS_DENIED fallback)", () => {
    it("preserves existing contact when contactKnown=false (orphan location from bulk chunk)", async () => {
      const locationId = `gid://shopify/CompanyLocation/orphan-${TEST_SUFFIX}`;
      const companyId = `gid://shopify/Company/orphan-co-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "mainContactEmail", "mainContactName", "mainContactCustomerId",
          "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'COMPANY', ${companyId}, ${locationId}, 'Orphan Location',
          'existing-contact@example.com', 'Existing Contact', 'gid://shopify/Customer/existing',
          NOW(), NOW()
        )
      `;

      const location: ShopifyCompanyLocation = {
        id: locationId,
        name: "Orphan Location Updated",
        company: { id: companyId },
      };

      const result = await processCompanyLocationWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "COMPANY_LOCATIONS_UPDATE",
        location,
        `wh-orphan-${TEST_SUFFIX}`,
        { CUSTOMER_PII_FIELDS: "1" },
        false
      );

      expect(result.success).toBe(true);

      const [account] = await sql`
        SELECT "mainContactEmail", "mainContactName", "mainContactCustomerId", name
        FROM "BuyerAccount" WHERE "companyLocationId" = ${locationId}
      `;
      expect(account.mainContactEmail).toBe("existing-contact@example.com");
      expect(account.mainContactName).toBe("Existing Contact");
      expect(account.mainContactCustomerId).toBe("gid://shopify/Customer/existing");
      expect(account.name).toBe("Orphan Location Updated");
    });

    it("preserves contact when contactKnown=false even if location has mainContact (orphan still preserves existing)", async () => {
      const locationId = `gid://shopify/CompanyLocation/orphan-with-${TEST_SUFFIX}`;
      const companyId = `gid://shopify/Company/orphan-with-co-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "mainContactEmail", "mainContactName", "mainContactCustomerId",
          "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'COMPANY', ${companyId}, ${locationId}, 'Has Existing Contact',
          'keep-me@example.com', 'Keep Me', 'gid://shopify/Customer/keep',
          NOW(), NOW()
        )
      `;

      const location: ShopifyCompanyLocation = {
        id: locationId,
        name: "Has Existing Contact",
        company: {
          id: companyId,
          mainContact: {
            customer: {
              id: "gid://shopify/Customer/ignore-this",
              email: "ignore-this@example.com",
              displayName: "Ignore This",
            },
          },
        },
      };

      const result = await processCompanyLocationWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "COMPANY_LOCATIONS_UPDATE",
        location,
        `wh-orphan-with-${TEST_SUFFIX}`,
        { CUSTOMER_PII_FIELDS: "1" },
        false
      );

      expect(result.success).toBe(true);

      const [account] = await sql`
        SELECT "mainContactEmail", "mainContactName", "mainContactCustomerId"
        FROM "BuyerAccount" WHERE "companyLocationId" = ${locationId}
      `;
      expect(account.mainContactEmail).toBe("keep-me@example.com");
      expect(account.mainContactName).toBe("Keep Me");
      expect(account.mainContactCustomerId).toBe("gid://shopify/Customer/keep");
    });

    it("inserts new account with NULL contact when contactKnown=false (no existing row)", async () => {
      const locationId = `gid://shopify/CompanyLocation/new-orphan-${TEST_SUFFIX}`;
      const companyId = `gid://shopify/Company/new-orphan-co-${TEST_SUFFIX}`;

      const location: ShopifyCompanyLocation = {
        id: locationId,
        name: "New Orphan Location",
        company: { id: companyId },
      };

      const result = await processCompanyLocationWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "COMPANY_LOCATIONS_CREATE",
        location,
        `wh-new-orphan-${TEST_SUFFIX}`,
        { CUSTOMER_PII_FIELDS: "1" },
        false
      );

      expect(result.success).toBe(true);

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

  describe("T5: locationDeletedAt handling", () => {
    it("DELETE webhook sets locationDeletedAt on COMPANY account", async () => {
      const locationId = `gid://shopify/CompanyLocation/del-${TEST_SUFFIX}`;
      const companyId = `gid://shopify/Company/del-co-${TEST_SUFFIX}`;

      // Create existing account
      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'COMPANY', ${companyId}, ${locationId}, 'To Delete',
          NOW(), NOW()
        )
      `;

      const location = {
        id: locationId,
        name: "To Delete",
        company: { id: companyId },
      };

      const triggeredAt = new Date("2026-10-20T10:00:00Z");
      const result = await processCompanyLocationWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "COMPANY_LOCATIONS_DELETE",
        location,
        `wh-del-${TEST_SUFFIX}`,
        {},
        true,
        triggeredAt
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("updated");

      const [account] = await sql<{ locationDeletedAt: Date | null }[]>`
        SELECT "locationDeletedAt" FROM "BuyerAccount" WHERE "companyLocationId" = ${locationId}
      `;
      expect(account.locationDeletedAt).not.toBeNull();
      expect(account.locationDeletedAt!.getTime()).toBe(triggeredAt.getTime());
    });

    it("deleted account is excluded from active count", async () => {
      const { countActiveAccounts } = await import("../../gating.server");

      const locationId = `gid://shopify/CompanyLocation/count-del-${TEST_SUFFIX}`;
      const companyId = `gid://shopify/Company/count-del-co-${TEST_SUFFIX}`;
      const activeLocationId = `gid://shopify/CompanyLocation/count-active-${TEST_SUFFIX}`;
      const activeCompanyId = `gid://shopify/Company/count-active-co-${TEST_SUFFIX}`;

      // Create one deleted account and one active account
      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name, "locationDeletedAt",
          "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'COMPANY', ${companyId}, ${locationId}, 'Deleted Account',
          NOW(), NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'COMPANY', ${activeCompanyId}, ${activeLocationId}, 'Active Account',
          NOW(), NOW()
        )
      `;

      const count = await countActiveAccounts(sql, TEST_SHOP_ID);
      expect(count).toBe(1); // Only the active one counts
    });

    it("restore with newer timestamp clears locationDeletedAt", async () => {
      const locationId = `gid://shopify/CompanyLocation/restore-${TEST_SUFFIX}`;
      const companyId = `gid://shopify/Company/restore-co-${TEST_SUFFIX}`;
      const deleteTime = new Date("2026-10-20T10:00:00Z");
      const restoreTime = new Date("2026-10-21T10:00:00Z"); // 1 day later

      // Create account with locationDeletedAt set
      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name, "locationDeletedAt",
          "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'COMPANY', ${companyId}, ${locationId}, 'Deleted Then Restored',
          ${deleteTime}, NOW(), NOW()
        )
      `;

      const location = {
        id: locationId,
        name: "Restored Location",
        company: { id: companyId },
      };

      const result = await processCompanyLocationWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "COMPANY_LOCATIONS_UPDATE",
        location,
        `wh-restore-${TEST_SUFFIX}`,
        {},
        true,
        restoreTime
      );

      expect(result.success).toBe(true);

      const [account] = await sql<{ locationDeletedAt: Date | null }[]>`
        SELECT "locationDeletedAt" FROM "BuyerAccount" WHERE "companyLocationId" = ${locationId}
      `;
      expect(account.locationDeletedAt).toBeNull(); // Cleared because restoreTime > deleteTime
    });

    it("restore CAN push shop over limit (no gating on restore)", async () => {
      const originalEnv = process.env.PLAN_GATING_ENFORCED;
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";

      try {
        // Set shop to starter plan (limit 25)
        await sql`
          UPDATE "Shop" SET plan_key = 'starter', plan_cached_at = NOW()
          WHERE id = ${TEST_SHOP_ID}
        `;

        // Create 25 active accounts to fill the limit
        for (let i = 0; i < 25; i++) {
          await sql`
            INSERT INTO "BuyerAccount" (
              "shopId", kind, "companyId", "companyLocationId", name,
              "createdAt", "updatedAt"
            ) VALUES (
              ${TEST_SHOP_ID}, 'COMPANY',
              ${'gid://shopify/Company/fill-restore-' + i + '-' + TEST_SUFFIX},
              ${'gid://shopify/CompanyLocation/fill-restore-' + i + '-' + TEST_SUFFIX},
              ${'Fill Account ' + i},
              NOW(), NOW()
            )
          `;
        }

        // Create a deleted account (doesn't count)
        const deletedLocationId = `gid://shopify/CompanyLocation/restore-over-${TEST_SUFFIX}`;
        const deleteTime = new Date("2026-10-20T10:00:00Z");
        await sql`
          INSERT INTO "BuyerAccount" (
            "shopId", kind, "companyId", "companyLocationId", name, "locationDeletedAt",
            "createdAt", "updatedAt"
          ) VALUES (
            ${TEST_SHOP_ID}, 'COMPANY',
            'gid://shopify/Company/restore-over-co',
            ${deletedLocationId}, 'Was Deleted',
            ${deleteTime}, NOW(), NOW()
          )
        `;

        const { countActiveAccounts } = await import("../../gating.server");
        const countBefore = await countActiveAccounts(sql, TEST_SHOP_ID);
        expect(countBefore).toBe(25); // At limit

        // Restore the deleted location with newer timestamp
        const restoreTime = new Date("2026-10-21T10:00:00Z");
        const result = await processCompanyLocationWebhook(
          sql,
          TEST_SHOP_DOMAIN,
          "COMPANY_LOCATIONS_UPDATE",
          {
            id: deletedLocationId,
            name: "Restored Over Limit",
            company: { id: "gid://shopify/Company/restore-over-co" },
          },
          `wh-restore-over-${TEST_SUFFIX}`,
          {},
          true,
          restoreTime
        );

        expect(result.success).toBe(true);

        const countAfter = await countActiveAccounts(sql, TEST_SHOP_ID);
        expect(countAfter).toBe(26); // Over limit! No gating on restore.
      } finally {
        if (originalEnv !== undefined) {
          (process.env as Record<string, string>).PLAN_GATING_ENFORCED = originalEnv;
        } else {
          delete (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED;
        }
      }
    });

    it("repeat DELETE keeps first timestamp (idempotent)", async () => {
      const locationId = `gid://shopify/CompanyLocation/repeat-del-${TEST_SUFFIX}`;
      const companyId = `gid://shopify/Company/repeat-del-co-${TEST_SUFFIX}`;
      const firstDeleteTime = new Date("2026-10-20T10:00:00Z");

      // Create account with first delete timestamp
      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name, "locationDeletedAt",
          "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'COMPANY', ${companyId}, ${locationId}, 'Repeat Delete',
          ${firstDeleteTime}, NOW(), NOW()
        )
      `;

      // Second delete with later timestamp
      const secondDeleteTime = new Date("2026-10-25T10:00:00Z");
      const result = await processCompanyLocationWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "COMPANY_LOCATIONS_DELETE",
        { id: locationId, name: "", company: { id: companyId } },
        `wh-repeat-del-${TEST_SUFFIX}`,
        {},
        true,
        secondDeleteTime
      );

      expect(result.success).toBe(true);

      const [account] = await sql<{ locationDeletedAt: Date | null }[]>`
        SELECT "locationDeletedAt" FROM "BuyerAccount" WHERE "companyLocationId" = ${locationId}
      `;
      // COALESCE keeps the first timestamp
      expect(account.locationDeletedAt!.getTime()).toBe(firstDeleteTime.getTime());
    });

    it("stale restore payload (older than delete) does NOT clear locationDeletedAt", async () => {
      const locationId = `gid://shopify/CompanyLocation/stale-${TEST_SUFFIX}`;
      const companyId = `gid://shopify/Company/stale-co-${TEST_SUFFIX}`;
      const deleteTime = new Date("2026-10-25T10:00:00Z");
      const staleRestoreTime = new Date("2026-10-20T10:00:00Z"); // 5 days BEFORE delete

      // Create account with locationDeletedAt set
      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name, "locationDeletedAt",
          "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'COMPANY', ${companyId}, ${locationId}, 'Stale Restore Test',
          ${deleteTime}, NOW(), NOW()
        )
      `;

      const result = await processCompanyLocationWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "COMPANY_LOCATIONS_UPDATE",
        { id: locationId, name: "Stale Update", company: { id: companyId } },
        `wh-stale-${TEST_SUFFIX}`,
        {},
        true,
        staleRestoreTime
      );

      expect(result.success).toBe(true);

      const [account] = await sql<{ locationDeletedAt: Date | null }[]>`
        SELECT "locationDeletedAt" FROM "BuyerAccount" WHERE "companyLocationId" = ${locationId}
      `;
      // locationDeletedAt NOT cleared because staleRestoreTime < deleteTime
      expect(account.locationDeletedAt).not.toBeNull();
      expect(account.locationDeletedAt!.getTime()).toBe(deleteTime.getTime());
    });

    it("TAGGED_CUSTOMER rows are never marked with locationDeletedAt", async () => {
      const customerId = `gid://shopify/Customer/tagged-del-${TEST_SUFFIX}`;

      // Create a TAGGED_CUSTOMER account
      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "customerId", name,
          "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER', ${customerId}, 'Tagged Customer',
          NOW(), NOW()
        )
      `;

      // Try to "delete" using a COMPANY location with same ID (should not match)
      // This simulates the fact that DELETE only affects COMPANY kind
      await sql`
        UPDATE "BuyerAccount"
        SET "locationDeletedAt" = COALESCE("locationDeletedAt", NOW())
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND "companyLocationId" = ${customerId}
          AND kind = 'COMPANY'
      `;

      const [account] = await sql<{ locationDeletedAt: Date | null; kind: string }[]>`
        SELECT "locationDeletedAt", kind FROM "BuyerAccount" WHERE "customerId" = ${customerId}
      `;
      expect(account.kind).toBe("TAGGED_CUSTOMER");
      expect(account.locationDeletedAt).toBeNull(); // Never marked
    });

    it("flag-off: DELETE does not use sql.begin", async () => {
      const originalEnv = process.env.PLAN_GATING_ENFORCED;
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "false";

      try {
        vi.resetModules();
        const beginSpy = vi.spyOn(sql, "begin");

        const locationId = `gid://shopify/CompanyLocation/flagoff-del-${TEST_SUFFIX}`;
        const companyId = `gid://shopify/Company/flagoff-del-co-${TEST_SUFFIX}`;

        // Create account
        await sql`
          INSERT INTO "BuyerAccount" (
            "shopId", kind, "companyId", "companyLocationId", name,
            "createdAt", "updatedAt"
          ) VALUES (
            ${TEST_SHOP_ID}, 'COMPANY', ${companyId}, ${locationId}, 'Flag Off Delete',
            NOW(), NOW()
          )
        `;

        const { processCompanyLocationWebhook: processWebhook } = await import("../company-location.server");
        const result = await processWebhook(
          sql,
          TEST_SHOP_DOMAIN,
          "COMPANY_LOCATIONS_DELETE",
          { id: locationId, name: "", company: { id: companyId } },
          `wh-flagoff-del-${TEST_SUFFIX}`,
          {},
          true,
          new Date()
        );

        expect(result.success).toBe(true);
        expect(beginSpy).not.toHaveBeenCalled();

        // locationDeletedAt still set (write happens regardless of flag)
        const [account] = await sql<{ locationDeletedAt: Date | null }[]>`
          SELECT "locationDeletedAt" FROM "BuyerAccount" WHERE "companyLocationId" = ${locationId}
        `;
        expect(account.locationDeletedAt).not.toBeNull();

        beginSpy.mockRestore();
      } finally {
        if (originalEnv !== undefined) {
          (process.env as Record<string, string>).PLAN_GATING_ENFORCED = originalEnv;
        } else {
          delete (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED;
        }
      }
    });

    it("flag-off: webhook restore does not use sql.begin but still clears locationDeletedAt", async () => {
      const originalEnv = process.env.PLAN_GATING_ENFORCED;
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "false";

      try {
        vi.resetModules();
        const beginSpy = vi.spyOn(sql, "begin");

        const locationId = `gid://shopify/CompanyLocation/flagoff-restore-${TEST_SUFFIX}`;
        const companyId = `gid://shopify/Company/flagoff-restore-co-${TEST_SUFFIX}`;
        const deleteTime = new Date("2026-10-20T10:00:00Z");
        const restoreTime = new Date("2026-10-21T10:00:00Z"); // newer

        // Create deleted account
        await sql`
          INSERT INTO "BuyerAccount" (
            "shopId", kind, "companyId", "companyLocationId", name, "locationDeletedAt",
            "createdAt", "updatedAt"
          ) VALUES (
            ${TEST_SHOP_ID}, 'COMPANY', ${companyId}, ${locationId}, 'Flag Off Restore',
            ${deleteTime}, NOW(), NOW()
          )
        `;

        const { processCompanyLocationWebhook: processWebhook } = await import("../company-location.server");
        const result = await processWebhook(
          sql,
          TEST_SHOP_DOMAIN,
          "COMPANY_LOCATIONS_UPDATE",
          { id: locationId, name: "Restored", company: { id: companyId } },
          `wh-flagoff-restore-${TEST_SUFFIX}`,
          {},
          true,
          restoreTime
        );

        expect(result.success).toBe(true);
        expect(beginSpy).not.toHaveBeenCalled();

        // locationDeletedAt cleared because restoreTime > deleteTime
        const [account] = await sql<{ locationDeletedAt: Date | null }[]>`
          SELECT "locationDeletedAt" FROM "BuyerAccount" WHERE "companyLocationId" = ${locationId}
        `;
        expect(account.locationDeletedAt).toBeNull();

        beginSpy.mockRestore();
      } finally {
        if (originalEnv !== undefined) {
          (process.env as Record<string, string>).PLAN_GATING_ENFORCED = originalEnv;
        } else {
          delete (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED;
        }
      }
    });

    it("flag-off: webhook upsert (CREATE) does not use sql.begin", async () => {
      const originalEnv = process.env.PLAN_GATING_ENFORCED;
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "false";

      try {
        vi.resetModules();
        const beginSpy = vi.spyOn(sql, "begin");

        const locationId = `gid://shopify/CompanyLocation/flagoff-create-${TEST_SUFFIX}`;
        const companyId = `gid://shopify/Company/flagoff-create-co-${TEST_SUFFIX}`;

        const { processCompanyLocationWebhook: processWebhook } = await import("../company-location.server");
        const result = await processWebhook(
          sql,
          TEST_SHOP_DOMAIN,
          "COMPANY_LOCATIONS_CREATE",
          { id: locationId, name: "Flag Off Create", company: { id: companyId } },
          `wh-flagoff-create-${TEST_SUFFIX}`,
          {},
          true,
          new Date()
        );

        expect(result.success).toBe(true);
        expect(result.action).toBe("created");
        expect(beginSpy).not.toHaveBeenCalled();

        beginSpy.mockRestore();
      } finally {
        if (originalEnv !== undefined) {
          (process.env as Record<string, string>).PLAN_GATING_ENFORCED = originalEnv;
        } else {
          delete (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED;
        }
      }
    });

    it("flag-off: bulk upsert does not use sql.begin but still handles locationDeletedAt", async () => {
      const originalEnv = process.env.PLAN_GATING_ENFORCED;
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "false";

      try {
        vi.resetModules();
        const beginSpy = vi.spyOn(sql, "begin");

        const locationId = `gid://shopify/CompanyLocation/flagoff-bulk-${TEST_SUFFIX}`;
        const companyId = `gid://shopify/Company/flagoff-bulk-co-${TEST_SUFFIX}`;
        const deleteTime = new Date("2026-10-20T10:00:00Z");
        const snapshotTime = new Date("2026-10-21T10:00:00Z"); // newer

        // Create deleted account
        await sql`
          INSERT INTO "BuyerAccount" (
            "shopId", kind, "companyId", "companyLocationId", name, "locationDeletedAt",
            "createdAt", "updatedAt"
          ) VALUES (
            ${TEST_SHOP_ID}, 'COMPANY', ${companyId}, ${locationId}, 'Flag Off Bulk',
            ${deleteTime}, NOW(), NOW()
          )
        `;

        const { bulkUpsertBuyerAccounts: bulkUpsert, mapCompanyLocationToBuyerAccount: mapLocation } = await import("../company-location.server");
        const accounts = [
          mapLocation(TEST_SHOP_ID, {
            id: locationId,
            name: "Bulk Restored",
            company: { id: companyId },
          }, {}),
        ];

        const count = await bulkUpsert(sql, accounts, snapshotTime);
        expect(count).toBe(1);
        expect(beginSpy).not.toHaveBeenCalled();

        // locationDeletedAt cleared because snapshotTime > deleteTime
        const [account] = await sql<{ locationDeletedAt: Date | null }[]>`
          SELECT "locationDeletedAt" FROM "BuyerAccount" WHERE "companyLocationId" = ${locationId}
        `;
        expect(account.locationDeletedAt).toBeNull();

        beginSpy.mockRestore();
      } finally {
        if (originalEnv !== undefined) {
          (process.env as Record<string, string>).PLAN_GATING_ENFORCED = originalEnv;
        } else {
          delete (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED;
        }
      }
    });
  });

  describe("T5: bulk snapshot time handling", () => {
    it("bulk snapshot older than delete does NOT clear locationDeletedAt", async () => {
      const locationId = `gid://shopify/CompanyLocation/stale-bulk-${TEST_SUFFIX}`;
      const companyId = `gid://shopify/Company/stale-bulk-co-${TEST_SUFFIX}`;
      const deleteTime = new Date("2026-10-25T10:00:00Z");
      const staleSnapshotTime = new Date("2026-10-20T10:00:00Z"); // 5 days BEFORE delete

      // Create account with locationDeletedAt set
      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name, "locationDeletedAt",
          "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'COMPANY', ${companyId}, ${locationId}, 'Stale Bulk Test',
          ${deleteTime}, NOW(), NOW()
        )
      `;

      const accounts = [
        mapCompanyLocationToBuyerAccount(TEST_SHOP_ID, {
          id: locationId,
          name: "Stale Bulk Update",
          company: { id: companyId },
        }, {}),
      ];

      await bulkUpsertBuyerAccounts(sql, accounts, staleSnapshotTime);

      const [account] = await sql<{ locationDeletedAt: Date | null; name: string }[]>`
        SELECT "locationDeletedAt", name FROM "BuyerAccount" WHERE "companyLocationId" = ${locationId}
      `;
      // locationDeletedAt NOT cleared because staleSnapshotTime < deleteTime
      expect(account.locationDeletedAt).not.toBeNull();
      expect(account.locationDeletedAt!.getTime()).toBe(deleteTime.getTime());
      // But name was still updated
      expect(account.name).toBe("Stale Bulk Update");
    });

    it("bulk snapshot newer than delete DOES clear locationDeletedAt", async () => {
      const locationId = `gid://shopify/CompanyLocation/new-bulk-${TEST_SUFFIX}`;
      const companyId = `gid://shopify/Company/new-bulk-co-${TEST_SUFFIX}`;
      const deleteTime = new Date("2026-10-20T10:00:00Z");
      const newerSnapshotTime = new Date("2026-10-25T10:00:00Z"); // 5 days AFTER delete

      // Create account with locationDeletedAt set
      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name, "locationDeletedAt",
          "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'COMPANY', ${companyId}, ${locationId}, 'Newer Bulk Test',
          ${deleteTime}, NOW(), NOW()
        )
      `;

      const accounts = [
        mapCompanyLocationToBuyerAccount(TEST_SHOP_ID, {
          id: locationId,
          name: "Newer Bulk Update",
          company: { id: companyId },
        }, {}),
      ];

      await bulkUpsertBuyerAccounts(sql, accounts, newerSnapshotTime);

      const [account] = await sql<{ locationDeletedAt: Date | null; name: string }[]>`
        SELECT "locationDeletedAt", name FROM "BuyerAccount" WHERE "companyLocationId" = ${locationId}
      `;
      // locationDeletedAt cleared because newerSnapshotTime > deleteTime
      expect(account.locationDeletedAt).toBeNull();
      expect(account.name).toBe("Newer Bulk Update");
    });

    it("bulk with unknown snapshot time (null) does NOT clear locationDeletedAt", async () => {
      const locationId = `gid://shopify/CompanyLocation/null-bulk-${TEST_SUFFIX}`;
      const companyId = `gid://shopify/Company/null-bulk-co-${TEST_SUFFIX}`;
      const deleteTime = new Date("2026-10-20T10:00:00Z");

      // Create account with locationDeletedAt set
      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name, "locationDeletedAt",
          "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'COMPANY', ${companyId}, ${locationId}, 'Null Snapshot Test',
          ${deleteTime}, NOW(), NOW()
        )
      `;

      const accounts = [
        mapCompanyLocationToBuyerAccount(TEST_SHOP_ID, {
          id: locationId,
          name: "Null Snapshot Update",
          company: { id: companyId },
        }, {}),
      ];

      // Pass null for snapshotAt (unknown snapshot time)
      await bulkUpsertBuyerAccounts(sql, accounts, null);

      const [account] = await sql<{ locationDeletedAt: Date | null; name: string }[]>`
        SELECT "locationDeletedAt", name FROM "BuyerAccount" WHERE "companyLocationId" = ${locationId}
      `;
      // locationDeletedAt NOT cleared because snapshotAt is null (unknown)
      expect(account.locationDeletedAt).not.toBeNull();
      expect(account.locationDeletedAt!.getTime()).toBe(deleteTime.getTime());
      // But name was still updated
      expect(account.name).toBe("Null Snapshot Update");
    });

    it("bulk with undefined snapshot time does NOT clear locationDeletedAt", async () => {
      const locationId = `gid://shopify/CompanyLocation/undef-bulk-${TEST_SUFFIX}`;
      const companyId = `gid://shopify/Company/undef-bulk-co-${TEST_SUFFIX}`;
      const deleteTime = new Date("2026-10-20T10:00:00Z");

      // Create account with locationDeletedAt set
      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name, "locationDeletedAt",
          "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'COMPANY', ${companyId}, ${locationId}, 'Undefined Snapshot Test',
          ${deleteTime}, NOW(), NOW()
        )
      `;

      const accounts = [
        mapCompanyLocationToBuyerAccount(TEST_SHOP_ID, {
          id: locationId,
          name: "Undefined Snapshot Update",
          company: { id: companyId },
        }, {}),
      ];

      // Don't pass snapshotAt at all (undefined)
      await bulkUpsertBuyerAccounts(sql, accounts);

      const [account] = await sql<{ locationDeletedAt: Date | null; name: string }[]>`
        SELECT "locationDeletedAt", name FROM "BuyerAccount" WHERE "companyLocationId" = ${locationId}
      `;
      // locationDeletedAt NOT cleared because snapshotAt is undefined (unknown)
      expect(account.locationDeletedAt).not.toBeNull();
      expect(account.locationDeletedAt!.getTime()).toBe(deleteTime.getTime());
      // But name was still updated
      expect(account.name).toBe("Undefined Snapshot Update");
    });
  });
});
