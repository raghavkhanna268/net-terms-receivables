/**
 * #292: DB integration tests for syncShopInfo currency flip safety.
 *
 * These tests drive the real syncShopInfo path with a fake admin GraphQL client
 * to verify that:
 * - USD shop with financial rows: currency stays USD, no INR shop_config write, timezone updates
 * - USD shop with zero rows: flips to INR, shop_config write happens
 * - XXX stored with rows: blocked (fail-closed)
 * - XXX stored with zero rows: flips to INR, writes shop_config
 *
 * Note: NULL stored currency cases are tested via unit tests on decideShopCurrencyUpdate
 * since Shop.currency is NOT NULL in the DB schema.
 *
 * Requires a running PostgreSQL instance.
 * Run with: TEST_DATABASE_URL=postgresql://... npm test -- after-auth-syncshopinfo-db
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { shopHash } from "~/lib/log.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

// Track GraphQL calls (for shop_config writes)
const graphqlCalls: Array<{ query: string; variables?: Record<string, unknown> }> = [];

// Track captured console.log calls for safeLog assertions
let consoleLogCalls: string[] = [];

// Mock the request context to return our test SQL client
let testSql: ReturnType<typeof postgres> | null = null;
vi.mock("../request-context.server", () => ({
  getRequestSql: vi.fn(() => {
    if (!testSql) {
      throw new Error("testSql not initialized");
    }
    return testSql;
  }),
}));

// Mock shop-config.server to track metafield writes
vi.mock("~/services/shop-config.server", () => ({
  writeShopConfigMetafield: vi.fn(async (_admin: unknown, _shopId: string, currency: string) => {
    graphqlCalls.push({
      query: "metafieldsSet",
      variables: { currency },
    });
    return { success: true };
  }),
}));

describeWithDb("syncShopInfo currency flip safety (#292) - real path", () => {
  const TEST_SUFFIX = `test-${Date.now().toString(36)}-syncinfo`;

  const SHOP_WITH_INVOICE = `shop-invoice-${TEST_SUFFIX}`;
  const SHOP_EMPTY = `shop-empty-${TEST_SUFFIX}`;
  const SHOP_XXX = `shop-xxx-${TEST_SUFFIX}`;
  const SHOP_XXX_ZERO = `shop-xxx-zero-${TEST_SUFFIX}`;

  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    testSql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shops (use example.com to satisfy logging allowlist)
    await testSql`
      INSERT INTO "Shop" (id, domain, currency, timezone, "createdAt", "updatedAt")
      VALUES
        (${SHOP_WITH_INVOICE}, ${SHOP_WITH_INVOICE + ".example.com"}, 'USD', 'America/New_York', NOW(), NOW()),
        (${SHOP_EMPTY}, ${SHOP_EMPTY + ".example.com"}, 'USD', 'America/New_York', NOW(), NOW()),
        (${SHOP_XXX}, ${SHOP_XXX + ".example.com"}, 'XXX', 'America/New_York', NOW(), NOW()),
        (${SHOP_XXX_ZERO}, ${SHOP_XXX_ZERO + ".example.com"}, 'XXX', 'America/New_York', NOW(), NOW())
    `;

    // Create BuyerAccounts for shops that need invoices
    const BUYER_INVOICE = `buyer-invoice-${TEST_SUFFIX}`;
    const BUYER_XXX = `buyer-xxx-${TEST_SUFFIX}`;
    const CUSTOMER_INVOICE = `gid://shopify/Customer/invoice-${TEST_SUFFIX}`;
    const CUSTOMER_XXX = `gid://shopify/Customer/xxx-${TEST_SUFFIX}`;
    await testSql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "customerId", name, "createdAt", "updatedAt")
      VALUES 
        (${BUYER_INVOICE}, ${SHOP_WITH_INVOICE}, 'TAGGED_CUSTOMER', ${CUSTOMER_INVOICE}, 'Test Buyer', NOW(), NOW()),
        (${BUYER_XXX}, ${SHOP_XXX}, 'TAGGED_CUSTOMER', ${CUSTOMER_XXX}, 'Test Buyer XXX', NOW(), NOW())
    `;

    // Create Invoices for shops that need financial rows
    const ORDER_INVOICE = `gid://shopify/Order/invoice-${TEST_SUFFIX}`;
    const ORDER_XXX = `gid://shopify/Order/xxx-${TEST_SUFFIX}`;
    await testSql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, "issuedAt", "createdAt", "updatedAt")
      VALUES 
        (${`inv-invoice-${TEST_SUFFIX}`}, ${SHOP_WITH_INVOICE}, ${BUYER_INVOICE}, ${ORDER_INVOICE}, '#1001', 1000, 1000, NOW(), NOW(), NOW()),
        (${`inv-xxx-${TEST_SUFFIX}`}, ${SHOP_XXX}, ${BUYER_XXX}, ${ORDER_XXX}, '#1002', 2000, 2000, NOW(), NOW(), NOW())
    `;
  });

  afterAll(async () => {
    if (testSql) {
      // Clean up in reverse order of creation
      await testSql`DELETE FROM "Invoice" WHERE id IN (${`inv-invoice-${TEST_SUFFIX}`}, ${`inv-xxx-${TEST_SUFFIX}`})`;
      await testSql`DELETE FROM "BuyerAccount" WHERE id IN (${`buyer-invoice-${TEST_SUFFIX}`}, ${`buyer-xxx-${TEST_SUFFIX}`})`;
      await testSql`DELETE FROM "Shop" WHERE id IN (${SHOP_WITH_INVOICE}, ${SHOP_EMPTY}, ${SHOP_XXX}, ${SHOP_XXX_ZERO})`;
      await testSql.end();
      testSql = null;
    }
  });

  beforeEach(() => {
    consoleLogCalls = [];
    graphqlCalls.length = 0;
    // Spy on console.log to capture safeLog output (info level uses console.log)
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      consoleLogCalls.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    vi.clearAllMocks();
  });

  /**
   * Parse captured console logs and find a safeLog event by name.
   * safeLog outputs single-line JSON with {"event": "...", ...}
   */
  function findSafeLogEvent(eventName: string): Record<string, unknown> | undefined {
    for (const logLine of consoleLogCalls) {
      try {
        const parsed = JSON.parse(logLine);
        if (parsed.event === eventName) {
          return parsed;
        }
      } catch {
        // Not JSON, skip
      }
    }
    return undefined;
  }

  function createMockAdmin(currencyCode: string, timezone: string = "Asia/Kolkata") {
    return {
      graphql: vi.fn(async (query: string) => {
        graphqlCalls.push({ query });
        return {
          json: async () => ({
            data: {
              shop: {
                id: "gid://shopify/Shop/test",
                ianaTimezone: timezone,
                currencyCode,
              },
            },
          }),
        };
      }),
    };
  }

  it("USD shop with financial rows: syncShopInfo with INR keeps USD, skips shop_config, updates timezone", async () => {
    const { _syncShopInfoForTesting: syncShopInfo } = await import("../after-auth.server");
    
    const mockAdmin = createMockAdmin("INR", "Asia/Kolkata");
    const shopDomain = SHOP_WITH_INVOICE + ".example.com";

    // Verify initial state
    const [beforeShop] = await testSql!<{ currency: string; timezone: string }[]>`
      SELECT currency, timezone FROM "Shop" WHERE id = ${SHOP_WITH_INVOICE}
    `;
    expect(beforeShop.currency).toBe("USD");
    expect(beforeShop.timezone).toBe("America/New_York");

    // Call syncShopInfo
    await syncShopInfo(shopDomain, mockAdmin);

    // Verify Shop.currency stays USD
    const [afterShop] = await testSql!<{ currency: string; timezone: string }[]>`
      SELECT currency, timezone FROM "Shop" WHERE id = ${SHOP_WITH_INVOICE}
    `;
    expect(afterShop.currency).toBe("USD");

    // Verify timezone was updated
    expect(afterShop.timezone).toBe("Asia/Kolkata");

    // Verify no INR shop_config metafield write happened
    const metafieldWrites = graphqlCalls.filter(c => c.query === "metafieldsSet");
    expect(metafieldWrites.length).toBe(0);

    // Verify currency_flip_blocked_on_auth was logged with shopHash, no PII
    const blockedLog = findSafeLogEvent("currency_flip_blocked_on_auth");
    expect(blockedLog).toBeDefined();
    expect(blockedLog!.shopHash).toBeDefined();
    expect(blockedLog!.shopHash).toBe(await shopHash(shopDomain));
    // Assert NO raw shop domain or PII in the log entry
    const logStr = JSON.stringify(blockedLog);
    expect(logStr).not.toContain(shopDomain);
    expect(logStr).not.toContain(".example.com");
    // Should only have event and shopHash keys
    expect(Object.keys(blockedLog!).sort()).toEqual(["event", "shopHash"]);
  });

  it("USD shop with zero financial rows: syncShopInfo with INR flips to INR and writes shop_config", async () => {
    const { _syncShopInfoForTesting: syncShopInfo } = await import("../after-auth.server");

    const mockAdmin = createMockAdmin("INR", "Europe/London");

    // Verify initial state
    const [beforeShop] = await testSql!<{ currency: string; timezone: string }[]>`
      SELECT currency, timezone FROM "Shop" WHERE id = ${SHOP_EMPTY}
    `;
    expect(beforeShop.currency).toBe("USD");

    // Call syncShopInfo
    await syncShopInfo(SHOP_EMPTY + ".example.com", mockAdmin);

    // Verify Shop.currency is now INR
    const [afterShop] = await testSql!<{ currency: string; timezone: string }[]>`
      SELECT currency, timezone FROM "Shop" WHERE id = ${SHOP_EMPTY}
    `;
    expect(afterShop.currency).toBe("INR");

    // Verify timezone was updated
    expect(afterShop.timezone).toBe("Europe/London");

    // Verify INR shop_config metafield write happened
    const metafieldWrites = graphqlCalls.filter(c => c.query === "metafieldsSet");
    expect(metafieldWrites.length).toBe(1);
    expect(metafieldWrites[0].variables?.currency).toBe("INR");

    // Verify currency_flip_blocked_on_auth was NOT logged
    const blockedLog = findSafeLogEvent("currency_flip_blocked_on_auth");
    expect(blockedLog).toBeUndefined();
  });

  it("XXX stored with financial rows: syncShopInfo with INR is blocked (fail-closed)", async () => {
    const { _syncShopInfoForTesting: syncShopInfo } = await import("../after-auth.server");

    const mockAdmin = createMockAdmin("INR", "Pacific/Auckland");
    const shopDomain = SHOP_XXX + ".example.com";

    // Verify initial state
    const [beforeShop] = await testSql!<{ currency: string; timezone: string }[]>`
      SELECT currency, timezone FROM "Shop" WHERE id = ${SHOP_XXX}
    `;
    expect(beforeShop.currency).toBe("XXX");

    // Call syncShopInfo
    await syncShopInfo(shopDomain, mockAdmin);

    // Verify Shop.currency stays XXX (fail-closed)
    const [afterShop] = await testSql!<{ currency: string; timezone: string }[]>`
      SELECT currency, timezone FROM "Shop" WHERE id = ${SHOP_XXX}
    `;
    expect(afterShop.currency).toBe("XXX");

    // Verify timezone was still updated
    expect(afterShop.timezone).toBe("Pacific/Auckland");

    // Verify no shop_config metafield write happened
    const metafieldWrites = graphqlCalls.filter(c => c.query === "metafieldsSet");
    expect(metafieldWrites.length).toBe(0);

    // Verify currency_flip_blocked_on_auth was logged with shopHash, no PII
    const blockedLog = findSafeLogEvent("currency_flip_blocked_on_auth");
    expect(blockedLog).toBeDefined();
    expect(blockedLog!.shopHash).toBeDefined();
    expect(blockedLog!.shopHash).toBe(await shopHash(shopDomain));
    // Assert NO raw shop domain or PII in the log entry
    const logStr = JSON.stringify(blockedLog);
    expect(logStr).not.toContain(shopDomain);
    expect(logStr).not.toContain(".example.com");
    // Should only have event and shopHash keys
    expect(Object.keys(blockedLog!).sort()).toEqual(["event", "shopHash"]);
  });

  it("XXX stored with zero financial rows: syncShopInfo with INR flips to INR and writes shop_config", async () => {
    const { _syncShopInfoForTesting: syncShopInfo } = await import("../after-auth.server");

    const mockAdmin = createMockAdmin("INR", "Asia/Tokyo");

    // Verify initial state: currency is XXX and no invoices
    const [beforeShop] = await testSql!<{ currency: string; timezone: string }[]>`
      SELECT currency, timezone FROM "Shop" WHERE id = ${SHOP_XXX_ZERO}
    `;
    expect(beforeShop.currency).toBe("XXX");

    // Call syncShopInfo
    await syncShopInfo(SHOP_XXX_ZERO + ".example.com", mockAdmin);

    // Verify Shop.currency flipped to INR
    const [afterShop] = await testSql!<{ currency: string; timezone: string }[]>`
      SELECT currency, timezone FROM "Shop" WHERE id = ${SHOP_XXX_ZERO}
    `;
    expect(afterShop.currency).toBe("INR");

    // Verify timezone was updated
    expect(afterShop.timezone).toBe("Asia/Tokyo");

    // Verify INR shop_config metafield write happened
    const metafieldWrites = graphqlCalls.filter(c => c.query === "metafieldsSet");
    expect(metafieldWrites.length).toBe(1);
    expect(metafieldWrites[0].variables?.currency).toBe("INR");

    // Verify currency_flip_blocked_on_auth was NOT logged (flip succeeded)
    const blockedLog = findSafeLogEvent("currency_flip_blocked_on_auth");
    expect(blockedLog).toBeUndefined();
  });
});
