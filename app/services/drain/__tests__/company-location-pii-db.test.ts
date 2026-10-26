/**
 * DB-backed integration tests for B2B main contact PII handling through handleCompanyLocation.
 *
 * Tests the real production code path:
 * - handleCompanyLocation in processor.server.ts
 * - processCompanyLocationWebhook in company-location.server.ts
 * - BuyerAccount storage in real Postgres
 *
 * Only mocks: Shopify Admin GraphQL client (adminGraphQL)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

function makeTestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-pii`;
}

let sqlRef: ReturnType<typeof postgres>;
let capturedQueries: string[] = [];

const { adminGraphQLMock } = vi.hoisted(() => ({
  adminGraphQLMock: vi.fn(),
}));

vi.mock("~/services/drain/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/drain/admin-client.server")>();
  return {
    ...actual,
    adminGraphQL: adminGraphQLMock,
  };
});

vi.mock("~/services/sync/company.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/sync/company.server")>();
  return {
    ...actual,
    isWebhookProcessed: vi.fn().mockResolvedValue(false),
    markWebhookProcessed: actual.markWebhookProcessed,
  };
});

vi.mock("~/lib/request-context.server", () => ({
  getRequestEnv: vi.fn(),
  getRequestSql: vi.fn(() => ({})),
  getRequestWaitUntil: vi.fn(() => () => {}),
  requestContext: { getStore: vi.fn() },
}));

describeWithDb("handleCompanyLocation B2B main contact PII (DB)", () => {
  const TEST_SUFFIX = makeTestId();
  const TEST_SHOP_ID = `shop-pii-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `pii-test-${TEST_SUFFIX}.myshopify.com`;

  beforeAll(async () => {
    sqlRef = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sqlRef`
      INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, NOW(), NOW())
    `;

    await sqlRef`
      CREATE TABLE IF NOT EXISTS s6_processed_webhooks (
        webhook_id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        resource_gid TEXT NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
  });

  afterAll(async () => {
    await sqlRef`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sqlRef`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sqlRef`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${"wh-pii-" + TEST_SUFFIX + "%"}`;
    await sqlRef.end();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedQueries = [];
    await sqlRef`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sqlRef`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${"wh-pii-" + TEST_SUFFIX + "%"}`;
    // Clean up ALL queue messages to ensure isolation (drain processes any shop)
    await sqlRef`DELETE FROM pgmq.q_s6_sync`;
    await sqlRef`DELETE FROM pgmq.q_s6_bulk`;
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("1a: CUSTOMER_PII_FIELDS=1, mainContact returned", () => {
    it("stores mainContactEmail, mainContactName and mainContactCustomerId in BuyerAccount", async () => {
      const { getRequestEnv } = await import("~/lib/request-context.server");
      vi.mocked(getRequestEnv).mockReturnValue({ CUSTOMER_PII_FIELDS: "1" });

      const locationId = `gid://shopify/CompanyLocation/loc-pii-on-${TEST_SUFFIX}`;
      const companyId = `gid://shopify/Company/co-pii-on-${TEST_SUFFIX}`;
      const customerId = `gid://shopify/Customer/contact-${TEST_SUFFIX}`;

      adminGraphQLMock.mockImplementation(async (_shop: string, query: string) => {
        capturedQueries.push(query);
        return {
          success: true,
          data: {
            node: {
              id: locationId,
              name: "Test Location PII On",
              company: {
                id: companyId,
                mainContact: {
                  customer: {
                    id: customerId,
                    email: "contact@example.com",
                    displayName: "Contact Person",
                  },
                },
              },
              buyerExperienceConfiguration: {
                paymentTermsTemplate: {
                  id: "pt-1",
                  name: "Net 30",
                  dueInDays: 30,
                  paymentTermsType: "NET",
                },
              },
            },
          },
          retryable: false,
        };
      });

      const { runDrain } = await import("~/services/drain/processor.server");

      await sqlRef`
        INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
        VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json({
          shop: TEST_SHOP_DOMAIN,
          topic: "COMPANY_LOCATIONS_CREATE",
          webhookId: `wh-pii-on-${TEST_SUFFIX}`,
          resourceGid: locationId,
          enqueuedAt: new Date().toISOString(),
        })}::jsonb)
      `;

      await runDrain(sqlRef, { batchSize: 1, timeBudgetMs: 5000, maxRetries: 3 });

      const [account] = await sqlRef<{
        mainContactEmail: string | null;
        mainContactName: string | null;
        mainContactCustomerId: string | null;
      }[]>`
        SELECT "mainContactEmail", "mainContactName", "mainContactCustomerId"
        FROM "BuyerAccount"
        WHERE "companyLocationId" = ${locationId}
      `;

      expect(account).toBeDefined();
      expect(account.mainContactEmail).toBe("contact@example.com");
      expect(account.mainContactName).toBe("Contact Person");
      expect(account.mainContactCustomerId).toBe(customerId);
    });
  });

  describe("1b: CUSTOMER_PII_FIELDS off", () => {
    it("stores NULL for all 3 contact fields and query contains no email/displayName", async () => {
      const { getRequestEnv } = await import("~/lib/request-context.server");
      vi.mocked(getRequestEnv).mockReturnValue({});

      const locationId = `gid://shopify/CompanyLocation/loc-pii-off-${TEST_SUFFIX}`;
      const companyId = `gid://shopify/Company/co-pii-off-${TEST_SUFFIX}`;

      adminGraphQLMock.mockImplementation(async (_shop: string, query: string) => {
        capturedQueries.push(query);
        return {
          success: true,
          data: {
            node: {
              id: locationId,
              name: "Test Location PII Off",
              company: {
                id: companyId,
                mainContact: {
                  customer: {
                    id: `gid://shopify/Customer/off-${TEST_SUFFIX}`,
                  },
                },
              },
              buyerExperienceConfiguration: {
                paymentTermsTemplate: {
                  id: "pt-2",
                  name: "Net 30",
                  dueInDays: 30,
                  paymentTermsType: "NET",
                },
              },
            },
          },
          retryable: false,
        };
      });

      const { runDrain } = await import("~/services/drain/processor.server");

      await sqlRef`
        INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
        VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json({
          shop: TEST_SHOP_DOMAIN,
          topic: "COMPANY_LOCATIONS_CREATE",
          webhookId: `wh-pii-off-${TEST_SUFFIX}`,
          resourceGid: locationId,
          enqueuedAt: new Date().toISOString(),
        })}::jsonb)
      `;

      await runDrain(sqlRef, { batchSize: 1, timeBudgetMs: 5000, maxRetries: 3 });

      const [account] = await sqlRef<{
        mainContactEmail: string | null;
        mainContactName: string | null;
        mainContactCustomerId: string | null;
      }[]>`
        SELECT "mainContactEmail", "mainContactName", "mainContactCustomerId"
        FROM "BuyerAccount"
        WHERE "companyLocationId" = ${locationId}
      `;

      expect(account).toBeDefined();
      expect(account.mainContactEmail).toBeNull();
      expect(account.mainContactName).toBeNull();
      expect(account.mainContactCustomerId).toBeNull();

      expect(capturedQueries).toHaveLength(1);
      const sentQuery = capturedQueries[0];
      expect(sentQuery).not.toContain("email");
      expect(sentQuery).not.toContain("displayName");
    });
  });

  describe("1c: ACCESS_DENIED fallback preserves existing contact", () => {
    it("retries with no-mainContact query, location syncs, stored contact unchanged", async () => {
      const { getRequestEnv } = await import("~/lib/request-context.server");
      vi.mocked(getRequestEnv).mockReturnValue({ CUSTOMER_PII_FIELDS: "1" });

      const locationId = `gid://shopify/CompanyLocation/loc-access-denied-${TEST_SUFFIX}`;
      const companyId = `gid://shopify/Company/co-access-denied-${TEST_SUFFIX}`;

      await sqlRef`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "mainContactEmail", "mainContactName", "mainContactCustomerId",
          "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'COMPANY', ${companyId}, ${locationId}, 'Existing Account',
          'existing@example.com', 'Existing Contact', 'gid://shopify/Customer/existing',
          NOW(), NOW()
        )
      `;

      let callCount = 0;
      adminGraphQLMock.mockImplementation(async (_shop: string, query: string) => {
        capturedQueries.push(query);
        callCount++;
        if (callCount === 1) {
          return {
            success: false,
            error: "ACCESS_DENIED: write_customers scope required",
            errorCode: "ACCESS_DENIED",
            retryable: false,
          };
        }
        return {
          success: true,
          data: {
            node: {
              id: locationId,
              name: "Updated Location Name",
              company: { id: companyId },
              buyerExperienceConfiguration: {
                paymentTermsTemplate: {
                  id: "pt-3",
                  name: "Net 45",
                  dueInDays: 45,
                  paymentTermsType: "NET",
                },
              },
            },
          },
          retryable: false,
        };
      });

      const { runDrain } = await import("~/services/drain/processor.server");

      await sqlRef`
        INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
        VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json({
          shop: TEST_SHOP_DOMAIN,
          topic: "COMPANY_LOCATIONS_UPDATE",
          webhookId: `wh-access-denied-${TEST_SUFFIX}`,
          resourceGid: locationId,
          enqueuedAt: new Date().toISOString(),
        })}::jsonb)
      `;

      await runDrain(sqlRef, { batchSize: 1, timeBudgetMs: 5000, maxRetries: 3 });

      expect(capturedQueries).toHaveLength(2);
      const retryQuery = capturedQueries[1];
      expect(retryQuery).not.toContain("mainContact");
      expect(retryQuery).not.toContain("email");
      expect(retryQuery).not.toContain("displayName");

      const [account] = await sqlRef<{
        name: string;
        mainContactEmail: string | null;
        mainContactName: string | null;
        mainContactCustomerId: string | null;
        defaultTermsDays: number | null;
      }[]>`
        SELECT name, "mainContactEmail", "mainContactName", "mainContactCustomerId", "defaultTermsDays"
        FROM "BuyerAccount"
        WHERE "companyLocationId" = ${locationId}
      `;

      expect(account).toBeDefined();
      expect(account.name).toBe("Updated Location Name");
      expect(account.defaultTermsDays).toBe(45);
      expect(account.mainContactEmail).toBe("existing@example.com");
      expect(account.mainContactName).toBe("Existing Contact");
      expect(account.mainContactCustomerId).toBe("gid://shopify/Customer/existing");
    });
  });
});

/**
 * Tests 1d, 1e: Bulk JSONL companies processor with PII flag states.
 *
 * These tests verify processCompanyLines correctly handles mainContact PII
 * based on CUSTOMER_PII_FIELDS flag, storing values when flag is on and
 * NULL when flag is off.
 */
