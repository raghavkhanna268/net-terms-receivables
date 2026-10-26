import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

/**
 * #292: Currency gate tests for app.imports loader and action.
 *
 * Tests verify that when a shop's currency is not supported (non-INR, NULL, XXX):
 * - The loader returns notSupported: true (no preview shown)
 * - The action rejects imports with "Only INR currency is supported"
 */

const createMockSqlFn = () =>
  vi.fn().mockImplementation(() => Promise.resolve([]));

const mockSql = Object.assign(createMockSqlFn(), {
  json: vi.fn((v: unknown) => v),
  array: vi.fn((arr: unknown[]) => arr),
  unsafe: vi.fn((s: string) => s),
  begin: vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    const txSql = Object.assign(createMockSqlFn(), {
      json: vi.fn((v: unknown) => v),
      array: vi.fn((arr: unknown[]) => arr),
    });
    return cb(txSql);
  }),
});

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
  getRequestWaitUntil: vi.fn(() => () => {}),
}));

vi.mock("~/services/access-log.server", () => ({
  recordAccess: vi.fn(),
  getActorFromSessionToken: vi.fn().mockReturnValue("test-actor"),
}));

vi.mock("~/services/matcher.server", () => ({
  runMatcher: vi.fn().mockResolvedValue({
    paymentsProcessed: 0,
    matchesCreated: 0,
    highConfidenceMatches: 0,
    hasMore: false,
  }),
  MAX_PAYMENTS_PER_REQUEST: 100,
}));

const TEST_SHOP = "test-imports-gate.myshopify.com";
const TEST_SHOP_ID = "shop-imports-123";

describe("#292 currency gate on /app/imports", () => {
  function createLoaderArgs(): LoaderFunctionArgs {
    const url = new URL("https://example.com/app/imports");
    return {
      request: new Request(url.toString()),
      context: {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: TEST_SHOP },
              sessionToken: "test-token",
            }),
          },
        },
        cloudflare: {
          env: {},
          ctx: { waitUntil: vi.fn() },
        },
      },
      params: {},
    } as unknown as LoaderFunctionArgs;
  }

  function createActionArgs(body: unknown): ActionFunctionArgs {
    const url = new URL("https://example.com/app/imports");
    return {
      request: new Request(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      context: {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: TEST_SHOP },
            }),
          },
        },
        cloudflare: {
          env: {},
          ctx: { waitUntil: vi.fn() },
        },
      },
      params: {},
    } as unknown as ActionFunctionArgs;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  function setupSqlMock(storedCurrency: string | null) {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("?");

      if (query.includes("SELECT id, currency FROM") && query.includes("Shop")) {
        return Promise.resolve([
          { id: TEST_SHOP_ID, currency: storedCurrency },
        ]);
      }
      return Promise.resolve([]);
    });
  }

  const MONEY_KEY_PATTERNS = [
    /balance/i,
    /amount/i,
    /outstanding/i,
    /paise/i,
    /total(?!Count)/i,
  ];

  function assertNoMoneyKeysInPayload(serialized: string) {
    for (const pattern of MONEY_KEY_PATTERNS) {
      const match = serialized.match(new RegExp(`"[^"]*${pattern.source}[^"]*"\\s*:\\s*[^n]`, "i"));
      if (match && !match[0].includes("null")) {
        throw new Error(`Serialized payload contains money key with value matching ${pattern}: ${match[0]}`);
      }
    }
  }

  describe("loader", () => {
    it("USD shop: notSupported=true, preview disabled", async () => {
      setupSqlMock("USD");

      const { loader } = await import("../app.imports");
      const result = await loader(createLoaderArgs());

      expect(result.notSupported).toBe(true);
      expect(result.shopCurrency).toBe("USD");

      // Verify serialized payload has no money keys with values
      const serialized = JSON.stringify(result);
      assertNoMoneyKeysInPayload(serialized);
    });

    it("XXX (unknown) shop: notSupported=true, fail-closed", async () => {
      setupSqlMock("XXX");

      const { loader } = await import("../app.imports");
      const result = await loader(createLoaderArgs());

      expect(result.notSupported).toBe(true);
      expect(result.shopCurrency).toBe("XXX");

      // Verify serialized payload has no money keys with values
      const serialized = JSON.stringify(result);
      assertNoMoneyKeysInPayload(serialized);
    });

    it("NULL currency: notSupported=true, fail-closed", async () => {
      setupSqlMock(null);

      const { loader } = await import("../app.imports");
      const result = await loader(createLoaderArgs());

      expect(result.notSupported).toBe(true);
      expect(result.shopCurrency).toBe("XXX");

      // Verify serialized payload has no money keys with values
      const serialized = JSON.stringify(result);
      assertNoMoneyKeysInPayload(serialized);
    });

    it("INR shop: notSupported=false, preview enabled", async () => {
      setupSqlMock("INR");

      const { loader } = await import("../app.imports");
      const result = await loader(createLoaderArgs());

      expect(result.notSupported).toBe(false);
      expect(result.shopCurrency).toBe("INR");
    });
  });

  describe("action", () => {
    const validImportPayload = {
      bank: "HDFC",
      fileName: "test.csv",
      credits: [
        {
          date: "2026-10-01",
          amountPaise: 100000,
          rail: "NEFT",
          narration: "TEST PAYMENT",
        },
      ],
    };

    it("USD shop: rejects import with 'Only INR currency is supported'", async () => {
      setupSqlMock("USD");

      const { action } = await import("../app.imports");
      const response = await action(createActionArgs(validImportPayload));
      const result = await response.json() as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Only INR currency is supported for bank imports");
    });

    it("XXX shop: rejects import, fail-closed", async () => {
      setupSqlMock("XXX");

      const { action } = await import("../app.imports");
      const response = await action(createActionArgs(validImportPayload));
      const result = await response.json() as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Only INR currency is supported for bank imports");
    });

    it("NULL currency: rejects import, fail-closed", async () => {
      setupSqlMock(null);

      const { action } = await import("../app.imports");
      const response = await action(createActionArgs(validImportPayload));
      const result = await response.json() as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Only INR currency is supported for bank imports");
    });
  });
});
