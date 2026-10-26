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
      logentry?: { message?: string; params?: unknown[] };
      transaction?: string;
      fingerprint?: string[];
      threads?: { values: Array<{ name?: string }> };
      spans?: Array<{ description?: string; data: Record<string, unknown>; span_id: string; trace_id: string; start_timestamp: number; status: string }>;
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

      it("strips query string and scrubs hostname from request.url", () => {
        const event = {
          request: {
            url: "https://example.com/app?shop=test.myshopify.com&id_token=secret",
          },
        };

        const result = beforeSend(event, {});

        // Query string is stripped and hostname is scrubbed (could be shop domain)
        expect(result?.request?.url).not.toContain("?");
        expect(result?.request?.url).not.toContain("myshopify.com");
        expect(result?.request?.url).not.toContain("id_token");
        expect(result?.request?.url).toContain("/app");
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
      it("replaces free text message with safe code", () => {
        const event = {
          message: "Failed for shop test.myshopify.com",
        };

        const result = beforeSend(event, {});

        expect(result?.message).not.toContain("myshopify.com");
        expect(result?.message).toBe("[scrubbed]");
      });

      it("passes through allowlisted messages", () => {
        const event = { message: "Unhandled error" };
        const result = beforeSend(event, {});
        expect(result?.message).toBe("Unhandled error");
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

  describe("PII scrubbing - buyer names, narrations, amounts", () => {
    const FAKE_BUYER_NAME = "Asha Verma Test";
    const FAKE_NARRATION = "NEFT/ACME TRADERS/INV-1001";
    const FAKE_AMOUNT = "50000.00";

    interface FullTestEvent {
      message?: string;
      logentry?: { message?: string; params?: unknown[] };
      exception?: { values?: Array<{ value?: string; type?: string }> };
      transaction?: string;
      fingerprint?: string[];
      threads?: { values: Array<{ name?: string }> };
      spans?: Array<{ description?: string; data: Record<string, unknown>; span_id: string; trace_id: string; start_timestamp: number; status: string }>;
      extra?: Record<string, unknown>;
      tags?: Record<string, string>;
      request?: { url?: string };
    }

    let beforeSend: (event: FullTestEvent, hint: unknown) => FullTestEvent | null;
    let beforeSendTransaction: (event: FullTestEvent, hint: unknown) => FullTestEvent | null;

    beforeEach(async () => {
      vi.resetModules();
      const { withSentry } = await import("@sentry/cloudflare");
      const { wrapWithSentry } = await import("../sentry");

      const mockHandler = { fetch: vi.fn() };
      wrapWithSentry(mockHandler);

      const configFn = (withSentry as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const config = configFn({ SENTRY_DSN: "https://test@sentry.io/123" });
      beforeSend = config.beforeSend as typeof beforeSend;
      beforeSendTransaction = config.beforeSendTransaction as typeof beforeSendTransaction;
    });

    function assertNoSensitiveData(json: string) {
      expect(json).not.toContain(FAKE_BUYER_NAME);
      expect(json).not.toContain("Asha Verma");
      expect(json).not.toContain("Asha");
      expect(json).not.toContain(FAKE_NARRATION);
      expect(json).not.toContain("ACME TRADERS");
      expect(json).not.toContain("INV-1001");
      expect(json).not.toContain(FAKE_AMOUNT);
      expect(json).not.toContain("50000");
    }

    describe("captureMessage path", () => {
      it("scrubs buyer name from message", () => {
        const event = { message: `Payment received from ${FAKE_BUYER_NAME}` };
        const result = beforeSend(event, {});
        const json = JSON.stringify(result);
        assertNoSensitiveData(json);
        expect(result?.message).toBe("[scrubbed]");
      });

      it("scrubs narration from message", () => {
        const event = { message: `Transaction: ${FAKE_NARRATION}` };
        const result = beforeSend(event, {});
        const json = JSON.stringify(result);
        assertNoSensitiveData(json);
      });

      it("scrubs amount from message", () => {
        const event = { message: `Amount: ${FAKE_AMOUNT}` };
        const result = beforeSend(event, {});
        const json = JSON.stringify(result);
        assertNoSensitiveData(json);
      });
    });

    describe("captureException path", () => {
      it("scrubs buyer name from exception value", () => {
        const event = {
          exception: {
            values: [{ value: `Error processing buyer ${FAKE_BUYER_NAME}`, type: "Error" }],
          },
        };
        const result = beforeSend(event, {});
        const json = JSON.stringify(result);
        assertNoSensitiveData(json);
      });

      it("scrubs narration from exception value", () => {
        const event = {
          exception: {
            values: [{ value: `Failed to parse: ${FAKE_NARRATION}`, type: "Error" }],
          },
        };
        const result = beforeSend(event, {});
        const json = JSON.stringify(result);
        assertNoSensitiveData(json);
      });

      it("scrubs amount from exception value", () => {
        const event = {
          exception: {
            values: [{ value: `Invalid amount: ${FAKE_AMOUNT}`, type: "Error" }],
          },
        };
        const result = beforeSend(event, {});
        const json = JSON.stringify(result);
        assertNoSensitiveData(json);
      });

      it("scrubs unusual exception types", () => {
        const event = {
          exception: {
            values: [{ value: "Error", type: FAKE_BUYER_NAME }],
          },
        };
        const result = beforeSend(event, {});
        const json = JSON.stringify(result);
        assertNoSensitiveData(json);
        expect(result?.exception?.values?.[0]?.type).toBe("Error");
      });
    });

    describe("logentry path", () => {
      it("scrubs buyer name from logentry message", () => {
        const event = {
          logentry: {
            message: `Processing buyer ${FAKE_BUYER_NAME}`,
            params: [FAKE_BUYER_NAME, FAKE_AMOUNT],
          },
        };
        const result = beforeSend(event, {});
        const json = JSON.stringify(result);
        assertNoSensitiveData(json);
        expect(result?.logentry?.params).toBeUndefined();
      });

      it("scrubs narration from logentry", () => {
        const event = {
          logentry: {
            message: `Narration: ${FAKE_NARRATION}`,
            params: [FAKE_NARRATION],
          },
        };
        const result = beforeSend(event, {});
        const json = JSON.stringify(result);
        assertNoSensitiveData(json);
      });
    });

    describe("transaction/span names", () => {
      it("converts transaction name with buyer name to route template", () => {
        const event = {
          transaction: `/app/buyers/${FAKE_BUYER_NAME}/invoices`,
        };
        const result = beforeSend(event, {});
        const json = JSON.stringify(result);
        assertNoSensitiveData(json);
        expect(result?.transaction).not.toContain(FAKE_BUYER_NAME);
      });

      it("converts span description with amount to route template", () => {
        const event = {
          spans: [
            {
              description: `/api/payments?amount=${FAKE_AMOUNT}`,
              data: { buyerName: FAKE_BUYER_NAME },
              span_id: "abc123",
              trace_id: "trace123",
              start_timestamp: Date.now(),
              status: "ok",
            },
          ],
        };
        const result = beforeSendTransaction(event, {});
        const json = JSON.stringify(result);
        assertNoSensitiveData(json);
        expect(result?.spans?.[0]?.description).not.toContain(FAKE_AMOUNT);
        expect(result?.spans?.[0]?.data?.buyerName).toBeUndefined();
      });

      it("converts transaction name with numeric ID to route template", () => {
        const event = { transaction: "/app/buyers/12345/invoices" };
        const result = beforeSend(event, {});
        expect(result?.transaction).toBe("/app/buyers/:id/invoices");
      });

      it("converts transaction name with UUID to route template", () => {
        const event = { transaction: "/app/orders/550e8400-e29b-41d4-a716-446655440000/details" };
        const result = beforeSend(event, {});
        expect(result?.transaction).toBe("/app/orders/:uuid/details");
      });

      it("strips query strings from transaction names", () => {
        const event = { transaction: `/app/reconcile?buyer=${FAKE_BUYER_NAME}&amount=${FAKE_AMOUNT}` };
        const result = beforeSend(event, {});
        const json = JSON.stringify(result);
        assertNoSensitiveData(json);
        expect(result?.transaction).toBe("/app/reconcile");
      });
    });

    describe("fingerprint scrubbing", () => {
      it("scrubs sensitive data from fingerprint", () => {
        const event = {
          fingerprint: ["{{ default }}", FAKE_BUYER_NAME, `/payments/${FAKE_AMOUNT}`],
        };
        const result = beforeSend(event, {});
        const json = JSON.stringify(result);
        assertNoSensitiveData(json);
        expect(result?.fingerprint?.[0]).toBe("{{ default }}");
      });
    });

    describe("threads scrubbing", () => {
      it("scrubs thread names containing sensitive data", () => {
        const event = {
          threads: {
            values: [{ name: `Worker for ${FAKE_BUYER_NAME}` }],
          },
        };
        const result = beforeSend(event, {});
        const json = JSON.stringify(result);
        assertNoSensitiveData(json);
        expect(result?.threads?.values?.[0]?.name).toBe("[scrubbed]");
      });
    });

    describe("full event serialization", () => {
      it("guarantees no sensitive data in complete event JSON", () => {
        const event: FullTestEvent = {
          message: `Payment from ${FAKE_BUYER_NAME}`,
          logentry: { message: FAKE_NARRATION, params: [FAKE_AMOUNT] },
          exception: { values: [{ value: `Error: ${FAKE_BUYER_NAME} ${FAKE_NARRATION}`, type: "Error" }] },
          transaction: `/api/process?buyer=${FAKE_BUYER_NAME}&amount=${FAKE_AMOUNT}`,
          fingerprint: ["{{ default }}", FAKE_NARRATION],
          threads: { values: [{ name: FAKE_BUYER_NAME }] },
          spans: [
            {
              description: `/payments/${FAKE_AMOUNT}`,
              data: { narration: FAKE_NARRATION, buyer: FAKE_BUYER_NAME },
              span_id: "span1",
              trace_id: "trace1",
              start_timestamp: Date.now(),
              status: "ok",
            },
          ],
          extra: { buyerName: FAKE_BUYER_NAME, amount: FAKE_AMOUNT },
          tags: { buyer: FAKE_BUYER_NAME },
          request: { url: `/app?buyer=${FAKE_BUYER_NAME}` },
        };

        const result = beforeSend(event, {});
        const json = JSON.stringify(result);

        assertNoSensitiveData(json);
      });
    });
  });
});
