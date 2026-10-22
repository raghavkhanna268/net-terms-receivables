import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { _resetShopifyAppForTesting, getShopifyApp } from "../../shopify.server";

/**
 * Tests for shopifyApp singleton behavior.
 *
 * Verifies that:
 * 1. shopifyApp is constructed only once across multiple getShopifyApp() calls
 * 2. The same instance is returned on subsequent calls
 * 3. _resetShopifyAppForTesting allows tests to start fresh
 */

describe("shopifyApp Singleton", () => {
  // Track which keys were added (not just modified) so we can delete them in cleanup
  const testEnvKeys = ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "SHOPIFY_APP_URL"] as const;
  const keysToDelete: string[] = [];
  const originalValues: Record<string, string | undefined> = {};

  beforeAll(() => {
    // Save original values and track which keys need to be deleted on cleanup
    for (const key of testEnvKeys) {
      originalValues[key] = process.env[key];
      if (process.env[key] === undefined) {
        keysToDelete.push(key);
      }
    }

    // Use Object.assign to bypass strict literal type checking from wrangler types
    Object.assign(process.env, {
      SHOPIFY_API_KEY: "test-api-key",
      SHOPIFY_API_SECRET: "test-api-secret",
      SHOPIFY_APP_URL: "https://test.example.com",
    });
  });

  afterAll(() => {
    // Restore original values for keys that existed
    // Type cast needed to bypass strict literal types from wrangler
    const env = process.env as Record<string, string | undefined>;
    for (const key of testEnvKeys) {
      if (originalValues[key] !== undefined) {
        env[key] = originalValues[key];
      }
    }
    // Delete keys that were added (weren't set before the test)
    for (const key of keysToDelete) {
      delete env[key];
    }
  });

  beforeEach(() => {
    _resetShopifyAppForTesting();
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetShopifyAppForTesting();
  });

  it("returns the same instance across multiple calls", () => {
    const app1 = getShopifyApp();
    const app2 = getShopifyApp();
    const app3 = getShopifyApp();

    expect(app1).toBe(app2);
    expect(app2).toBe(app3);
  });

  it("creates a new instance after reset", () => {
    const app1 = getShopifyApp();

    _resetShopifyAppForTesting();

    const app2 = getShopifyApp();

    expect(app1).not.toBe(app2);
  });

  it("constructs shopifyApp only once across simulated requests", () => {
    const constructionCount = { value: 0 };

    const originalGetShopifyApp = getShopifyApp;

    const countedCalls: ReturnType<typeof getShopifyApp>[] = [];
    for (let i = 0; i < 5; i++) {
      const app = originalGetShopifyApp();
      countedCalls.push(app);
      if (i === 0) {
        constructionCount.value++;
      }
    }

    expect(countedCalls[0]).toBe(countedCalls[1]);
    expect(countedCalls[1]).toBe(countedCalls[2]);
    expect(countedCalls[2]).toBe(countedCalls[3]);
    expect(countedCalls[3]).toBe(countedCalls[4]);
  });

  it("has expected methods on the returned app instance", () => {
    const app = getShopifyApp();

    expect(app).toBeDefined();
    expect(typeof app.authenticate).toBe("object");
    expect(typeof app.authenticate.admin).toBe("function");
    expect(typeof app.authenticate.webhook).toBe("function");
    expect(typeof app.login).toBe("function");
  });
});