describeWithDb("processCompanyLines B2B main contact PII (DB)", () => {
  const TEST_SUFFIX = makeTestId();
  const TEST_SHOP_ID = `shop-bulk-pii-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `bulk-pii-test-${TEST_SUFFIX}.myshopify.com`;

  beforeAll(async () => {
    sqlRef = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sqlRef`
      INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, NOW(), NOW())
    `;
  });

  afterAll(async () => {
    await sqlRef`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sqlRef`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sqlRef.end();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await sqlRef`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("1d: CUSTOMER_PII_FIELDS=1 via bulk JSONL", () => {
    it("stores mainContactEmail, mainContactName, mainContactCustomerId from JSONL", async () => {
      const { mapCompanyLocationToBuyerAccount, bulkUpsertBuyerAccounts } = await import(
        "~/services/sync/company-location.server"
      );
      const { parseCompanyBulkJsonl, bulkLocationToShopifyLocation } = await import(
        "~/services/sync/bulk-parser.server"
      );

      const companyId = `gid://shopify/Company/co-bulk-on-${TEST_SUFFIX}`;
      const locationId = `gid://shopify/CompanyLocation/loc-bulk-on-${TEST_SUFFIX}`;
      const customerId = `gid://shopify/Customer/bulk-contact-${TEST_SUFFIX}`;

      const jsonl = [
        JSON.stringify({
          id: companyId,
          name: "Bulk Test Company",
          mainContact: {
            customer: {
              id: customerId,
              email: "bulk@example.com",
              displayName: "Bulk Contact Person",
            },
          },
        }),
        JSON.stringify({
          id: locationId,
          name: "Bulk Test Location",
          __parentId: companyId,
          buyerExperienceConfiguration: {
            paymentTermsTemplate: {
              id: "pt-bulk-1",
              name: "Net 30",
              dueInDays: 30,
              paymentTermsType: "NET",
            },
          },
        }),
      ].join("\n");

      const { companies } = parseCompanyBulkJsonl(jsonl);
      expect(companies.size).toBe(1);

      const accounts = [];
      for (const { company, locations } of companies.values()) {
        for (const loc of locations) {
          const shopifyLoc = bulkLocationToShopifyLocation(loc, company.mainContact);
          accounts.push(
            mapCompanyLocationToBuyerAccount(TEST_SHOP_ID, shopifyLoc, { CUSTOMER_PII_FIELDS: "1" }, true)
          );
        }
      }

      expect(accounts).toHaveLength(1);
      expect(accounts[0].mainContactEmail).toBe("bulk@example.com");
      expect(accounts[0].mainContactName).toBe("Bulk Contact Person");
      expect(accounts[0].mainContactCustomerId).toBe(customerId);
      expect(accounts[0].contactKnown).toBe(true);

      await bulkUpsertBuyerAccounts(sqlRef, accounts);

      const [stored] = await sqlRef<{
        mainContactEmail: string | null;
        mainContactName: string | null;
        mainContactCustomerId: string | null;
      }[]>`
        SELECT "mainContactEmail", "mainContactName", "mainContactCustomerId"
        FROM "BuyerAccount"
        WHERE "companyLocationId" = ${locationId}
      `;

      expect(stored).toBeDefined();
      expect(stored.mainContactEmail).toBe("bulk@example.com");
      expect(stored.mainContactName).toBe("Bulk Contact Person");
      expect(stored.mainContactCustomerId).toBe(customerId);
    });
  });

  describe("1e: CUSTOMER_PII_FIELDS off via bulk JSONL", () => {
    it("stores NULL for all 3 contact fields even when mainContact is in JSONL", async () => {
      const { mapCompanyLocationToBuyerAccount, bulkUpsertBuyerAccounts } = await import(
        "~/services/sync/company-location.server"
      );
      const { parseCompanyBulkJsonl, bulkLocationToShopifyLocation } = await import(
        "~/services/sync/bulk-parser.server"
      );

      const companyId = `gid://shopify/Company/co-bulk-off-${TEST_SUFFIX}`;
      const locationId = `gid://shopify/CompanyLocation/loc-bulk-off-${TEST_SUFFIX}`;
      const customerId = `gid://shopify/Customer/bulk-off-contact-${TEST_SUFFIX}`;

      const jsonl = [
        JSON.stringify({
          id: companyId,
          name: "Bulk Test Company Off",
          mainContact: {
            customer: {
              id: customerId,
              email: "bulk-off@example.com",
              displayName: "Bulk Off Contact",
            },
          },
        }),
        JSON.stringify({
          id: locationId,
          name: "Bulk Test Location Off",
          __parentId: companyId,
          buyerExperienceConfiguration: {
            paymentTermsTemplate: {
              id: "pt-bulk-2",
              name: "Net 45",
              dueInDays: 45,
              paymentTermsType: "NET",
            },
          },
        }),
      ].join("\n");

      const { companies } = parseCompanyBulkJsonl(jsonl);
      expect(companies.size).toBe(1);

      const accounts = [];
      for (const { company, locations } of companies.values()) {
        for (const loc of locations) {
          const shopifyLoc = bulkLocationToShopifyLocation(loc, company.mainContact);
          accounts.push(
            mapCompanyLocationToBuyerAccount(TEST_SHOP_ID, shopifyLoc, {}, true)
          );
        }
      }

      expect(accounts).toHaveLength(1);
      expect(accounts[0].mainContactEmail).toBeNull();
      expect(accounts[0].mainContactName).toBeNull();
      expect(accounts[0].mainContactCustomerId).toBeNull();
      expect(accounts[0].contactKnown).toBe(true);

      await bulkUpsertBuyerAccounts(sqlRef, accounts);

      const [stored] = await sqlRef<{
        mainContactEmail: string | null;
        mainContactName: string | null;
        mainContactCustomerId: string | null;
      }[]>`
        SELECT "mainContactEmail", "mainContactName", "mainContactCustomerId"
        FROM "BuyerAccount"
        WHERE "companyLocationId" = ${locationId}
      `;

      expect(stored).toBeDefined();
      expect(stored.mainContactEmail).toBeNull();
      expect(stored.mainContactName).toBeNull();
      expect(stored.mainContactCustomerId).toBeNull();
    });
  });
});

