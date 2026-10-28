/**
 * DB-backed integration tests for fetchShopOnboardingData (S23-04 v1.1).
 *
 * Tests verify that the counts query correctly returns:
 * - L: COMPANY-kind accounts (one per company location)
 * - C: COUNT(DISTINCT companyId) among COMPANY-kind accounts
 * - T: TAGGED_CUSTOMER-kind accounts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { fetchShopOnboardingData } from "~/lib/onboarding-steps.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("fetchShopOnboardingData buyer counts (DB-backed)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-onboard-counts";
  const TEST_SHOP_DOMAIN = `test-onboard-${TEST_SUFFIX}.myshopify.com`;
  let testShopId: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt", "defaultTermsDays")
      VALUES (${TEST_SHOP_DOMAIN}, 'America/New_York', 'INR', 'starter', NOW(), NOW(), 30)
      RETURNING id
    `;
    testShopId = shop.id;
  });

  afterAll(async () => {
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "AccountSource" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "AccountSource" WHERE "shopId" = ${testShopId}`;
  });

  it("returns zero counts when no buyer accounts exist", async () => {
    const result = await fetchShopOnboardingData(sql, TEST_SHOP_DOMAIN);

    expect(result).not.toBeNull();
    expect(result!.buyerCounts).toEqual({
      locationCount: 0,
      companyCount: 0,
      taggedCustomerCount: 0,
    });
    expect(result!.buyerAccountCount).toBe(0);
    expect(result!.tagRuleCount).toBe(0);
  });

  it("counts COMPANY-kind accounts correctly (L == C when one location per company)", async () => {
    await sql`
      INSERT INTO "BuyerAccount" ("shopId", kind, name, "companyId", "companyLocationId", "createdAt", "updatedAt")
      VALUES
        (${testShopId}, 'COMPANY', 'Company A', 'gid://shopify/Company/1', 'gid://shopify/CompanyLocation/1', NOW(), NOW()),
        (${testShopId}, 'COMPANY', 'Company B', 'gid://shopify/Company/2', 'gid://shopify/CompanyLocation/2', NOW(), NOW())
    `;

    const result = await fetchShopOnboardingData(sql, TEST_SHOP_DOMAIN);

    expect(result).not.toBeNull();
    expect(result!.buyerCounts).toEqual({
      locationCount: 2,
      companyCount: 2,
      taggedCustomerCount: 0,
    });
    expect(result!.buyerAccountCount).toBe(2);
  });

  it("counts COMPANY-kind accounts correctly when C != L (multiple locations per company)", async () => {
    await sql`
      INSERT INTO "BuyerAccount" ("shopId", kind, name, "companyId", "companyLocationId", "createdAt", "updatedAt")
      VALUES
        (${testShopId}, 'COMPANY', 'Company A - Location 1', 'gid://shopify/Company/1', 'gid://shopify/CompanyLocation/1', NOW(), NOW()),
        (${testShopId}, 'COMPANY', 'Company A - Location 2', 'gid://shopify/Company/1', 'gid://shopify/CompanyLocation/2', NOW(), NOW()),
        (${testShopId}, 'COMPANY', 'Company B - Location 1', 'gid://shopify/Company/2', 'gid://shopify/CompanyLocation/3', NOW(), NOW())
    `;

    const result = await fetchShopOnboardingData(sql, TEST_SHOP_DOMAIN);

    expect(result).not.toBeNull();
    expect(result!.buyerCounts).toEqual({
      locationCount: 3,
      companyCount: 2,
      taggedCustomerCount: 0,
    });
    expect(result!.buyerAccountCount).toBe(3);
  });

  it("counts TAGGED_CUSTOMER-kind accounts correctly", async () => {
    await sql`
      INSERT INTO "BuyerAccount" ("shopId", kind, name, "customerId", "createdAt", "updatedAt")
      VALUES
        (${testShopId}, 'TAGGED_CUSTOMER', 'Customer 1', 'gid://shopify/Customer/1', NOW(), NOW()),
        (${testShopId}, 'TAGGED_CUSTOMER', 'Customer 2', 'gid://shopify/Customer/2', NOW(), NOW()),
        (${testShopId}, 'TAGGED_CUSTOMER', 'Customer 3', 'gid://shopify/Customer/3', NOW(), NOW())
    `;

    const result = await fetchShopOnboardingData(sql, TEST_SHOP_DOMAIN);

    expect(result).not.toBeNull();
    expect(result!.buyerCounts).toEqual({
      locationCount: 0,
      companyCount: 0,
      taggedCustomerCount: 3,
    });
    expect(result!.buyerAccountCount).toBe(3);
  });

  it("counts both COMPANY and TAGGED_CUSTOMER accounts correctly", async () => {
    await sql`
      INSERT INTO "BuyerAccount" ("shopId", kind, name, "companyId", "companyLocationId", "createdAt", "updatedAt")
      VALUES
        (${testShopId}, 'COMPANY', 'Company A - Location 1', 'gid://shopify/Company/1', 'gid://shopify/CompanyLocation/1', NOW(), NOW()),
        (${testShopId}, 'COMPANY', 'Company A - Location 2', 'gid://shopify/Company/1', 'gid://shopify/CompanyLocation/2', NOW(), NOW())
    `;
    await sql`
      INSERT INTO "BuyerAccount" ("shopId", kind, name, "customerId", "createdAt", "updatedAt")
      VALUES
        (${testShopId}, 'TAGGED_CUSTOMER', 'Customer 1', 'gid://shopify/Customer/1', NOW(), NOW())
    `;

    const result = await fetchShopOnboardingData(sql, TEST_SHOP_DOMAIN);

    expect(result).not.toBeNull();
    expect(result!.buyerCounts).toEqual({
      locationCount: 2,
      companyCount: 1,
      taggedCustomerCount: 1,
    });
    expect(result!.buyerAccountCount).toBe(3);
  });

  it("counts tag rules from AccountSource correctly", async () => {
    await sql`
      INSERT INTO "AccountSource" ("shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")
      VALUES
        (${testShopId}, 'net30', 30, NOW(), NOW()),
        (${testShopId}, 'wholesale', 45, NOW(), NOW())
    `;

    const result = await fetchShopOnboardingData(sql, TEST_SHOP_DOMAIN);

    expect(result).not.toBeNull();
    expect(result!.tagRuleCount).toBe(2);
  });

  it("returns null for non-existent shop", async () => {
    const result = await fetchShopOnboardingData(sql, `test-nonexistent-${TEST_SUFFIX}.myshopify.com`);

    expect(result).toBeNull();
  });
});
