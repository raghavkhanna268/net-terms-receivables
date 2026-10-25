import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the @sentry/cloudflare module
vi.mock("@sentry/cloudflare", () => ({
  withSentry: vi.fn((configFn, handler) => handler),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

describe("sentry.ts", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe("wrapWithSentry config", () => {
    it("includes beforeSend hook for PII protection (A1)", async () => {
      const { withSentry } = await import("@sentry/cloudflare");
      const { wrapWithSentry } = await import("../sentry");

      const mockHandler = { fetch: vi.fn() };
      wrapWithSentry(mockHandler);

      const configFn = (withSentry as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const config = configFn({ SENTRY_DSN: "https://test@sentry.io/123" });

      expect(config.beforeSend).toBeDefined();
      expect(typeof config.beforeSend).toBe("function");
    });

    it("includes beforeSendTransaction hook", async () => {
      const { withSentry } = await import("@sentry/cloudflare");
      const { wrapWithSentry } = await import("../sentry");

      const mockHandler = { fetch: vi.fn() };
      wrapWithSentry(mockHandler);

      const configFn = (withSentry as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const config = configFn({ SENTRY_DSN: "https://test@sentry.io/123" });

      expect(config.beforeSendTransaction).toBeDefined();
      expect(typeof config.beforeSendTransaction).toBe("function");
    });

    it("sets dataCollection to most restrictive values (A1)", async () => {
      const { withSentry } = await import("@sentry/cloudflare");
      const { wrapWithSentry, RESTRICTIVE_DATA_COLLECTION } = await import("../sentry");

      const mockHandler = { fetch: vi.fn() };
      wrapWithSentry(mockHandler);

      const configFn = (withSentry as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const config = configFn({ SENTRY_DSN: "https://test@sentry.io/123" });

      // @sentry/core 11.8.0 replaced sendDefaultPii with dataCollection.
      // Defaults are permissive, so we set all fields to their restrictive values.
      expect(config.dataCollection).toEqual(RESTRICTIVE_DATA_COLLECTION);
      expect(config.dataCollection).toEqual({
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
        graphQL: { document: false, variables: false },
        genAI: { inputs: false, outputs: false },
        databaseQueryData: false,
        queues: false,
        stackFrameVariables: false,
        frameContextLines: 0,
      });
      // beforeSend/beforeSendTransaction provide defense-in-depth
      expect(config.beforeSend).toBeDefined();
      expect(config.beforeSendTransaction).toBeDefined();
    });

    it("disables fetch error hostname enrichment to prevent shop domain leakage", async () => {
      const { withSentry } = await import("@sentry/cloudflare");
      const { wrapWithSentry } = await import("../sentry");

      const mockHandler = { fetch: vi.fn() };
      wrapWithSentry(mockHandler);

      const configFn = (withSentry as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const config = configFn({ SENTRY_DSN: "https://test@sentry.io/123" });

      // Fetch error hostname enrichment (e.g., "Failed to fetch (shop.myshopify.com)")
      // would leak shop domains, which is PII per #174. Disable it entirely.
      expect(config.enhanceFetchErrorMessages).toBe(false);
    });

    it("returns undefined when DSN is not set", async () => {
      const { withSentry } = await import("@sentry/cloudflare");
      const { wrapWithSentry } = await import("../sentry");

      const mockHandler = { fetch: vi.fn() };
      wrapWithSentry(mockHandler);

      const configFn = (withSentry as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const config = configFn({});

      expect(config).toBeUndefined();
    });
  });

  describe("beforeSend scrubbing", () => {
    interface TestRequest {
      headers?: Record<string, string>;
      cookies?: Record<string, string>;
      query_string?: string;
      url?: string;
      data?: Record<string, unknown>;
    }
    interface TestEvent {
      request?: TestRequest;
      exception?: { values?: Array<{ value?: string; type?: string }> };
      message?: string;
      breadcrumbs?: Array<{ message?: string; data?: Record<string, unknown> }>;
      extra?: Record<string, unknown>;
      tags?: Record<string, string>;
      contexts?: Record<string, Record<string, unknown>>;
    }
    let beforeSend: (event: TestEvent, hint: unknown) => TestEvent | null;

    beforeEach(async () => {
      vi.resetModules();
      const { withSentry } = await import("@sentry/cloudflare");
      const { wrapWithSentry } = await import("../sentry");

      const mockHandler = { fetch: vi.fn() };
      wrapWithSentry(mockHandler);

      const configFn = (withSentry as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const config = configFn({ SENTRY_DSN: "https://test@sentry.io/123" });
      beforeSend = config.beforeSend as typeof beforeSend;
    });

    describe("request scrubbing", () => {
      it("keeps only allowlisted headers (content-type, user-agent, cf-ray)", () => {
        const event = {
          request: {
            headers: {
              Authorization: "Bearer shpat_secret",
              "content-type": "application/json",
              "user-agent": "Test/1.0",
              "cf-ray": "abc123",
            },
            url: "https://example.com/app",
          },
        };

        const result = beforeSend(event, {});
        const headers = result?.request?.headers as Record<string, string>;

        expect(headers["content-type"]).toBe("application/json");
        expect(headers["user-agent"]).toBe("Test/1.0");
        expect(headers["cf-ray"]).toBe("abc123");
        expect(headers["Authorization"]).toBeUndefined();
      });

      it("deletes request.cookies", () => {
        const event = {
          request: {
            cookies: { session: "secret-session-id" },
            url: "https://example.com/app",
          },
        };

        const result = beforeSend(event, {});

        expect(result?.request?.cookies).toBeUndefined();
      });

      it("deletes request.query_string", () => {
        const event = {
          request: {
            query_string: "shop=test.myshopify.com&id_token=secret",
            url: "https://example.com/app",
          },
        };

        const result = beforeSend(event, {});

        expect(result?.request?.query_string).toBeUndefined();
      });

      it("strips query string from request.url", () => {
        const event = {
          request: {
            url: "https://example.com/app?shop=test.myshopify.com&id_token=secret",
          },
        };

        const result = beforeSend(event, {});

        expect(result?.request?.url).toBe("https://example.com/app");
      });

      it("deletes request.data entirely", () => {
        const event = {
          request: {
            url: "https://example.com/app",
            data: {
              id_token: "eyJhbGciOiJIUzI1NiJ9.test.signature",
              shop: "test.myshopify.com",
              other: "value",
            },
          },
        };

        const result = beforeSend(event, {});

        expect(result?.request?.data).toBeUndefined();
      });
    });

    describe("exception scrubbing (P1b)", () => {
      it("replaces exception value with error code", () => {
        const event = {
          exception: {
            values: [
              { value: "Error for shop test.myshopify.com: failed", type: "Error" },
            ],
          },
        };

        const result = beforeSend(event, {});

        // Value should be replaced with error code, not contain original message
        expect(result?.exception?.values?.[0]?.value).not.toContain("myshopify.com");
        expect(result?.exception?.values?.[0]?.value).not.toContain("failed");
        // Type should be preserved
        expect(result?.exception?.values?.[0]?.type).toBe("Error");
      });

      it("converts detailed error message to code", () => {
        const event = {
          exception: {
            values: [
              { value: "Connection to database failed with ECONNREFUSED", type: "Error" },
            ],
          },
        };

        const result = beforeSend(event, {});

        // Should return an error code
        expect(result?.exception?.values?.[0]?.value).toBe("connection_refused");
      });
    });

    describe("message scrubbing", () => {
      it("redacts myshopify.com from message", () => {
        const event = {
          message: "Failed for shop test.myshopify.com",
        };

        const result = beforeSend(event, {});

        expect(result?.message).not.toContain("myshopify.com");
        expect(result?.message).toContain("<redacted>");
      });
    });

    describe("breadcrumbs scrubbing", () => {
      it("removes breadcrumbs entirely", () => {
        const event = {
          breadcrumbs: [
            { message: "Processing shop test.myshopify.com" },
            { message: "User action", data: { id_token: "secret" } },
          ],
        };

        const result = beforeSend(event, {});

        expect(result?.breadcrumbs).toBeUndefined();
      });
    });

    describe("extra scrubbing (allowlist)", () => {
      it("keeps only allowlisted keys in extra", () => {
        const event = {
          extra: {
            id_token: "secret",
            requestId: "req-123",
            shopId: "shop-456",
            code: "network_error",
            sensitiveData: "should be removed",
          },
        };

        const result = beforeSend(event, {});

        expect(result?.extra?.id_token).toBeUndefined();
        expect(result?.extra?.sensitiveData).toBeUndefined();
        expect(result?.extra?.requestId).toBe("req-123");
        expect(result?.extra?.shopId).toBe("shop-456");
        expect(result?.extra?.code).toBe("network_error");
      });
    });

    describe("tags scrubbing (allowlist)", () => {
      it("keeps only allowlisted keys in tags", () => {
        const event = {
          tags: {
            shopId: "shop-123",
            code: "error_code",
            shop: "test.myshopify.com",
            email: "user@example.com",
          },
        };

        const result = beforeSend(event, {});

        expect(result?.tags?.shopId).toBe("shop-123");
        expect(result?.tags?.code).toBe("error_code");
        expect(result?.tags?.shop).toBeUndefined();
        expect(result?.tags?.email).toBeUndefined();
      });
    });

    describe("contexts scrubbing (allowlist)", () => {
      it("keeps only allowlisted keys in contexts", () => {
        const event = {
          contexts: {
            request: {
              shop: "test.myshopify.com",
              shopId: "shop-123",
              method: "POST",
              requestId: "req-456",
            },
          },
        };

        const result = beforeSend(event, {});

        expect(result?.contexts?.request?.shop).toBeUndefined();
        expect(result?.contexts?.request?.method).toBeUndefined();
        expect(result?.contexts?.request?.shopId).toBe("shop-123");
        expect(result?.contexts?.request?.requestId).toBe("req-456");
      });
    });
  });

  describe("captureExceptionWithTags", () => {
    it("includes shopId tag when provided", async () => {
      vi.resetModules();
      const { captureException: mockCapture } = await import("@sentry/cloudflare");
      const { captureExceptionWithTags } = await import("../sentry");

      const error = new Error("Test error");
      captureExceptionWithTags(error, { shopId: "shop-123" });

      expect(mockCapture).toHaveBeenCalledWith(error, {
        tags: expect.objectContaining({ shopId: "shop-123" }),
      });
    });

    it("includes error code tag", async () => {
      vi.resetModules();
      const { captureException: mockCapture } = await import("@sentry/cloudflare");
      const { captureExceptionWithTags } = await import("../sentry");

      const error = new Error("Test error");
      captureExceptionWithTags(error, { code: "network_error" });

      expect(mockCapture).toHaveBeenCalledWith(error, {
        tags: expect.objectContaining({ code: "network_error" }),
      });
    });

    it("extracts code from error when not provided", async () => {
      vi.resetModules();
      const { captureException: mockCapture } = await import("@sentry/cloudflare");
      const { captureExceptionWithTags } = await import("../sentry");

      const error = new TypeError("Test error");
      captureExceptionWithTags(error, {});

      expect(mockCapture).toHaveBeenCalledWith(error, {
        tags: expect.objectContaining({ code: "TypeError" }),
      });
    });
  });
});
