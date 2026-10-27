/**
 * Tests for web-vitals.client.ts
 *
 * Verifies:
 * - filterMetrics filters to LCP/CLS/INP only
 * - Payload never contains shop domain, query strings, id, or version
 * - registerWebVitalsReporter is a no-op when shopify.webVitals is missing
 * - Value rounding is correct (CLS 4 decimals, others integer)
 * - Debug logging logs only name and value
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { filterMetrics, registerWebVitalsReporter, isDebugEnabled, debugLogMetric } from "../web-vitals.client";

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

describe("server-bounds filtering", () => {
  it("drops INP values above the server maximum (30000)", () => {
    const metrics = [
      { id: "v1-1", name: "INP" as const, value: 30001 },
      { id: "v1-2", name: "INP" as const, value: 150 },
    ];

    const result = filterMetrics(metrics, "/app");

    expect(result!.metrics).toHaveLength(1);
    expect(result!.metrics[0].value).toBe(150);
  });

  it("drops LCP values above the server maximum (60000)", () => {
    const metrics = [
      { id: "v1-1", name: "LCP" as const, value: 60001 },
      { id: "v1-2", name: "LCP" as const, value: 2500 },
    ];

    const result = filterMetrics(metrics, "/app");

    expect(result!.metrics).toHaveLength(1);
    expect(result!.metrics[0].value).toBe(2500);
  });

  it("drops CLS values above the server maximum (10)", () => {
    const metrics = [
      { id: "v1-1", name: "CLS" as const, value: 10.5 },
      { id: "v1-2", name: "CLS" as const, value: 0.05 },
    ];

    const result = filterMetrics(metrics, "/app");

    expect(result!.metrics).toHaveLength(1);
    expect(result!.metrics[0].value).toBe(0.05);
  });

  it("drops negative values for every metric", () => {
    const metrics = [
      { id: "v1-1", name: "LCP" as const, value: -1 },
      { id: "v1-2", name: "CLS" as const, value: -0.1 },
      { id: "v1-3", name: "INP" as const, value: -50 },
    ];

    const result = filterMetrics(metrics, "/app");

    expect(result).toBeNull();
  });

  it("drops NaN and Infinity values", () => {
    const metrics = [
      { id: "v1-1", name: "LCP" as const, value: NaN },
      { id: "v1-2", name: "INP" as const, value: Infinity },
      { id: "v1-3", name: "CLS" as const, value: -Infinity },
      { id: "v1-4", name: "LCP" as const, value: 2500 },
    ];

    const result = filterMetrics(metrics, "/app");

    expect(result!.metrics).toHaveLength(1);
    expect(result!.metrics[0].name).toBe("LCP");
    expect(result!.metrics[0].value).toBe(2500);
  });

  it("keeps boundary values (0 and the exact maxima)", () => {
    const metrics = [
      { id: "v1-1", name: "LCP" as const, value: 0 },
      { id: "v1-2", name: "LCP" as const, value: 60000 },
      { id: "v1-3", name: "CLS" as const, value: 0 },
      { id: "v1-4", name: "CLS" as const, value: 10 },
      { id: "v1-5", name: "INP" as const, value: 0 },
      { id: "v1-6", name: "INP" as const, value: 30000 },
    ];

    const result = filterMetrics(metrics, "/app");

    expect(result!.metrics).toHaveLength(6);
    expect(result!.metrics.map((m) => m.value)).toEqual([
      0, 60000, 0, 10, 0, 30000,
    ]);
  });

  it("returns null when every metric is out of bounds or non-finite", () => {
    const metrics = [
      { id: "v1-1", name: "LCP" as const, value: 60001 },
      { id: "v1-2", name: "INP" as const, value: Infinity },
      { id: "v1-3", name: "CLS" as const, value: 10.5 },
      { id: "v1-4", name: "LCP" as const, value: NaN },
    ];

    const result = filterMetrics(metrics, "/app");

    expect(result).toBeNull();
  });
});

describe("metric count cap", () => {
  it("never emits more than 10 metrics even with more valid inputs", () => {
    const metrics = Array.from({ length: 25 }, (_, i) => ({
      id: `v1-${i}`,
      name: "LCP" as const,
      value: 2500 + i,
    }));

    const result = filterMetrics(metrics, "/app");

    expect(result).not.toBeNull();
    expect(result!.metrics.length).toBeLessThanOrEqual(10);
  });

  it("counts only in-bounds metrics toward the cap", () => {
    const outOfBounds = Array.from({ length: 15 }, (_, i) => ({
      id: `bad-${i}`,
      name: "LCP" as const,
      value: 60001 + i,
    }));
    const valid = Array.from({ length: 4 }, (_, i) => ({
      id: `ok-${i}`,
      name: "INP" as const,
      value: 100 + i,
    }));

    const result = filterMetrics([...outOfBounds, ...valid], "/app");

    expect(result!.metrics).toHaveLength(4);
    expect(result!.metrics.every((m) => m.name === "INP")).toBe(true);
  });
});

describe("debug logging", () => {
  const originalWindow = global.window;
  const originalLocalStorage = global.localStorage;

  beforeEach(() => {
    // @ts-expect-error - Mocking window
    global.window = { location: { pathname: "/app" } };
  });

  afterEach(() => {
    global.window = originalWindow;
    global.localStorage = originalLocalStorage;
    vi.restoreAllMocks();
  });

  describe("isDebugEnabled", () => {
    it("returns false when window is undefined (SSR)", () => {
      // @ts-expect-error - Simulating SSR
      delete global.window;

      expect(isDebugEnabled()).toBe(false);
    });

    it("returns false when localStorage is undefined", () => {
      // @ts-expect-error - No localStorage
      global.localStorage = undefined;

      expect(isDebugEnabled()).toBe(false);
    });

    it("returns false when debug flag is not set", () => {
      // @ts-expect-error - Mocking localStorage
      global.localStorage = {
        getItem: vi.fn().mockReturnValue(null),
      };

      expect(isDebugEnabled()).toBe(false);
    });

    it("returns false when debug flag is not '1'", () => {
      // @ts-expect-error - Mocking localStorage
      global.localStorage = {
        getItem: vi.fn().mockReturnValue("true"),
      };

      expect(isDebugEnabled()).toBe(false);
    });

    it("returns true when debug flag is '1'", () => {
      // @ts-expect-error - Mocking localStorage
      global.localStorage = {
        getItem: vi.fn().mockReturnValue("1"),
      };

      expect(isDebugEnabled()).toBe(true);
    });

    it("returns false when localStorage.getItem throws", () => {
      // @ts-expect-error - Mocking localStorage
      global.localStorage = {
        getItem: vi.fn().mockImplementation(() => {
          throw new Error("Access denied");
        }),
      };

      expect(isDebugEnabled()).toBe(false);
    });
  });

  describe("debugLogMetric", () => {
    it("logs metricName and metricValue when debug is enabled", () => {
      // @ts-expect-error - Mocking localStorage
      global.localStorage = {
        getItem: vi.fn().mockReturnValue("1"),
      };
      const consoleSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

      debugLogMetric("LCP", 2500);

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(consoleSpy).toHaveBeenCalledWith("[web-vitals]", "LCP", 2500);
    });

    it("logs only metricName and metricValue - no other arguments", () => {
      // @ts-expect-error - Mocking localStorage
      global.localStorage = {
        getItem: vi.fn().mockReturnValue("1"),
      };
      const consoleSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

      debugLogMetric("CLS", 0.05);

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const callArgs = consoleSpy.mock.calls[0];
      expect(callArgs).toHaveLength(3);
      expect(callArgs[0]).toBe("[web-vitals]");
      expect(callArgs[1]).toBe("CLS");
      expect(callArgs[2]).toBe(0.05);
    });

    it("does not log when debug is disabled", () => {
      // @ts-expect-error - Mocking localStorage
      global.localStorage = {
        getItem: vi.fn().mockReturnValue(null),
      };
      const consoleSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

      debugLogMetric("INP", 100);

      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });

  describe("filterMetrics with debug logging", () => {
    it("logs metrics when debug is enabled", () => {
      // @ts-expect-error - Mocking localStorage
      global.localStorage = {
        getItem: vi.fn().mockReturnValue("1"),
      };
      const consoleSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

      const metrics = [
        { id: "v1-1", name: "LCP" as const, value: 2500 },
        { id: "v1-2", name: "CLS" as const, value: 0.05 },
      ];

      filterMetrics(metrics, "/app");

      expect(consoleSpy).toHaveBeenCalledTimes(2);
      expect(consoleSpy).toHaveBeenCalledWith("[web-vitals]", "LCP", 2500);
      expect(consoleSpy).toHaveBeenCalledWith("[web-vitals]", "CLS", 0.05);
    });

    it("does not log non-allowed metrics even with debug enabled", () => {
      // @ts-expect-error - Mocking localStorage
      global.localStorage = {
        getItem: vi.fn().mockReturnValue("1"),
      };
      const consoleSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

      const metrics = [
        { id: "v1-1", name: "FCP" as const, value: 1000 },
        { id: "v1-2", name: "TTFB" as const, value: 200 },
      ];

      filterMetrics(metrics, "/app");

      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });
});
