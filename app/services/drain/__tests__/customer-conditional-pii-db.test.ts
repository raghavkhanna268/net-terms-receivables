import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

/**
 * Tests for conditional customer PII fetch.
 *
 * Verifies that name/email fields are only requested from Shopify for customers
 * that match a tag rule, not for every customer webhook.
 *
 * Tests:
 * (a) Non-matching customer: one GraphQL request, no email/displayName in query
 * (b) Matching customer: second request with PII, stores name/email as before
 * (c) ACCESS_DENIED fallback works for matching customers
 * (d) Tracked customer with tag removed: one request, no PII, S22 minimisation applies
 *     (S22 nulls PII for inactive customers without open invoices - same as main)
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("Customer conditional PII fetch", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36);
  const TEST_SHOP_ID = `shop-condpii-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-condpii-${TEST_SUFFIX}.myshopify.com`;

  let mockAdminGraphQL: ReturnType<typeof vi.fn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, NOW(), NOW())
    `;

    await sql`
      INSERT INTO "AccountSource" ("shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, 'net-terms', 30, NOW(), NOW())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "AccountSource" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${"wh-condpii-" + TEST_SUFFIX + "%"}`;
    await sql.end();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${"wh-condpii-" + TEST_SUFFIX + "%"}`;

    mockAdminGraphQL = vi.fn();
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.doMock("~/services/drain/admin-client.server", () => ({
      adminGraphQL: mockAdminGraphQL,
    }));

    vi.doMock("~/lib/request-context.server", () => ({
      getRequestEnv: vi.fn(() => ({ CUSTOMER_PII_FIELDS: "1" })),
      getRequestSql: vi.fn(() => null),
    }));
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    vi.resetModules();
  });

  describe("(a) Non-matching customer: one GraphQL request, no PII fields", () => {
    it("makes exactly one request without email/displayName for non-matching customer", async () => {
      const customerId = `gid://shopify/Customer/nomatch-${TEST_SUFFIX}`;

      mockAdminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          node: {
            id: customerId,
            tags: ["other-tag", "wholesale"],
          },
        },
        retryable: false,
      });

      const { getSyncHandler } = await import("../processor.server");
      const handler = getSyncHandler("CUSTOMERS_UPDATE");

      const message = {
        topic: "CUSTOMERS_UPDATE",
        shop: TEST_SHOP_DOMAIN,
        webhookId: `wh-condpii-${TEST_SUFFIX}-nomatch`,
        resourceGid: customerId,
        enqueuedAt: new Date().toISOString(),
      };

      const result = await handler!(sql, message);

      expect(result.success).toBe(true);

      expect(mockAdminGraphQL).toHaveBeenCalledTimes(1);

      const queryText = mockAdminGraphQL.mock.calls[0][1] as string;
      expect(queryText).toContain("id");
      expect(queryText).toContain("tags");
      expect(queryText).not.toContain("email");
      expect(queryText).not.toContain("displayName");

      const [tagRecord] = await sql<{ one: number }[]>`
        SELECT 1 AS one FROM s8_tagged_customers WHERE customer_id = ${customerId}
      `;
      expect(tagRecord).toBeUndefined();
    });
  });

  describe("(b) Matching customer: second request with PII, stores values", () => {
    it("makes two requests and stores email/displayName for matching customer", async () => {
      const customerId = `gid://shopify/Customer/match-${TEST_SUFFIX}`;

      mockAdminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          node: {
            id: customerId,
            tags: ["net-terms", "gold"],
          },
        },
        retryable: false,
      });

      mockAdminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          node: {
            id: customerId,
            tags: ["net-terms", "gold"],
            email: "buyer@test-condpii.example.com",
            displayName: "Test Buyer",
          },
        },
        retryable: false,
      });

      const { getSyncHandler } = await import("../processor.server");
      const handler = getSyncHandler("CUSTOMERS_CREATE");

      const message = {
        topic: "CUSTOMERS_CREATE",
        shop: TEST_SHOP_DOMAIN,
        webhookId: `wh-condpii-${TEST_SUFFIX}-match`,
        resourceGid: customerId,
        enqueuedAt: new Date().toISOString(),
      };

      const result = await handler!(sql, message);

      expect(result.success).toBe(true);
      expect(result.action).toBe("created");

      expect(mockAdminGraphQL).toHaveBeenCalledTimes(2);

      const firstQueryText = mockAdminGraphQL.mock.calls[0][1] as string;
      expect(firstQueryText).toContain("id");
      expect(firstQueryText).toContain("tags");
      expect(firstQueryText).not.toContain("email");
      expect(firstQueryText).not.toContain("displayName");

      const secondQueryText = mockAdminGraphQL.mock.calls[1][1] as string;
      expect(secondQueryText).toContain("email");
      expect(secondQueryText).toContain("displayName");

      const [tagRecord] = await sql<{ email: string | null; display_name: string | null; tag_active: boolean }[]>`
        SELECT email, display_name, tag_active FROM s8_tagged_customers WHERE customer_id = ${customerId}
      `;
      expect(tagRecord).toBeDefined();
      expect(tagRecord.email).toBe("buyer@test-condpii.example.com");
      expect(tagRecord.display_name).toBe("Test Buyer");
      expect(tagRecord.tag_active).toBe(true);
    });
  });

  describe("(c) ACCESS_DENIED fallback works for matching customers", () => {
    it("uses fallback mode when PII query returns ACCESS_DENIED for matching customer", async () => {
      const customerId = `gid://shopify/Customer/fallback-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, email, display_name)
        VALUES (${TEST_SHOP_ID}, ${customerId}, '["net-terms"]'::jsonb, true, 'existing@test-condpii.example.com', 'Existing Name')
      `;

      mockAdminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          node: {
            id: customerId,
            tags: ["net-terms"],
          },
        },
        retryable: false,
      });

      mockAdminGraphQL.mockResolvedValueOnce({
        success: false,
        error: "ACCESS_DENIED: Required scope read_customers Level 1 + Email",
        retryable: false,
        errorCode: "access_denied",
      });

      const { getSyncHandler } = await import("../processor.server");
      const handler = getSyncHandler("CUSTOMERS_UPDATE");

      const message = {
        topic: "CUSTOMERS_UPDATE",
        shop: TEST_SHOP_DOMAIN,
        webhookId: `wh-condpii-${TEST_SUFFIX}-fallback`,
        resourceGid: customerId,
        enqueuedAt: new Date().toISOString(),
      };

      const result = await handler!(sql, message);

      expect(result.success).toBe(true);

      expect(mockAdminGraphQL).toHaveBeenCalledTimes(2);

      const [tagRecord] = await sql<{ email: string | null; display_name: string | null }[]>`
        SELECT email, display_name FROM s8_tagged_customers WHERE customer_id = ${customerId}
      `;
      expect(tagRecord.email).toBe("existing@test-condpii.example.com");
      expect(tagRecord.display_name).toBe("Existing Name");

      expect(consoleWarnSpy).toHaveBeenCalled();
      const warnCalls = consoleWarnSpy.mock.calls.map((c: unknown[]) => c[0]);
      const fallbackLog = warnCalls.find((c: unknown) =>
        typeof c === "string" && c.includes('"event":"customer_pii_access_denied_fallback"')
      );
      expect(fallbackLog).toBeDefined();
    });
  });

  describe("(d) Tracked customer with tag removed: one request, no PII, S22 minimisation applies", () => {
    it("makes exactly one request without email/displayName, sets tag_active false, PII nulled per S22", async () => {
      const customerId = `gid://shopify/Customer/tagremoved-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, email, display_name)
        VALUES (${TEST_SHOP_ID}, ${customerId}, '["net-terms"]'::jsonb, true, 'stored@test-condpii.example.com', 'Stored Name')
      `;

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "customerId", name, "holdState", "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER', ${customerId}, 'Stored Name', 'OK', NOW(), NOW()
        )
      `;

      mockAdminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          node: {
            id: customerId,
            tags: ["other-tag"],
          },
        },
        retryable: false,
      });

      const { getSyncHandler } = await import("../processor.server");
      const handler = getSyncHandler("CUSTOMERS_UPDATE");

      const message = {
        topic: "CUSTOMERS_UPDATE",
        shop: TEST_SHOP_DOMAIN,
        webhookId: `wh-condpii-${TEST_SUFFIX}-tagremoved`,
        resourceGid: customerId,
        enqueuedAt: new Date().toISOString(),
      };

      const result = await handler!(sql, message);

      expect(result.success).toBe(true);

      expect(mockAdminGraphQL).toHaveBeenCalledTimes(1);

      const queryText = mockAdminGraphQL.mock.calls[0][1] as string;
      expect(queryText).toContain("id");
      expect(queryText).toContain("tags");
      expect(queryText).not.toContain("email");
      expect(queryText).not.toContain("displayName");

      const [tagRecord] = await sql<{ tag_active: boolean; tag_deactivated_at: Date | null; email: string | null; display_name: string | null }[]>`
        SELECT tag_active, tag_deactivated_at, email, display_name FROM s8_tagged_customers WHERE customer_id = ${customerId}
      `;
      expect(tagRecord.tag_active).toBe(false);
      expect(tagRecord.tag_deactivated_at).not.toBeNull();
      expect(tagRecord.email).toBeNull();
      expect(tagRecord.display_name).toBeNull();
    });
  });
});
