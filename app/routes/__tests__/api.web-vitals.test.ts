/**
 * Tests for api.web-vitals.tsx
 *
 * Verifies:
 * - Route rejects invalid metric names
 * - Route rejects out-of-bounds values
 * - Route rejects oversized bodies
 * - Route accepts valid payloads with 204
 * - Payload never contains shop domain or query string
 * - Uses real safeLog with console spy to verify actual JSON output
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { action, loader } from "../api.web-vitals";

function createRequest(
  body: unknown,
  options: { method?: string; contentType?: string } = {}
): Request {
  const { method = "POST", contentType = "application/json" } = options;
  const headers: Record<string, string> = {};
  
  if (contentType) {
    headers["Content-Type"] = contentType;
  }

  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  headers["Content-Length"] = String(new TextEncoder().encode(bodyStr).length);

  return new Request("https://example.com/api/web-vitals", {
    method,
    headers,
    body: method === "POST" ? bodyStr : undefined,
  });
}

function createMockContext() {
  return {
    shopify: {
      authenticate: {
        admin: vi.fn().mockResolvedValue({ session: { shop: "test.myshopify.com" } }),
      },
    },
  };
}

function callAction(request: Request, context = createMockContext()) {
  return action({
    request,
    context: context as never,
    params: {},
    url: new URL(request.url),
    pattern: "/api/web-vitals",
  });
}

function callLoader() {
  return loader();
}

describe("api.web-vitals action", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    vi.restoreAllMocks();
  });

  describe("method validation", () => {
    it("rejects GET requests with 405", async () => {
      const request = createRequest({}, { method: "GET" });

      const response = await callAction(request);

      expect(response.status).toBe(405);
    });

    it("rejects PUT requests with 405", async () => {
      const request = createRequest({}, { method: "PUT" });

      const response = await callAction(request);

      expect(response.status).toBe(405);
    });
  });

  describe("authentication", () => {
    it("returns 401 when authentication fails", async () => {
      const request = createRequest({
        metrics: [{ name: "LCP", value: 2500, route: "/app" }],
      });
      const context = {
        shopify: {
          authenticate: {
            admin: vi.fn().mockRejectedValue(new Error("Unauthorized")),
          },
        },
      };

      const response = await callAction(request, context);

      expect(response.status).toBe(401);
    });

    it("accepts request when authentication succeeds", async () => {
      const request = createRequest({
        metrics: [{ name: "LCP", value: 2500, route: "/app" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(204);
    });
  });

  describe("content type validation", () => {
    it("rejects text/plain with 415", async () => {
      const request = createRequest("{}", { contentType: "text/plain" });

      const response = await callAction(request);

      expect(response.status).toBe(415);
    });

    it("accepts application/json", async () => {
      const request = createRequest({
        metrics: [{ name: "LCP", value: 2500, route: "/app" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(204);
    });

    it("accepts application/json;charset=utf-8", async () => {
      const request = createRequest(
        {
          metrics: [{ name: "LCP", value: 2500, route: "/app" }],
        },
        { contentType: "application/json;charset=utf-8" }
      );

      const response = await callAction(request);

      expect(response.status).toBe(204);
    });
  });

  describe("body size validation", () => {
    it("rejects bodies over 4KB with 413", async () => {
      const largePayload = {
        metrics: Array(100).fill({
          name: "LCP",
          value: 2500,
          route: "/app/very/long/route/that/takes/up/space",
        }),
      };

      const request = createRequest(largePayload);
      const response = await callAction(request);

      expect(response.status).toBe(413);
    });
  });

  describe("metric name validation", () => {
    it("rejects unknown metric names with 400", async () => {
      const request = createRequest({
        metrics: [{ name: "UNKNOWN", value: 100, route: "/app" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("rejects FCP (not a Core Web Vital) with 400", async () => {
      const request = createRequest({
        metrics: [{ name: "FCP", value: 100, route: "/app" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("rejects TTFB (not a Core Web Vital) with 400", async () => {
      const request = createRequest({
        metrics: [{ name: "TTFB", value: 100, route: "/app" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("rejects FID (deprecated) with 400", async () => {
      const request = createRequest({
        metrics: [{ name: "FID", value: 100, route: "/app" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("accepts LCP", async () => {
      const request = createRequest({
        metrics: [{ name: "LCP", value: 2500, route: "/app" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(204);
    });

    it("accepts CLS", async () => {
      const request = createRequest({
        metrics: [{ name: "CLS", value: 0.05, route: "/app" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(204);
    });

    it("accepts INP", async () => {
      const request = createRequest({
        metrics: [{ name: "INP", value: 150, route: "/app" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(204);
    });
  });

  describe("value bounds validation", () => {
    it("rejects negative LCP value", async () => {
      const request = createRequest({
        metrics: [{ name: "LCP", value: -100, route: "/app" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("rejects LCP over 60000", async () => {
      const request = createRequest({
        metrics: [{ name: "LCP", value: 60001, route: "/app" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("rejects negative CLS value", async () => {
      const request = createRequest({
        metrics: [{ name: "CLS", value: -0.1, route: "/app" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("rejects CLS over 10", async () => {
      const request = createRequest({
        metrics: [{ name: "CLS", value: 10.1, route: "/app" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("rejects negative INP value", async () => {
      const request = createRequest({
        metrics: [{ name: "INP", value: -50, route: "/app" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("rejects INP over 30000", async () => {
      const request = createRequest({
        metrics: [{ name: "INP", value: 30001, route: "/app" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("rejects non-finite values (NaN)", async () => {
      const request = new Request("https://example.com/api/web-vitals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"metrics":[{"name":"LCP","value":NaN,"route":"/app"}]}',
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("accepts edge case: LCP exactly 60000", async () => {
      const request = createRequest({
        metrics: [{ name: "LCP", value: 60000, route: "/app" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(204);
    });

    it("accepts edge case: CLS exactly 0", async () => {
      const request = createRequest({
        metrics: [{ name: "CLS", value: 0, route: "/app" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(204);
    });
  });

  describe("route validation (strict allowlist)", () => {
    it("rejects route not starting with /app", async () => {
      const request = createRequest({
        metrics: [{ name: "LCP", value: 2500, route: "/other" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("rejects route with query string", async () => {
      const request = createRequest({
        metrics: [{ name: "LCP", value: 2500, route: "/app?shop=test.myshopify.com" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("rejects route with special characters", async () => {
      const request = createRequest({
        metrics: [{ name: "LCP", value: 2500, route: "/app/../secret" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("accepts /app", async () => {
      const request = createRequest({
        metrics: [{ name: "LCP", value: 2500, route: "/app" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(204);
    });

    it("accepts /app/onboarding", async () => {
      const request = createRequest({
        metrics: [{ name: "LCP", value: 2500, route: "/app/onboarding" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(204);
    });

    it("accepts /app/accounts/123", async () => {
      const request = createRequest({
        metrics: [{ name: "LCP", value: 2500, route: "/app/accounts/123" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(204);
    });
  });

  describe("metrics array validation", () => {
    it("rejects empty metrics array", async () => {
      const request = createRequest({ metrics: [] });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("rejects more than 10 metrics", async () => {
      const request = createRequest({
        metrics: Array(11).fill({
          name: "LCP",
          value: 2500,
          route: "/app",
        }),
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("accepts exactly 10 metrics", async () => {
      const request = createRequest({
        metrics: Array(10)
          .fill(null)
          .map((_, i) => ({
            name: "LCP",
            value: 2500 + i,
            route: "/app",
          })),
      });

      const response = await callAction(request);

      expect(response.status).toBe(204);
    });

    it("rejects missing metrics field", async () => {
      const request = createRequest({});

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("rejects non-array metrics", async () => {
      const request = createRequest({ metrics: "not-an-array" });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });
  });

  describe("successful request logging (real safeLog)", () => {
    it("returns 204 No Content for valid payload", async () => {
      const request = createRequest({
        metrics: [{ name: "LCP", value: 2500, route: "/app" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(204);
      const body = await response.text();
      expect(body).toBe("");
    });

    it("logs each metric with validated fields via real safeLog", async () => {
      const request = createRequest({
        metrics: [
          { name: "LCP", value: 2500, route: "/app" },
          { name: "CLS", value: 0.05, route: "/app/onboarding" },
          { name: "INP", value: 150, route: "/app/reconcile" },
        ],
      });

      await callAction(request);

      expect(consoleLogSpy).toHaveBeenCalledTimes(3);

      const log1 = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(log1.event).toBe("web_vitals");
      expect(log1.metric).toBe("LCP");
      expect(log1.value).toBe(2500);
      expect(log1.rating).toBe("good");
      expect(log1.route).toBe("app_home");

      const log2 = JSON.parse(consoleLogSpy.mock.calls[1][0]);
      expect(log2.event).toBe("web_vitals");
      expect(log2.metric).toBe("CLS");
      expect(log2.value).toBe(0.05);
      expect(log2.rating).toBe("good");
      expect(log2.route).toBe("app_onboarding");

      const log3 = JSON.parse(consoleLogSpy.mock.calls[2][0]);
      expect(log3.event).toBe("web_vitals");
      expect(log3.metric).toBe("INP");
      expect(log3.value).toBe(150);
      expect(log3.rating).toBe("good");
      expect(log3.route).toBe("app_reconcile");
    });

    it("computes correct rating for LCP thresholds", async () => {
      const request = createRequest({
        metrics: [
          { name: "LCP", value: 2500, route: "/app" },
          { name: "LCP", value: 3000, route: "/app" },
          { name: "LCP", value: 4500, route: "/app" },
        ],
      });

      await callAction(request);

      const log1 = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(log1.rating).toBe("good");

      const log2 = JSON.parse(consoleLogSpy.mock.calls[1][0]);
      expect(log2.rating).toBe("needs-improvement");

      const log3 = JSON.parse(consoleLogSpy.mock.calls[2][0]);
      expect(log3.rating).toBe("poor");
    });

    it("computes correct rating for INP thresholds", async () => {
      const request = createRequest({
        metrics: [
          { name: "INP", value: 200, route: "/app" },
          { name: "INP", value: 300, route: "/app" },
          { name: "INP", value: 600, route: "/app" },
        ],
      });

      await callAction(request);

      const log1 = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(log1.rating).toBe("good");

      const log2 = JSON.parse(consoleLogSpy.mock.calls[1][0]);
      expect(log2.rating).toBe("needs-improvement");

      const log3 = JSON.parse(consoleLogSpy.mock.calls[2][0]);
      expect(log3.rating).toBe("poor");
    });

    it("computes correct rating for CLS thresholds", async () => {
      const request = createRequest({
        metrics: [
          { name: "CLS", value: 0.1, route: "/app" },
          { name: "CLS", value: 0.2, route: "/app" },
          { name: "CLS", value: 0.3, route: "/app" },
        ],
      });

      await callAction(request);

      const log1 = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(log1.rating).toBe("good");

      const log2 = JSON.parse(consoleLogSpy.mock.calls[1][0]);
      expect(log2.rating).toBe("needs-improvement");

      const log3 = JSON.parse(consoleLogSpy.mock.calls[2][0]);
      expect(log3.rating).toBe("poor");
    });

    it("maps routes to route-id enum correctly", async () => {
      const request = createRequest({
        metrics: [
          { name: "LCP", value: 2500, route: "/app" },
          { name: "LCP", value: 2500, route: "/app/accounts/123" },
          { name: "LCP", value: 2500, route: "/app/imports" },
          { name: "LCP", value: 2500, route: "/app/settings/reminders" },
          { name: "LCP", value: 2500, route: "/app/unknown-route" },
        ],
      });

      await callAction(request);

      expect(JSON.parse(consoleLogSpy.mock.calls[0][0]).route).toBe("app_home");
      expect(JSON.parse(consoleLogSpy.mock.calls[1][0]).route).toBe("app_accounts");
      expect(JSON.parse(consoleLogSpy.mock.calls[2][0]).route).toBe("app_imports");
      expect(JSON.parse(consoleLogSpy.mock.calls[3][0]).route).toBe("app_settings_reminders");
      expect(JSON.parse(consoleLogSpy.mock.calls[4][0]).route).toBe("other");
    });

    it("log output never contains shop domain", async () => {
      const request = createRequest({
        metrics: [{ name: "LCP", value: 2500, route: "/app" }],
      });

      await callAction(request);

      const logOutput = consoleLogSpy.mock.calls[0][0];
      expect(logOutput).not.toContain(".myshopify.com");
      expect(logOutput).not.toContain("shop");
    });

    it("log output never contains query string", async () => {
      const request = createRequest({
        metrics: [{ name: "LCP", value: 2500, route: "/app" }],
      });

      await callAction(request);

      const logOutput = consoleLogSpy.mock.calls[0][0];
      expect(logOutput).not.toContain("?");
      expect(logOutput).not.toContain("session=");
      expect(logOutput).not.toContain("hmac=");
    });

    it("log output never contains raw route path", async () => {
      const request = createRequest({
        metrics: [{ name: "LCP", value: 2500, route: "/app/accounts/12345" }],
      });

      await callAction(request);

      const logOutput = consoleLogSpy.mock.calls[0][0];
      expect(logOutput).not.toContain("/app/accounts/12345");
      expect(logOutput).toContain("app_accounts");
    });

    it("never echoes input in response body", async () => {
      const request = createRequest({
        metrics: [{ name: "LCP", value: 2500, route: "/app" }],
      });

      const response = await callAction(request);
      const body = await response.text();

      expect(body).toBe("");
      expect(body).not.toContain("LCP");
      expect(body).not.toContain("2500");
    });
  });

  describe("malformed JSON", () => {
    it("rejects invalid JSON with 400", async () => {
      const request = new Request("https://example.com/api/web-vitals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });
  });
});

describe("api.web-vitals loader", () => {
  it("rejects GET with 405", async () => {
    const response = await callLoader();

    expect(response.status).toBe(405);
  });
});
