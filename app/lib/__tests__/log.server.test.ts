import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac, createHash } from "node:crypto";
import { safeLog, toErrorCode, shopHash, redactString } from "../log.server";
import { requestContext, type RequestStore } from "../request-context.server";

const TEST_LOG_HASH_KEY = "test-key-for-unit-tests-only-not-real";

function withRequestContext<T>(
  store: Partial<RequestStore>,
  fn: () => T
): T {
  return requestContext.run(
    {
      getSql: () => {
        throw new Error("SQL not available in this test");
      },
      ...store,
    },
    fn
  );
}

describe("log.server", () => {
  describe("safeLog", () => {
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let consoleDebugSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      consoleDebugSpy.mockRestore();
    });

    it("outputs single-line JSON with event name", () => {
      safeLog("info", "test_event", { shopId: "shop-123" });

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const output = consoleLogSpy.mock.calls[0][0];
      expect(output).toContain('"event":"test_event"');
      expect(output).toContain('"shopId":"shop-123"');
      expect(output).not.toContain("\n");
    });

    it("uses correct log level", () => {
      safeLog("debug", "debug_event", {});
      safeLog("info", "info_event", {});
      safeLog("warn", "warn_event", {});
      safeLog("error", "error_event", {});

      expect(consoleDebugSpy).toHaveBeenCalledOnce();
      expect(consoleLogSpy).toHaveBeenCalledOnce();
      expect(consoleWarnSpy).toHaveBeenCalledOnce();
      expect(consoleErrorSpy).toHaveBeenCalledOnce();
    });

    describe("allowlisted keys pass through", () => {
      it("allows shopId", () => {
        safeLog("info", "test", { shopId: "abc-123" });
        expect(consoleLogSpy.mock.calls[0][0]).toContain('"shopId":"abc-123"');
      });

      it("allows shopHash", () => {
        safeLog("info", "test", { shopHash: "abc123def456" });
        expect(consoleLogSpy.mock.calls[0][0]).toContain('"shopHash":"abc123def456"');
      });

      it("allows webhookId", () => {
        safeLog("info", "test", { webhookId: "wh-123" });
        expect(consoleLogSpy.mock.calls[0][0]).toContain('"webhookId":"wh-123"');
      });

      it("allows orderGid", () => {
        safeLog("info", "test", { orderGid: "gid://shopify/Order/123" });
        expect(consoleLogSpy.mock.calls[0][0]).toContain('"orderGid":"gid://shopify/Order/123"');
      });

      it("allows topic", () => {
        safeLog("info", "test", { topic: "ORDERS_CREATE" });
        expect(consoleLogSpy.mock.calls[0][0]).toContain('"topic":"ORDERS_CREATE"');
      });

      it("allows status", () => {
        safeLog("info", "test", { status: "success" });
        expect(consoleLogSpy.mock.calls[0][0]).toContain('"status":"success"');
      });

      it("allows errorCode", () => {
        safeLog("info", "test", { errorCode: "invalid_grant" });
        expect(consoleLogSpy.mock.calls[0][0]).toContain('"errorCode":"invalid_grant"');
      });

      it("allows count fields", () => {
        safeLog("info", "test", { count: 5, processedCount: 10 });
        expect(consoleLogSpy.mock.calls[0][0]).toContain('"count":5');
        expect(consoleLogSpy.mock.calls[0][0]).toContain('"processedCount":10');
      });

      it("allows boolean fields", () => {
        safeLog("info", "test", { success: true, retryable: false });
        expect(consoleLogSpy.mock.calls[0][0]).toContain('"success":true');
        expect(consoleLogSpy.mock.calls[0][0]).toContain('"retryable":false');
      });

      it("allows durationMs", () => {
        safeLog("info", "test", { durationMs: 1500 });
        expect(consoleLogSpy.mock.calls[0][0]).toContain('"durationMs":1500');
      });
    });

    describe("non-allowlisted keys are redacted", () => {
      it("redacts unknown string keys", () => {
        safeLog("info", "test", { message: "Hello world" });
        expect(consoleLogSpy.mock.calls[0][0]).toContain('"message":"<redacted>"');
      });

      it("redacts shop domain value", () => {
        safeLog("info", "test", { shop: "test-shop.myshopify.com" });
        expect(consoleLogSpy.mock.calls[0][0]).toContain('"shop":"<redacted>"');
      });

      it("redacts numbers for unknown keys (could be money amounts per #174)", () => {
        safeLog("info", "test", { unknownNumber: 42 });
        expect(consoleLogSpy.mock.calls[0][0]).toContain('"unknownNumber":"<redacted>"');
      });

      it("redacts amount/balance/total fields (money values per #174)", () => {
        safeLog("info", "test", { amount: 125000 });
        expect(consoleLogSpy.mock.calls[0][0]).toContain('"amount":"<redacted>"');
      });

      it("redacts outstandingPaise field (money value)", () => {
        safeLog("info", "test", { outstandingPaise: 9900 });
        expect(consoleLogSpy.mock.calls[0][0]).toContain('"outstandingPaise":"<redacted>"');
      });

      it("redacts creditLimit field (money value)", () => {
        safeLog("info", "test", { creditLimit: 50000 });
        expect(consoleLogSpy.mock.calls[0][0]).toContain('"creditLimit":"<redacted>"');
      });

      it("redacts totalAmount field (money value)", () => {
        safeLog("info", "test", { totalAmount: 100000 });
        expect(consoleLogSpy.mock.calls[0][0]).toContain('"totalAmount":"<redacted>"');
      });

      it("preserves booleans for unknown keys", () => {
        safeLog("info", "test", { unknownBool: true });
        expect(consoleLogSpy.mock.calls[0][0]).toContain('"unknownBool":true');
      });
    });

    describe("sensitive value patterns are redacted", () => {
      it("redacts myshopify.com in allowlisted string fields", () => {
        safeLog("info", "test", { reason: "shop test.myshopify.com not found" });
        expect(consoleLogSpy.mock.calls[0][0]).toContain('"reason":"<redacted>"');
      });

      it("redacts email patterns", () => {
        safeLog("info", "test", { reason: "user@example.com" });
        expect(consoleLogSpy.mock.calls[0][0]).toContain('"reason":"<redacted>"');
      });

      it("redacts Bearer tokens", () => {
        safeLog("info", "test", { reason: "Bearer shpat_abc123" });
        expect(consoleLogSpy.mock.calls[0][0]).toContain('"reason":"<redacted>"');
      });

      it("redacts shpat_ tokens in context", () => {
        safeLog("info", "test", { reason: "token shpat_abcdef123456" });
        // Token is redacted but surrounding text is preserved
        expect(consoleLogSpy.mock.calls[0][0]).toContain('"reason":"token <redacted>"');
      });

      it("redacts shpua_ tokens in context", () => {
        safeLog("info", "test", { reason: "token shpua_abcdef123456" });
        // Token is redacted but surrounding text is preserved
        expect(consoleLogSpy.mock.calls[0][0]).toContain('"reason":"token <redacted>"');
      });

      it("redacts shpss_ tokens in context", () => {
        safeLog("info", "test", { reason: "token shpss_abcdef123456" });
        // Token is redacted but surrounding text is preserved
        expect(consoleLogSpy.mock.calls[0][0]).toContain('"reason":"token <redacted>"');
      });

      it("redacts JWT-like patterns", () => {
        safeLog("info", "test", { reason: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U" });
        expect(consoleLogSpy.mock.calls[0][0]).toContain('"reason":"<redacted>"');
      });
    });

    describe("nested values", () => {
      it("handles nested objects - non-allowlisted keys are fully redacted", () => {
        safeLog("info", "test", {
          shopId: "shop-123",
          data: { secret: "should-be-redacted" },
        });
        const output = consoleLogSpy.mock.calls[0][0];
        expect(output).toContain('"shopId":"shop-123"');
        // 'data' is not allowlisted, so entire value is redacted
        expect(output).toContain('"data":"<redacted>"');
      });

      it("handles arrays", () => {
        safeLog("info", "test", {
          shopId: "shop-123",
          items: ["item1", "item2"],
        });
        const output = consoleLogSpy.mock.calls[0][0];
        expect(output).toContain('"shopId":"shop-123"');
        // Array items should be redacted since 'items' is not allowlisted
        expect(output).toContain("<redacted>");
      });
    });
  });

  describe("redactString", () => {
    it("redacts myshopify.com domains", () => {
      expect(redactString("shop test-shop.myshopify.com failed")).toBe(
        "shop <redacted> failed"
      );
    });

    it("redacts Bearer tokens", () => {
      expect(redactString("Authorization: Bearer shpat_abc123")).toBe(
        "Authorization: <redacted>"
      );
    });

    it("redacts shpat_ tokens", () => {
      expect(redactString("token=shpat_abcdefghijk")).toBe("token=<redacted>");
    });

    it("redacts email addresses", () => {
      expect(redactString("user user@example.com logged in")).toBe(
        "user <redacted> logged in"
      );
    });

    it("handles multiple patterns", () => {
      expect(
        redactString("shop test.myshopify.com token shpat_abc user@test.com")
      ).toBe("shop <redacted> token <redacted> <redacted>");
    });
  });

  describe("toErrorCode", () => {
    it("returns unknown for null", () => {
      expect(toErrorCode(null)).toBe("unknown");
    });

    it("returns unknown for undefined", () => {
      expect(toErrorCode(undefined)).toBe("unknown");
    });

    it("extracts code from error object", () => {
      expect(toErrorCode({ code: "ECONNREFUSED" })).toBe("ECONNREFUSED");
    });

    it("extracts errorCode from object", () => {
      expect(toErrorCode({ errorCode: "invalid_grant" })).toBe("invalid_grant");
    });

    it("uses name from Error object", () => {
      const err = new TypeError("test");
      expect(toErrorCode(err)).toBe("TypeError");
    });

    it("maps connection_refused", () => {
      const err = new Error("ECONNREFUSED: connection refused");
      expect(toErrorCode(err)).toBe("connection_refused");
    });

    it("maps timeout", () => {
      const err = new Error("Request timeout");
      expect(toErrorCode(err)).toBe("timeout");
    });

    it("maps invalid_grant", () => {
      const err = new Error("invalid_grant error");
      expect(toErrorCode(err)).toBe("invalid_grant");
    });

    it("maps access_denied", () => {
      const err = new Error("ACCESS_DENIED");
      expect(toErrorCode(err)).toBe("access_denied");
    });

    it("maps throttled", () => {
      const err = new Error("THROTTLED by API");
      expect(toErrorCode(err)).toBe("throttled");
    });

    it("maps unique constraint violation", () => {
      const err = new Error("unique constraint violation");
      expect(toErrorCode(err)).toBe("pg_unique_violation");
    });

    it("returns error name for unknown errors", () => {
      class CustomError extends Error {
        name = "CustomError";
      }
      expect(toErrorCode(new CustomError("test"))).toBe("CustomError");
    });

    it("returns short strings as-is", () => {
      expect(toErrorCode("network_error")).toBe("network_error");
    });

    it("returns string_error for long strings", () => {
      expect(toErrorCode("This is a very long error message with spaces")).toBe(
        "string_error"
      );
    });
  });

  describe("shopHash", () => {
    describe("with key present", () => {
      it("returns 12-character lowercase hex string", async () => {
        const hash = await withRequestContext(
          { env: { LOG_HASH_KEY: TEST_LOG_HASH_KEY } },
          () => shopHash("test-shop.myshopify.com")
        );
        expect(hash).toHaveLength(12);
        expect(hash).toMatch(/^[0-9a-f]{12}$/);
      });

      it("is case-insensitive (lowercases domain before hashing)", async () => {
        const hash1 = await withRequestContext(
          { env: { LOG_HASH_KEY: TEST_LOG_HASH_KEY } },
          () => shopHash("Test-Shop.myshopify.com")
        );
        const hash2 = await withRequestContext(
          { env: { LOG_HASH_KEY: TEST_LOG_HASH_KEY } },
          () => shopHash("test-shop.myshopify.com")
        );
        expect(hash1).toBe(hash2);
      });

      it("produces different hashes for different domains", async () => {
        const hash1 = await withRequestContext(
          { env: { LOG_HASH_KEY: TEST_LOG_HASH_KEY } },
          () => shopHash("shop1.myshopify.com")
        );
        const hash2 = await withRequestContext(
          { env: { LOG_HASH_KEY: TEST_LOG_HASH_KEY } },
          () => shopHash("shop2.myshopify.com")
        );
        expect(hash1).not.toBe(hash2);
      });

      it("is deterministic", async () => {
        const hash1 = await withRequestContext(
          { env: { LOG_HASH_KEY: TEST_LOG_HASH_KEY } },
          () => shopHash("test.myshopify.com")
        );
        const hash2 = await withRequestContext(
          { env: { LOG_HASH_KEY: TEST_LOG_HASH_KEY } },
          () => shopHash("test.myshopify.com")
        );
        expect(hash1).toBe(hash2);
      });

      it("equals independently computed HMAC-SHA-256 prefix (node:crypto oracle)", async () => {
        const domain = "test-oracle.myshopify.com";
        const hash = await withRequestContext(
          { env: { LOG_HASH_KEY: TEST_LOG_HASH_KEY } },
          () => shopHash(domain)
        );

        const expectedHmac = createHmac("sha256", TEST_LOG_HASH_KEY)
          .update(domain.toLowerCase())
          .digest("hex")
          .slice(0, 12);

        expect(hash).toBe(expectedHmac);
      });

      it("does NOT equal the plain SHA-256 prefix of the domain", async () => {
        const domain = "test-sha256.myshopify.com";
        const hash = await withRequestContext(
          { env: { LOG_HASH_KEY: TEST_LOG_HASH_KEY } },
          () => shopHash(domain)
        );

        const plainSha256 = createHash("sha256")
          .update(domain.toLowerCase())
          .digest("hex")
          .slice(0, 12);

        expect(hash).not.toBe(plainSha256);
      });
    });

    describe("with key missing (fail closed)", () => {
      it("returns undefined when no request context", async () => {
        const hash = await shopHash("test.myshopify.com");
        expect(hash).toBeUndefined();
      });

      it("returns undefined when context has no env", async () => {
        const hash = await withRequestContext({}, () =>
          shopHash("test.myshopify.com")
        );
        expect(hash).toBeUndefined();
      });

      it("returns undefined when env has no LOG_HASH_KEY", async () => {
        const hash = await withRequestContext(
          { env: { CUSTOMER_PII_FIELDS: "1" } },
          () => shopHash("test.myshopify.com")
        );
        expect(hash).toBeUndefined();
      });

      it("returns undefined when LOG_HASH_KEY is empty string", async () => {
        const hash = await withRequestContext(
          { env: { LOG_HASH_KEY: "" } },
          () => shopHash("test.myshopify.com")
        );
        expect(hash).toBeUndefined();
      });

      it("safeLog omits shopHash field when key is missing", async () => {
        const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

        const hash = await shopHash("test.myshopify.com");
        safeLog("info", "test_event", { shopId: "id-123", shopHash: hash });

        const output = consoleLogSpy.mock.calls[0][0];
        const parsed = JSON.parse(output);

        expect(parsed.shopId).toBe("id-123");
        expect(parsed.shopHash).toBeUndefined();
        expect(output).not.toContain("shopHash");

        consoleLogSpy.mockRestore();
      });

      it("safeLog output has no plain SHA-256 hash anywhere when key missing", async () => {
        const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        const domain = "test-nofallback.myshopify.com";

        const plainSha256 = createHash("sha256")
          .update(domain.toLowerCase())
          .digest("hex")
          .slice(0, 12);

        const hash = await shopHash(domain);
        safeLog("info", "test_event", { shopId: "id-456", shopHash: hash });

        const output = consoleLogSpy.mock.calls[0][0];
        expect(output).not.toContain(plainSha256);

        consoleLogSpy.mockRestore();
      });
    });
  });

  describe("safeLog Promise detection", () => {
    it("throws when given an unawaited Promise for shopHash", () => {
      withRequestContext({ env: { LOG_HASH_KEY: TEST_LOG_HASH_KEY } }, () => {
        expect(() => {
          safeLog("info", "test_event", { shopHash: shopHash("test.myshopify.com") });
        }).toThrow('safeLog received unawaited Promise for key "shopHash" - did you forget to await?');
      });
    });

    it("throws descriptive error for any Promise value in allowlisted key", () => {
      expect(() => {
        safeLog("info", "test_event", { status: Promise.resolve("pending") });
      }).toThrow('safeLog received unawaited Promise for key "status" - did you forget to await?');
    });

    it("works correctly with awaited shopHash", async () => {
      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const hash = await withRequestContext(
        { env: { LOG_HASH_KEY: TEST_LOG_HASH_KEY } },
        () => shopHash("test-shop.myshopify.com")
      );
      safeLog("info", "test_event", { shopHash: hash });

      const output = consoleLogSpy.mock.calls[0][0];
      expect(output).toContain('"shopHash":"');

      const parsed = JSON.parse(output);
      expect(parsed.shopHash).toMatch(/^[0-9a-f]{12}$/);

      consoleLogSpy.mockRestore();
    });
  });

  describe("toErrorCode validation", () => {
    it("rejects domain-like strings as codes", () => {
      const err = { code: "test-acme.myshopify.com" };
      expect(toErrorCode(err)).toBe("unknown");
    });

    it("rejects email-like strings as codes", () => {
      const err = { code: "user@example.com" };
      expect(toErrorCode(err)).toBe("unknown");
    });

    it("rejects codes with spaces", () => {
      expect(toErrorCode("some error message")).toBe("string_error");
    });

    it("accepts valid snake_case codes", () => {
      const err = { code: "network_error" };
      expect(toErrorCode(err)).toBe("network_error");
    });

    it("accepts valid PascalCase codes", () => {
      const err = { name: "TypeError" };
      expect(toErrorCode(err)).toBe("TypeError");
    });
  });

  describe("Web Vitals allowlist keys (S23-30)", () => {
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
    });

    describe("metric key", () => {
      it("allows LCP", () => {
        safeLog("info", "test", { metric: "LCP" });
        const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
        expect(output.metric).toBe("LCP");
      });

      it("allows CLS", () => {
        safeLog("info", "test", { metric: "CLS" });
        const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
        expect(output.metric).toBe("CLS");
      });

      it("allows INP", () => {
        safeLog("info", "test", { metric: "INP" });
        const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
        expect(output.metric).toBe("INP");
      });

      it("redacts invalid metric name", () => {
        safeLog("info", "test", { metric: "FCP" });
        const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
        expect(output.metric).toBe("<redacted>");
      });

      it("redacts non-string metric", () => {
        safeLog("info", "test", { metric: 123 });
        const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
        expect(output.metric).toBe("<redacted>");
      });

      it("redacts metric with domain pattern", () => {
        safeLog("info", "test", { metric: "test.myshopify.com" });
        const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
        expect(output.metric).toBe("<redacted>");
      });
    });

    describe("value key", () => {
      it("allows valid numeric value", () => {
        safeLog("info", "test", { value: 2500 });
        const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
        expect(output.value).toBe(2500);
      });

      it("allows zero value", () => {
        safeLog("info", "test", { value: 0 });
        const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
        expect(output.value).toBe(0);
      });

      it("allows decimal value and rounds", () => {
        safeLog("info", "test", { value: 0.123456789 });
        const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
        expect(output.value).toBe(0.1235);
      });

      it("clamps value to max 60000", () => {
        safeLog("info", "test", { value: 100000 });
        const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
        expect(output.value).toBe(60000);
      });

      it("clamps negative value to 0", () => {
        safeLog("info", "test", { value: -100 });
        const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
        expect(output.value).toBe(0);
      });

      it("redacts non-number value", () => {
        safeLog("info", "test", { value: "2500" });
        const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
        expect(output.value).toBe("<redacted>");
      });

      it("redacts NaN", () => {
        safeLog("info", "test", { value: NaN });
        const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
        expect(output.value).toBe("<redacted>");
      });

      it("redacts Infinity", () => {
        safeLog("info", "test", { value: Infinity });
        const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
        expect(output.value).toBe("<redacted>");
      });
    });

    describe("rating key", () => {
      it("allows good", () => {
        safeLog("info", "test", { rating: "good" });
        const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
        expect(output.rating).toBe("good");
      });

      it("allows needs-improvement", () => {
        safeLog("info", "test", { rating: "needs-improvement" });
        const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
        expect(output.rating).toBe("needs-improvement");
      });

      it("allows poor", () => {
        safeLog("info", "test", { rating: "poor" });
        const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
        expect(output.rating).toBe("poor");
      });

      it("redacts invalid rating", () => {
        safeLog("info", "test", { rating: "excellent" });
        const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
        expect(output.rating).toBe("<redacted>");
      });

      it("redacts non-string rating", () => {
        safeLog("info", "test", { rating: 1 });
        const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
        expect(output.rating).toBe("<redacted>");
      });
    });

    describe("route key", () => {
      it("allows app_home", () => {
        safeLog("info", "test", { route: "app_home" });
        const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
        expect(output.route).toBe("app_home");
      });

      it("allows app_accounts", () => {
        safeLog("info", "test", { route: "app_accounts" });
        const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
        expect(output.route).toBe("app_accounts");
      });

      it("allows app_onboarding", () => {
        safeLog("info", "test", { route: "app_onboarding" });
        const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
        expect(output.route).toBe("app_onboarding");
      });

      it("allows other", () => {
        safeLog("info", "test", { route: "other" });
        const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
        expect(output.route).toBe("other");
      });

      it("redacts raw path", () => {
        safeLog("info", "test", { route: "/app/onboarding" });
        const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
        expect(output.route).toBe("<redacted>");
      });

      it("redacts path with query string", () => {
        safeLog("info", "test", { route: "/app?shop=test.myshopify.com" });
        const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
        expect(output.route).toBe("<redacted>");
      });

      it("redacts invalid route-id", () => {
        safeLog("info", "test", { route: "invalid_route" });
        const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
        expect(output.route).toBe("<redacted>");
      });

      it("redacts shop domain in route", () => {
        safeLog("info", "test", { route: "test.myshopify.com" });
        const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
        expect(output.route).toBe("<redacted>");
      });
    });

    describe("combined Web Vitals log", () => {
      it("logs all four fields correctly", () => {
        safeLog("info", "web_vitals", {
          metric: "LCP",
          value: 2500,
          rating: "good",
          route: "app_home",
        });

        const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
        expect(output.event).toBe("web_vitals");
        expect(output.metric).toBe("LCP");
        expect(output.value).toBe(2500);
        expect(output.rating).toBe("good");
        expect(output.route).toBe("app_home");
      });

      it("redacts invalid fields in combined log", () => {
        safeLog("info", "web_vitals", {
          metric: "INVALID",
          value: "not-a-number",
          rating: "excellent",
          route: "/raw/path",
        });

        const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
        expect(output.metric).toBe("<redacted>");
        expect(output.value).toBe("<redacted>");
        expect(output.rating).toBe("<redacted>");
        expect(output.route).toBe("<redacted>");
      });

      it("output never contains shop domain", () => {
        safeLog("info", "web_vitals", {
          metric: "LCP",
          value: 2500,
          rating: "good",
          route: "app_home",
        });

        const logOutput = consoleLogSpy.mock.calls[0][0];
        expect(logOutput).not.toContain(".myshopify.com");
        expect(logOutput).not.toContain("shop=");
      });

      it("output never contains query string", () => {
        safeLog("info", "web_vitals", {
          metric: "LCP",
          value: 2500,
          rating: "good",
          route: "app_home",
        });

        const logOutput = consoleLogSpy.mock.calls[0][0];
        expect(logOutput).not.toContain("?");
        expect(logOutput).not.toContain("session=");
        expect(logOutput).not.toContain("hmac=");
      });
    });
  });
});