/**
 * Item 2: bulkUpsertBuyerAccounts split-chunk test.
 *
 * Tests that when a company is split across two chunks:
 * - Chunk 1: Company + Location 1 (contactKnown=true, stores contact)
 * - Chunk 2: Orphan Location 2 (contactKnown=false, preserves existing contact)
 * Both locations end up with the contact stored, and orphan upsert doesn't NULL it.
 *
 * Also tests that a fetched Company with mainContact=null DOES clear stored contact
 * (contactKnown=true with null values clears, contactKnown=false preserves).
 */
describeWithDb("bulkUpsertBuyerAccounts split-chunk behavior (DB)", () => {
  const TEST_SUFFIX = makeTestId();
  const TEST_SHOP_ID = `shop-chunk-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `chunk-test-${TEST_SUFFIX}.myshopify.com`;

  beforeAll(async () => {
    sqlRef = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sqlRef`
      INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, NOW(), NOW())
    `;
  });

  afterAll(async () => {
    await sqlRef`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sqlRef`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sqlRef.end();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await sqlRef`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("Item 2: company split across two chunks", () => {
    it("both locations have contact and orphan upsert preserves existing contact", async () => {
      const { mapCompanyLocationToBuyerAccount, bulkUpsertBuyerAccounts } = await import(
        "~/services/sync/company-location.server"
      );
      const { parseCompanyBulkJsonl, bulkLocationToShopifyLocation } = await import(
        "~/services/sync/bulk-parser.server"
      );

      const companyId = `gid://shopify/Company/co-chunk-${TEST_SUFFIX}`;
      const locationId1 = `gid://shopify/CompanyLocation/loc-chunk-1-${TEST_SUFFIX}`;
      const locationId2 = `gid://shopify/CompanyLocation/loc-chunk-2-${TEST_SUFFIX}`;
      const customerId = `gid://shopify/Customer/chunk-contact-${TEST_SUFFIX}`;

      const chunk1Jsonl = [
        JSON.stringify({
          id: companyId,
          name: "Chunk Test Company",
          mainContact: {
            customer: {
              id: customerId,
              email: "chunk@example.com",
              displayName: "Chunk Contact",
            },
          },
        }),
        JSON.stringify({
          id: locationId1,
          name: "Location 1",
          __parentId: companyId,
          buyerExperienceConfiguration: {
            paymentTermsTemplate: { id: "pt-1", name: "Net 30", dueInDays: 30, paymentTermsType: "NET" },
          },
        }),
      ].join("\n");

      const { companies: chunk1Companies } = parseCompanyBulkJsonl(chunk1Jsonl);
      const chunk1Accounts = [];
      for (const { company, locations } of chunk1Companies.values()) {
        for (const loc of locations) {
          const shopifyLoc = bulkLocationToShopifyLocation(loc, company.mainContact);
          chunk1Accounts.push(
            mapCompanyLocationToBuyerAccount(TEST_SHOP_ID, shopifyLoc, { CUSTOMER_PII_FIELDS: "1" }, true)
          );
        }
      }

      expect(chunk1Accounts).toHaveLength(1);
      expect(chunk1Accounts[0].mainContactEmail).toBe("chunk@example.com");
      await bulkUpsertBuyerAccounts(sqlRef, chunk1Accounts);

      const [loc1After] = await sqlRef<{
        mainContactEmail: string | null;
        mainContactName: string | null;
        mainContactCustomerId: string | null;
      }[]>`
        SELECT "mainContactEmail", "mainContactName", "mainContactCustomerId"
        FROM "BuyerAccount"
        WHERE "companyLocationId" = ${locationId1}
      `;

      expect(loc1After).toBeDefined();
      expect(loc1After.mainContactEmail).toBe("chunk@example.com");
      expect(loc1After.mainContactName).toBe("Chunk Contact");
      expect(loc1After.mainContactCustomerId).toBe(customerId);

      const chunk2Jsonl = JSON.stringify({
        id: locationId2,
        name: "Location 2 (orphan)",
        __parentId: companyId,
        buyerExperienceConfiguration: {
          paymentTermsTemplate: { id: "pt-2", name: "Net 45", dueInDays: 45, paymentTermsType: "NET" },
        },
      });

      const { orphanLocations } = parseCompanyBulkJsonl(chunk2Jsonl);
      expect(orphanLocations).toHaveLength(1);

      const chunk2Accounts = [];
      for (const orphanLoc of orphanLocations) {
        const shopifyLoc = bulkLocationToShopifyLocation(orphanLoc);
        chunk2Accounts.push(
          mapCompanyLocationToBuyerAccount(TEST_SHOP_ID, shopifyLoc, { CUSTOMER_PII_FIELDS: "1" }, false)
        );
      }

      expect(chunk2Accounts).toHaveLength(1);
      expect(chunk2Accounts[0].contactKnown).toBe(false);
      expect(chunk2Accounts[0].mainContactEmail).toBeNull();

      await bulkUpsertBuyerAccounts(sqlRef, chunk2Accounts);

      const [loc2After] = await sqlRef<{
        name: string;
        defaultTermsDays: number | null;
        mainContactEmail: string | null;
        mainContactName: string | null;
        mainContactCustomerId: string | null;
      }[]>`
        SELECT name, "defaultTermsDays", "mainContactEmail", "mainContactName", "mainContactCustomerId"
        FROM "BuyerAccount"
        WHERE "companyLocationId" = ${locationId2}
      `;

      expect(loc2After).toBeDefined();
      expect(loc2After.name).toBe("Location 2 (orphan)");
      expect(loc2After.defaultTermsDays).toBe(45);
      expect(loc2After.mainContactEmail).toBeNull();
      expect(loc2After.mainContactName).toBeNull();
      expect(loc2After.mainContactCustomerId).toBeNull();

      const [loc1StillHas] = await sqlRef<{
        mainContactEmail: string | null;
      }[]>`
        SELECT "mainContactEmail"
        FROM "BuyerAccount"
        WHERE "companyLocationId" = ${locationId1}
      `;
      expect(loc1StillHas.mainContactEmail).toBe("chunk@example.com");
    });

    it("orphan upsert updating existing account preserves its stored contact", async () => {
      const { bulkUpsertBuyerAccounts } = await import(
        "~/services/sync/company-location.server"
      );
      type MappedBuyerAccount = Awaited<typeof import("~/services/sync/company-location.server")>["MappedBuyerAccount"];

      const companyId = `gid://shopify/Company/co-preserve-${TEST_SUFFIX}`;
      const locationId = `gid://shopify/CompanyLocation/loc-preserve-${TEST_SUFFIX}`;
      const customerId = `gid://shopify/Customer/preserve-contact-${TEST_SUFFIX}`;

      await sqlRef`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "defaultTermsDays", "mainContactEmail", "mainContactName", "mainContactCustomerId",
          "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'COMPANY', ${companyId}, ${locationId}, 'Original Name',
          30, 'original@example.com', 'Original Contact', ${customerId},
          NOW(), NOW()
        )
      `;

      const orphanAccount = {
        shopId: TEST_SHOP_ID,
        kind: "COMPANY" as const,
        companyId,
        companyLocationId: locationId,
        name: "Updated Name",
        defaultTermsDays: 45,
        defaultTermsSource: "explicit" as const,
        mainContactEmail: null,
        mainContactName: null,
        mainContactCustomerId: null,
        contactKnown: false,
      };

      await bulkUpsertBuyerAccounts(sqlRef, [orphanAccount]);

      const [account] = await sqlRef<{
        name: string;
        defaultTermsDays: number | null;
        mainContactEmail: string | null;
        mainContactName: string | null;
        mainContactCustomerId: string | null;
      }[]>`
        SELECT name, "defaultTermsDays", "mainContactEmail", "mainContactName", "mainContactCustomerId"
        FROM "BuyerAccount"
        WHERE "companyLocationId" = ${locationId}
      `;

      expect(account).toBeDefined();
      expect(account.name).toBe("Updated Name");
      expect(account.defaultTermsDays).toBe(45);
      expect(account.mainContactEmail).toBe("original@example.com");
      expect(account.mainContactName).toBe("Original Contact");
      expect(account.mainContactCustomerId).toBe(customerId);
    });
  });

  describe("Item 2b: fetched Company with mainContact null clears stored contact", () => {
    it("contactKnown=true with null mainContact clears existing stored contact", async () => {
      const { bulkUpsertBuyerAccounts } = await import(
        "~/services/sync/company-location.server"
      );

      const companyId = `gid://shopify/Company/co-clear-${TEST_SUFFIX}`;
      const locationId = `gid://shopify/CompanyLocation/loc-clear-${TEST_SUFFIX}`;
      const customerId = `gid://shopify/Customer/clear-contact-${TEST_SUFFIX}`;

      await sqlRef`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "defaultTermsDays", "mainContactEmail", "mainContactName", "mainContactCustomerId",
          "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'COMPANY', ${companyId}, ${locationId}, 'Has Contact',
          30, 'stored@example.com', 'Stored Contact', ${customerId},
          NOW(), NOW()
        )
      `;

      const [before] = await sqlRef<{ mainContactEmail: string | null }[]>`
        SELECT "mainContactEmail" FROM "BuyerAccount" WHERE "companyLocationId" = ${locationId}
      `;
      expect(before.mainContactEmail).toBe("stored@example.com");

      const accountWithNullContact = {
        shopId: TEST_SHOP_ID,
        kind: "COMPANY" as const,
        companyId,
        companyLocationId: locationId,
        name: "Updated Name",
        defaultTermsDays: 30,
        defaultTermsSource: "explicit" as const,
        mainContactEmail: null,
        mainContactName: null,
        mainContactCustomerId: null,
        contactKnown: true,
      };

      await bulkUpsertBuyerAccounts(sqlRef, [accountWithNullContact]);

      const [after] = await sqlRef<{
        name: string;
        mainContactEmail: string | null;
        mainContactName: string | null;
        mainContactCustomerId: string | null;
      }[]>`
        SELECT name, "mainContactEmail", "mainContactName", "mainContactCustomerId"
        FROM "BuyerAccount"
        WHERE "companyLocationId" = ${locationId}
      `;

      expect(after).toBeDefined();
      expect(after.name).toBe("Updated Name");
      expect(after.mainContactEmail).toBeNull();
      expect(after.mainContactName).toBeNull();
      expect(after.mainContactCustomerId).toBeNull();
    });
  });
});
