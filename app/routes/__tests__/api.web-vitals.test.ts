/**
 * Tests for api.web-vitals.tsx
 *
 * Verifies:
 * - Route rejects invalid metric names
 * - Route rejects out-of-bounds values
 * - Route rejects oversized bodies
 * - Route accepts valid payloads with 204
 * - Payload never contains shop domain or query string
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { action, loader } from "../api.web-vitals";

const mockSafeLog = vi.fn();

vi.mock("~/lib/log.server", () => ({
  safeLog: (...args: unknown[]) => mockSafeLog(...args),
}));

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

function callAction(request: Request) {
  return action({
    request,
    context: {} as never,
    params: {},
    url: new URL(request.url),
    pattern: "/api/web-vitals",
  });
}

function callLoader() {
  return loader();
}

describe("api.web-vitals action", () => {
  beforeEach(() => {
    mockSafeLog.mockClear();
  });

  afterEach(() => {
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

  describe("content type validation", () => {
    it("rejects text/plain with 415", async () => {
      const request = createRequest("{}", { contentType: "text/plain" });

      const response = await callAction(request);

      expect(response.status).toBe(415);
    });

    it("accepts application/json", async () => {
      const request = createRequest({
        metrics: [{ name: "LCP", value: 2500, id: "v1-1", route: "/app", version: "3.0" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(204);
    });

    it("accepts application/json;charset=utf-8", async () => {
      const request = createRequest(
        {
          metrics: [{ name: "LCP", value: 2500, id: "v1-1", route: "/app", version: "3.0" }],
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
          id: "v1-1234567890-1234567890-1234567890",
          route: "/app/very/long/route/that/takes/up/space",
          version: "3.0.0",
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
        metrics: [{ name: "UNKNOWN", value: 100, id: "v1-1", route: "/app", version: "3.0" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
      expect(mockSafeLog).toHaveBeenCalledWith("warn", "web_vitals_invalid", expect.any(Object));
    });

    it("rejects FCP (not a Core Web Vital) with 400", async () => {
      const request = createRequest({
        metrics: [{ name: "FCP", value: 100, id: "v1-1", route: "/app", version: "3.0" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("rejects TTFB (not a Core Web Vital) with 400", async () => {
      const request = createRequest({
        metrics: [{ name: "TTFB", value: 100, id: "v1-1", route: "/app", version: "3.0" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("rejects FID (deprecated) with 400", async () => {
      const request = createRequest({
        metrics: [{ name: "FID", value: 100, id: "v1-1", route: "/app", version: "3.0" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("accepts LCP", async () => {
      const request = createRequest({
        metrics: [{ name: "LCP", value: 2500, id: "v1-1", route: "/app", version: "3.0" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(204);
    });

    it("accepts CLS", async () => {
      const request = createRequest({
        metrics: [{ name: "CLS", value: 0.05, id: "v1-1", route: "/app", version: "3.0" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(204);
    });

    it("accepts INP", async () => {
      const request = createRequest({
        metrics: [{ name: "INP", value: 150, id: "v1-1", route: "/app", version: "3.0" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(204);
    });
  });

  describe("value bounds validation", () => {
    it("rejects negative LCP value", async () => {
      const request = createRequest({
        metrics: [{ name: "LCP", value: -100, id: "v1-1", route: "/app", version: "3.0" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("rejects LCP over 60000", async () => {
      const request = createRequest({
        metrics: [{ name: "LCP", value: 60001, id: "v1-1", route: "/app", version: "3.0" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("rejects negative CLS value", async () => {
      const request = createRequest({
        metrics: [{ name: "CLS", value: -0.1, id: "v1-1", route: "/app", version: "3.0" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("rejects CLS over 10", async () => {
      const request = createRequest({
        metrics: [{ name: "CLS", value: 10.1, id: "v1-1", route: "/app", version: "3.0" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("rejects negative INP value", async () => {
      const request = createRequest({
        metrics: [{ name: "INP", value: -50, id: "v1-1", route: "/app", version: "3.0" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("rejects INP over 30000", async () => {
      const request = createRequest({
        metrics: [{ name: "INP", value: 30001, id: "v1-1", route: "/app", version: "3.0" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("rejects non-finite values (NaN)", async () => {
      const request = new Request("https://example.com/api/web-vitals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"metrics":[{"name":"LCP","value":NaN,"id":"v1-1","route":"/app","version":"3.0"}]}',
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("rejects non-finite values (Infinity)", async () => {
      const request = new Request("https://example.com/api/web-vitals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"metrics":[{"name":"LCP","value":Infinity,"id":"v1-1","route":"/app","version":"3.0"}]}',
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("accepts edge case: LCP exactly 60000", async () => {
      const request = createRequest({
        metrics: [{ name: "LCP", value: 60000, id: "v1-1", route: "/app", version: "3.0" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(204);
    });

    it("accepts edge case: CLS exactly 0", async () => {
      const request = createRequest({
        metrics: [{ name: "CLS", value: 0, id: "v1-1", route: "/app", version: "3.0" }],
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
          id: "v1-1",
          route: "/app",
          version: "3.0",
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
            value: 2500,
            id: `v1-${i}`,
            route: "/app",
            version: "3.0",
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

  describe("route validation (privacy)", () => {
    it("rejects route containing .myshopify.com", async () => {
      const request = createRequest({
        metrics: [
          {
            name: "LCP",
            value: 2500,
            id: "v1-1",
            route: "/app?shop=test.myshopify.com",
            version: "3.0",
          },
        ],
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("rejects route containing query string (?)", async () => {
      const request = createRequest({
        metrics: [
          {
            name: "LCP",
            value: 2500,
            id: "v1-1",
            route: "/app?session=abc123",
            version: "3.0",
          },
        ],
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("rejects route containing shop=", async () => {
      const request = createRequest({
        metrics: [
          { name: "LCP", value: 2500, id: "v1-1", route: "/app/shop=test", version: "3.0" },
        ],
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("rejects route containing host=", async () => {
      const request = createRequest({
        metrics: [
          { name: "LCP", value: 2500, id: "v1-1", route: "/app/host=abc", version: "3.0" },
        ],
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("rejects route containing hmac=", async () => {
      const request = createRequest({
        metrics: [
          { name: "LCP", value: 2500, id: "v1-1", route: "/app/hmac=xyz", version: "3.0" },
        ],
      });

      const response = await callAction(request);

      expect(response.status).toBe(400);
    });

    it("accepts clean route without query string", async () => {
      const request = createRequest({
        metrics: [
          { name: "LCP", value: 2500, id: "v1-1", route: "/app/onboarding", version: "3.0" },
        ],
      });

      const response = await callAction(request);

      expect(response.status).toBe(204);
    });
  });

  describe("successful request handling", () => {
    it("returns 204 No Content for valid payload", async () => {
      const request = createRequest({
        metrics: [{ name: "LCP", value: 2500, id: "v1-1", route: "/app", version: "3.0" }],
      });

      const response = await callAction(request);

      expect(response.status).toBe(204);
      const body = await response.text();
      expect(body).toBe("");
    });

    it("logs each metric via safeLog", async () => {
      const request = createRequest({
        metrics: [
          { name: "LCP", value: 2500, id: "v1-1", route: "/app", version: "3.0" },
          { name: "CLS", value: 0.05, id: "v1-2", route: "/app", version: "3.0" },
          { name: "INP", value: 150, id: "v1-3", route: "/app", version: "3.0" },
        ],
      });

      await callAction(request);

      expect(mockSafeLog).toHaveBeenCalledTimes(3);
      expect(mockSafeLog).toHaveBeenCalledWith("info", "web_vitals", {
        metric: "LCP",
        value: 2500,
        route: "/app",
        id: "v1-1",
        version: "3.0",
      });
      expect(mockSafeLog).toHaveBeenCalledWith("info", "web_vitals", {
        metric: "CLS",
        value: 0.05,
        route: "/app",
        id: "v1-2",
        version: "3.0",
      });
      expect(mockSafeLog).toHaveBeenCalledWith("info", "web_vitals", {
        metric: "INP",
        value: 150,
        route: "/app",
        id: "v1-3",
        version: "3.0",
      });
    });

    it("never echoes input in response body", async () => {
      const request = createRequest({
        metrics: [{ name: "LCP", value: 2500, id: "v1-1", route: "/app", version: "3.0" }],
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
