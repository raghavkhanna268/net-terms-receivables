/**
 * Tests for web-vitals.client.ts
 *
 * Verifies:
 * - filterMetrics filters to LCP/CLS/INP only
 * - Payload never contains shop domain, query strings, id, or version
 * - registerWebVitalsReporter is a no-op when shopify.webVitals is missing
 * - Value rounding is correct (CLS 4 decimals, others integer)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { filterMetrics, registerWebVitalsReporter } from "../web-vitals.client";

describe("filterMetrics", () => {
  it("filters to LCP, CLS, INP only", () => {
    const metrics = [
      { id: "v1-1", name: "LCP" as const, value: 2500.123 },
      { id: "v1-2", name: "FCP" as const, value: 1000 },
      { id: "v1-3", name: "CLS" as const, value: 0.05123456 },
      { id: "v1-4", name: "TTFB" as const, value: 200 },
      { id: "v1-5", name: "INP" as const, value: 150.789 },
      { id: "v1-6", name: "FID" as const, value: 50 },
    ];

    const result = filterMetrics(metrics, "/app");

    expect(result).not.toBeNull();
    expect(result!.metrics).toHaveLength(3);
    expect(result!.metrics.map((m) => m.name)).toEqual(["LCP", "CLS", "INP"]);
  });

  it("returns null when no allowed metrics", () => {
    const metrics = [
      { id: "v1-1", name: "FCP" as const, value: 1000 },
      { id: "v1-2", name: "TTFB" as const, value: 200 },
      { id: "v1-3", name: "FID" as const, value: 50 },
    ];

    const result = filterMetrics(metrics, "/app");

    expect(result).toBeNull();
  });

  it("rounds LCP value to integer", () => {
    const metrics = [{ id: "v1-1", name: "LCP" as const, value: 2534.789 }];

    const result = filterMetrics(metrics, "/app");

    expect(result!.metrics[0].value).toBe(2535);
  });

  it("rounds INP value to integer", () => {
    const metrics = [{ id: "v1-1", name: "INP" as const, value: 156.234 }];

    const result = filterMetrics(metrics, "/app");

    expect(result!.metrics[0].value).toBe(156);
  });

  it("rounds CLS to 4 decimal places", () => {
    const metrics = [{ id: "v1-1", name: "CLS" as const, value: 0.0512345678 }];

    const result = filterMetrics(metrics, "/app");

    expect(result!.metrics[0].value).toBe(0.0512);
  });

  it("preserves route in output", () => {
    const metrics = [{ id: "v1-1", name: "LCP" as const, value: 2500 }];

    const result = filterMetrics(metrics, "/app/onboarding");

    expect(result!.metrics[0].route).toBe("/app/onboarding");
  });

  it("strips id from output (never forwarded)", () => {
    const metrics = [
      { id: "v4-1729795200000-1234567890123", name: "LCP" as const, value: 2500 },
    ];

    const result = filterMetrics(metrics, "/app");

    expect(result!.metrics[0]).not.toHaveProperty("id");
    expect(Object.keys(result!.metrics[0])).toEqual(["name", "value", "route"]);
  });

  it("strips version from output (never forwarded)", () => {
    const metrics = [
      { id: "v1-1", name: "LCP" as const, value: 2500, version: "3.1.0" },
    ];

    const result = filterMetrics(metrics, "/app");

    expect(result!.metrics[0]).not.toHaveProperty("version");
  });

  it("strips country field from output (never forwarded)", () => {
    const metrics = [
      { id: "v1-1", name: "LCP" as const, value: 2500, country: "IN" },
    ];

    const result = filterMetrics(metrics, "/app");

    expect(result!.metrics[0]).not.toHaveProperty("country");
  });
});

describe("payload privacy", () => {
  it("payload never contains shop domain", () => {
    const metrics = [
      { id: "v1-1", name: "LCP" as const, value: 2500 },
      { id: "v1-2", name: "CLS" as const, value: 0.05 },
      { id: "v1-3", name: "INP" as const, value: 150 },
    ];

    const result = filterMetrics(metrics, "/app");
    const json = JSON.stringify(result);

    expect(json).not.toContain(".myshopify.com");
    expect(json).not.toContain("shop=");
    expect(json).not.toContain("host=");
  });

  it("payload never contains query string", () => {
    const metrics = [{ id: "v1-1", name: "LCP" as const, value: 2500 }];

    const result = filterMetrics(metrics, "/app");
    const json = JSON.stringify(result);

    expect(json).not.toContain("?");
    expect(json).not.toContain("session=");
    expect(json).not.toContain("hmac=");
  });

  it("payload contains only allowed fields", () => {
    const metrics = [
      { id: "v1-1", name: "LCP" as const, value: 2500, version: "3.0.0", country: "US" },
    ];

    const result = filterMetrics(metrics, "/app");

    for (const metric of result!.metrics) {
      const keys = Object.keys(metric);
      expect(keys).toEqual(["name", "value", "route"]);
    }
  });

  it("does not include user agent, IP, or id fields", () => {
    const metrics = [{ id: "v1-1", name: "LCP" as const, value: 2500 }];

    const result = filterMetrics(metrics, "/app");
    const metricKeys = Object.keys(result!.metrics[0]);

    expect(metricKeys).not.toContain("userAgent");
    expect(metricKeys).not.toContain("ip");
    expect(metricKeys).not.toContain("ua");
    expect(metricKeys).not.toContain("id");
    expect(metricKeys).not.toContain("version");
  });
});

describe("registerWebVitalsReporter", () => {
  const originalWindow = global.window;

  beforeEach(() => {
    // @ts-expect-error - Mocking window
    global.window = { location: { pathname: "/app" } };
  });

  afterEach(() => {
    global.window = originalWindow;
    vi.restoreAllMocks();
  });

  it("is a no-op when window is undefined (SSR)", () => {
    // @ts-expect-error - Simulating SSR
    delete global.window;

    const result = registerWebVitalsReporter();

    expect(result).toBeUndefined();
  });

  it("is a no-op when shopify is undefined", () => {
    const result = registerWebVitalsReporter();

    expect(result).toBeUndefined();
  });

  it("is a no-op when shopify.webVitals is undefined", () => {
    // @ts-expect-error - Mocking shopify without webVitals
    global.window.shopify = {};

    const result = registerWebVitalsReporter();

    expect(result).toBeUndefined();
  });

  it("registers callback when shopify.webVitals exists", () => {
    const mockOnReport = vi.fn();
    // @ts-expect-error - Mocking shopify with webVitals
    global.window.shopify = {
      webVitals: { onReport: mockOnReport },
    };

    const cleanup = registerWebVitalsReporter();

    expect(mockOnReport).toHaveBeenCalledTimes(1);
    expect(typeof mockOnReport.mock.calls[0][0]).toBe("function");
    expect(typeof cleanup).toBe("function");
  });

  it("cleanup unregisters by calling onReport(null)", () => {
    const mockOnReport = vi.fn();
    // @ts-expect-error - Mocking shopify with webVitals
    global.window.shopify = {
      webVitals: { onReport: mockOnReport },
    };

    const cleanup = registerWebVitalsReporter();
    cleanup!();

    expect(mockOnReport).toHaveBeenCalledTimes(2);
    expect(mockOnReport.mock.calls[1][0]).toBeNull();
  });
});

describe("value bounds", () => {
  it("handles zero values correctly", () => {
    const metrics = [
      { id: "v1-1", name: "LCP" as const, value: 0 },
      { id: "v1-2", name: "CLS" as const, value: 0 },
      { id: "v1-3", name: "INP" as const, value: 0 },
    ];

    const result = filterMetrics(metrics, "/app");

    expect(result!.metrics[0].value).toBe(0);
    expect(result!.metrics[1].value).toBe(0);
    expect(result!.metrics[2].value).toBe(0);
  });

  it("handles large LCP values", () => {
    const metrics = [{ id: "v1-1", name: "LCP" as const, value: 59999.999 }];

    const result = filterMetrics(metrics, "/app");

    expect(result!.metrics[0].value).toBe(60000);
  });

  it("handles very small CLS values", () => {
    const metrics = [{ id: "v1-1", name: "CLS" as const, value: 0.0001 }];

    const result = filterMetrics(metrics, "/app");

    expect(result!.metrics[0].value).toBe(0.0001);
  });
});
