/**
 * Database integration tests for plan cache resolution (T1).
 *
 * Tests legacy cached plan_key values (free/scale) are correctly
 * resolved to the new T1 plan keys (none/unlimited).
 *
 * Sequential DB tests with test-* domains.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

// Mock adminGraphQL before importing plan.server
vi.mock("../drain/admin-client.server", () => ({
  adminGraphQL: vi.fn(),
}));

// Mock Sentry
vi.mock("~/lib/sentry", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  captureExceptionWithTags: vi.fn(),
}));

// Import after mocks are set up
import { adminGraphQL as _adminGraphQL } from "../drain/admin-client.server";
import { resolvePlan, getPlanByShopId } from "../plan.server";

const adminGraphQL = _adminGraphQL as ReturnType<typeof vi.fn>;

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("Legacy cached plan_key values (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-plan-cache";
  const TEST_SHOP_FREE_ID = `shop-test-free-${TEST_SUFFIX}`;
  const TEST_SHOP_FREE_DOMAIN = `test-free-${TEST_SUFFIX}.myshopify.com`;
  const TEST_SHOP_SCALE_ID = `shop-test-scale-${TEST_SUFFIX}`;
  const TEST_SHOP_SCALE_DOMAIN = `test-scale-${TEST_SUFFIX}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop with legacy 'free' plan_key
    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, plan_cached_at, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_FREE_ID}, ${TEST_SHOP_FREE_DOMAIN}, 'USD', 'UTC', 'free', NOW(), NOW(), NOW())
    `;

    // Create test shop with legacy 'scale' plan_key
    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, plan_cached_at, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_SCALE_ID}, ${TEST_SHOP_SCALE_DOMAIN}, 'USD', 'UTC', 'scale', NOW(), NOW(), NOW())
    `;
  });

  afterAll(async () => {
    // Clean up test shops
    await sql`DELETE FROM "Shop" WHERE id IN (${TEST_SHOP_FREE_ID}, ${TEST_SHOP_SCALE_ID})`;
    await sql.end();
  });

  it("resolves cached 'free' plan_key to 'none' via getPlanByShopId", async () => {
    const plan = await getPlanByShopId(sql, TEST_SHOP_FREE_ID);

    expect(plan.key).toBe("none");
    expect(plan.limits.companies).toBe(0);
  });

  it("resolves cached 'scale' plan_key to 'unlimited' via getPlanByShopId", async () => {
    const plan = await getPlanByShopId(sql, TEST_SHOP_SCALE_ID);

    expect(plan.key).toBe("unlimited");
    expect(plan.limits.companies).toBe(-1);
  });

  it("resolves cached 'free' through full resolvePlan path", async () => {
    // Mock adminGraphQL to fail so we use cached plan
    adminGraphQL.mockResolvedValueOnce({
      success: false,
      error: "Simulated error",
      retryable: false,
    });

    const result = await resolvePlan(sql, TEST_SHOP_FREE_DOMAIN, true);

    expect(result.plan.key).toBe("none");
    expect(result.fromCache).toBe(true);
  });

  it("resolves cached 'scale' through full resolvePlan path", async () => {
    // Mock adminGraphQL to fail so we use cached plan
    adminGraphQL.mockResolvedValueOnce({
      success: false,
      error: "Simulated error",
      retryable: false,
    });

    const result = await resolvePlan(sql, TEST_SHOP_SCALE_DOMAIN, true);

    expect(result.plan.key).toBe("unlimited");
    expect(result.fromCache).toBe(true);
  });
});
