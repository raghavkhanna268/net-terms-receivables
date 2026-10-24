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
    it("includes beforeSend hook", async () => {
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
      exception?: { values?: Array<{ value?: string }> };
      message?: string;
      breadcrumbs?: Array<{ message?: string; data?: Record<string, unknown> }>;
      extra?: Record<string, unknown>;
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

    it("deletes request.headers", () => {
      const event = {
        request: {
          headers: { Authorization: "Bearer shpat_secret" },
          url: "https://example.com/app",
        },
      };

      const result = beforeSend(event, {});

      expect(result?.request?.headers).toBeUndefined();
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

    it("deletes id_token from request.data", () => {
      const event = {
        request: {
          url: "https://example.com/app",
          data: {
            id_token: "eyJhbGciOiJIUzI1NiJ9.test.signature",
            other: "value",
          },
        },
      };

      const result = beforeSend(event, {});

      expect(result?.request?.data?.id_token).toBeUndefined();
      expect(result?.request?.data?.other).toBe("value");
    });

    it("deletes shop from request.data", () => {
      const event = {
        request: {
          url: "https://example.com/app",
          data: { shop: "test.myshopify.com" },
        },
      };

      const result = beforeSend(event, {});

      expect(result?.request?.data?.shop).toBeUndefined();
    });

    it("redacts myshopify.com from exception values", () => {
      const event = {
        exception: {
          values: [
            { value: "Error for shop test.myshopify.com: failed" },
          ],
        },
      };

      const result = beforeSend(event, {});

      expect(result?.exception?.values?.[0]?.value).not.toContain("myshopify.com");
      expect(result?.exception?.values?.[0]?.value).toContain("<redacted>");
    });

    it("redacts myshopify.com from message", () => {
      const event = {
        message: "Failed for shop test.myshopify.com",
      };

      const result = beforeSend(event, {});

      expect(result?.message).not.toContain("myshopify.com");
      expect(result?.message).toContain("<redacted>");
    });

    it("redacts myshopify.com from breadcrumb messages", () => {
      const event = {
        breadcrumbs: [
          { message: "Processing shop test.myshopify.com" },
        ],
      };

      const result = beforeSend(event, {});

      expect(result?.breadcrumbs?.[0]?.message).not.toContain("myshopify.com");
      expect(result?.breadcrumbs?.[0]?.message).toContain("<redacted>");
    });

    it("deletes id_token from breadcrumb data", () => {
      const event = {
        breadcrumbs: [
          {
            message: "Request",
            data: { id_token: "secret", other: "value" },
          },
        ],
      };

      const result = beforeSend(event, {});

      expect(result?.breadcrumbs?.[0]?.data?.id_token).toBeUndefined();
      expect(result?.breadcrumbs?.[0]?.data?.other).toBe("value");
    });

    it("deletes id_token from extra", () => {
      const event = {
        extra: {
          id_token: "secret",
          requestId: "req-123",
        },
      };

      const result = beforeSend(event, {});

      expect(result?.extra?.id_token).toBeUndefined();
      expect(result?.extra?.requestId).toBe("req-123");
    });

    it("deletes shop from contexts", () => {
      const event = {
        contexts: {
          request: { shop: "test.myshopify.com", method: "POST" },
        },
      };

      const result = beforeSend(event, {});

      expect(result?.contexts?.request?.shop).toBeUndefined();
      expect(result?.contexts?.request?.method).toBe("POST");
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
