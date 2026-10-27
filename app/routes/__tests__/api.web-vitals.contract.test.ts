/**
 * Contract test: client output is always accepted by the server.
 *
 * Builds a report from deliberately extreme raw metrics, runs it through the
 * real client-side filterMetrics, and feeds the resulting payload into the real
 * route action (authentication mocked). The server must answer 204 and never
 * 400, proving the client's filtering stays inside the server's bounds and
 * per-request cap.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { filterMetrics } from "~/lib/web-vitals.client";
import { action } from "../api.web-vitals";

function createRequest(payload: unknown): Request {
  const bodyStr = JSON.stringify(payload);
  return new Request("https://example.com/api/web-vitals", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(new TextEncoder().encode(bodyStr).length),
    },
    body: bodyStr,
  });
}

function createMockContext() {
  return {
    shopify: {
      authenticate: {
        admin: vi.fn().mockResolvedValue({ session: {} }),
      },
    },
  };
}

function callAction(request: Request) {
  return action({
    request,
    context: createMockContext() as never,
    params: {},
  } as never);
}

describe("web-vitals client/server contract", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts (204) a payload built from extreme inputs, never 400", async () => {
    const extremeMetrics = [
      { id: "x1", name: "LCP" as const, value: Number.NaN },
      { id: "x2", name: "LCP" as const, value: Number.POSITIVE_INFINITY },
      { id: "x3", name: "LCP" as const, value: Number.NEGATIVE_INFINITY },
      { id: "x4", name: "LCP" as const, value: -5000 },
      { id: "x5", name: "LCP" as const, value: 999999 },
      { id: "x6", name: "CLS" as const, value: 42 },
      { id: "x7", name: "INP" as const, value: 10_000_000 },
      { id: "x8", name: "FCP" as const, value: 1200 },
      { id: "x9", name: "TTFB" as const, value: 300 },
      { id: "x10", name: "LCP" as const, value: 2500 },
      { id: "x11", name: "CLS" as const, value: 0.05 },
      { id: "x12", name: "INP" as const, value: 150 },
    ];

    const payload = filterMetrics(extremeMetrics, "/app");

    expect(payload).not.toBeNull();

    const response = await callAction(createRequest(payload));

    expect(response.status).toBe(204);
    expect(response.status).not.toBe(400);
  });

  it("accepts (204) when far more than 10 valid metrics are reported", async () => {
    const manyValid = Array.from({ length: 30 }, (_, i) => ({
      id: `m-${i}`,
      name: "LCP" as const,
      value: 1000 + i,
    }));

    const payload = filterMetrics(manyValid, "/app");

    expect(payload).not.toBeNull();
    expect(payload!.metrics.length).toBeLessThanOrEqual(10);

    const response = await callAction(createRequest(payload));

    expect(response.status).toBe(204);
    expect(response.status).not.toBe(400);
  });
});
