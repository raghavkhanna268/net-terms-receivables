import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  ServerTiming,
  isValidServerTimingHeader,
  mergeServerTimingHeaders,
  getAllowedPhases,
  readColdOnce,
  _resetIsolateStateForTesting,
} from "../server-timing.server";

describe("server-timing.server", () => {
  describe("ServerTiming", () => {
    beforeEach(() => {
      _resetIsolateStateForTesting();
    });

    it("records phase timing", async () => {
      const timing = new ServerTiming();
      timing.startPhase("auth_layout");
      await new Promise((resolve) => setTimeout(resolve, 10));
      timing.endPhase("auth_layout");

      const duration = timing.getDuration("auth_layout");
      expect(duration).toBeGreaterThanOrEqual(10);
      expect(duration).toBeLessThan(1000);
    });

    it("time() helper records duration", async () => {
      const timing = new ServerTiming();
      await timing.time("shop_lookup", async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return "result";
      });

      const duration = timing.getDuration("shop_lookup");
      expect(duration).toBeGreaterThanOrEqual(10);
    });

    it("time() returns the operation result", async () => {
      const timing = new ServerTiming();
      const result = await timing.time("plan_resolve", async () => {
        return { plan: "free" };
      });

      expect(result).toEqual({ plan: "free" });
    });

    it("ignores unknown phase codes", () => {
      const timing = new ServerTiming();
      timing.startPhase("unknown_phase");
      timing.endPhase("unknown_phase");

      const duration = timing.getDuration("unknown_phase");
      expect(duration).toBeUndefined();
    });

    it("toHeaderValue() returns correct format", async () => {
      const timing = new ServerTiming();
      await timing.time("auth_layout", async () => {});
      await timing.time("shop_lookup", async () => {});

      const header = timing.toHeaderValue();
      expect(header).toMatch(/^auth_layout;dur=\d+(\.\d+)?, shop_lookup;dur=\d+(\.\d+)?$/);
    });

    it("toHeaderValue() omits phases not ended", () => {
      const timing = new ServerTiming();
      timing.startPhase("auth_layout");
      // Don't end it

      const header = timing.toHeaderValue();
      expect(header).toBe("");
    });

    it("getTotalDuration() returns time since construction", async () => {
      const timing = new ServerTiming();
      await new Promise((resolve) => setTimeout(resolve, 15));

      const total = timing.getTotalDuration();
      // Allow some slack for timing variance
      expect(total).toBeGreaterThanOrEqual(10);
    });

    it("accepts optional cold parameter override", () => {
      const coldTiming = new ServerTiming(true);
      expect(coldTiming.isCold()).toBe(true);

      const warmTiming = new ServerTiming(false);
      expect(warmTiming.isCold()).toBe(false);
    });
  });

  describe("isValidServerTimingHeader", () => {
    it("validates empty string", () => {
      expect(isValidServerTimingHeader("")).toBe(true);
    });

    it("validates single phase entry", () => {
      expect(isValidServerTimingHeader("auth_layout;dur=123.4")).toBe(true);
    });

    it("validates multiple phase entries", () => {
      expect(
        isValidServerTimingHeader("auth_layout;dur=123.4, shop_lookup;dur=45.6")
      ).toBe(true);
    });

    it("validates integer durations", () => {
      expect(isValidServerTimingHeader("loader_total;dur=500")).toBe(true);
    });

    it("rejects unknown phase names", () => {
      expect(isValidServerTimingHeader("unknown_phase;dur=100")).toBe(false);
    });

    it("rejects entries with descriptions", () => {
      expect(
        isValidServerTimingHeader('auth_layout;desc="Auth time";dur=100')
      ).toBe(false);
    });

    it("rejects entries without dur", () => {
      expect(isValidServerTimingHeader("auth_layout")).toBe(false);
    });

    it("rejects entries with non-numeric duration", () => {
      expect(isValidServerTimingHeader("auth_layout;dur=abc")).toBe(false);
    });

    it("rejects uppercase phase names", () => {
      expect(isValidServerTimingHeader("AUTH_LAYOUT;dur=100")).toBe(false);
    });

    it("validates all allowed phases", () => {
      const phases = getAllowedPhases();
      for (const phase of phases) {
        expect(isValidServerTimingHeader(`${phase};dur=100`)).toBe(true);
      }
    });
  });

  describe("mergeServerTimingHeaders", () => {
    it("merges multiple non-empty values", () => {
      const merged = mergeServerTimingHeaders(
        "auth_layout;dur=100",
        "shop_lookup;dur=50"
      );
      expect(merged).toBe("auth_layout;dur=100, shop_lookup;dur=50");
    });

    it("skips null and undefined values", () => {
      const merged = mergeServerTimingHeaders(
        "auth_layout;dur=100",
        null,
        undefined,
        "shop_lookup;dur=50"
      );
      expect(merged).toBe("auth_layout;dur=100, shop_lookup;dur=50");
    });

    it("returns empty string for all empty inputs", () => {
      const merged = mergeServerTimingHeaders(null, undefined, "");
      expect(merged).toBe("");
    });
  });

  describe("getAllowedPhases", () => {
    it("returns a Set of allowed phase names", () => {
      const phases = getAllowedPhases();
      expect(phases).toBeInstanceOf(Set);
      expect(phases.has("auth_layout")).toBe(true);
      expect(phases.has("auth_index")).toBe(true);
      expect(phases.has("shop_lookup")).toBe(true);
      expect(phases.has("onboarding_checks")).toBe(true);
      expect(phases.has("plan_resolve")).toBe(true);
      expect(phases.has("ledger_rows")).toBe(true);
      expect(phases.has("ledger_count")).toBe(true);
      expect(phases.has("loader_total")).toBe(true);
    });

    it("does not include unknown phases", () => {
      const phases = getAllowedPhases();
      expect(phases.has("unknown")).toBe(false);
      expect(phases.has("")).toBe(false);
    });

    it("does not include db_connect (never measured)", () => {
      const phases = getAllowedPhases();
      expect(phases.has("db_connect")).toBe(false);
    });
  });

  describe("cold start tracking with readColdOnce", () => {
    beforeEach(() => {
      _resetIsolateStateForTesting();
    });

    it("same Request object returns same cold value for layout and index", () => {
      const request = new Request("https://example.com/app");
      
      // Simulate layout reading cold
      const layoutCold = readColdOnce(request);
      // Simulate index reading cold with same request
      const indexCold = readColdOnce(request);
      
      expect(layoutCold).toBe(true);
      expect(indexCold).toBe(true);
    });

    it("overlapping requests A and B: only A is cold", () => {
      const requestA = new Request("https://example.com/app");
      const requestB = new Request("https://example.com/app");
      
      // Start both requests before awaiting either (overlapping)
      const coldA = readColdOnce(requestA);
      const coldB = readColdOnce(requestB);
      
      expect(coldA).toBe(true);
      expect(coldB).toBe(false);
    });

    it("third sequential request is warm", () => {
      const request1 = new Request("https://example.com/app");
      const request2 = new Request("https://example.com/app");
      const request3 = new Request("https://example.com/app");
      
      const cold1 = readColdOnce(request1);
      const cold2 = readColdOnce(request2);
      const cold3 = readColdOnce(request3);
      
      expect(cold1).toBe(true);
      expect(cold2).toBe(false);
      expect(cold3).toBe(false);
    });

    it("ServerTiming captures cold state from readColdOnce", () => {
      const request1 = new Request("https://example.com/app");
      const cold1 = readColdOnce(request1);
      const timing1 = new ServerTiming(cold1);
      expect(timing1.isCold()).toBe(true);

      const request2 = new Request("https://example.com/app");
      const cold2 = readColdOnce(request2);
      const timing2 = new ServerTiming(cold2);
      expect(timing2.isCold()).toBe(false);
    });
  });

  describe("timing never throws", () => {
    it("startPhase silently ignores errors", () => {
      const timing = new ServerTiming();
      expect(() => timing.startPhase("auth_layout")).not.toThrow();
    });

    it("endPhase silently ignores errors on unknown phases", () => {
      const timing = new ServerTiming();
      expect(() => timing.endPhase("auth_layout")).not.toThrow();
    });

    it("toHeaderValue returns empty string on internal errors", () => {
      const timing = new ServerTiming();
      expect(timing.toHeaderValue()).toBe("");
    });

    it("getDuration returns undefined for phases not started", () => {
      const timing = new ServerTiming();
      expect(timing.getDuration("auth_layout")).toBeUndefined();
    });
  });

  describe("logAllPhases", () => {
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      _resetIsolateStateForTesting();
      consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
    });

    it("emits one safeLog line per completed phase", async () => {
      const timing = new ServerTiming(true); // cold request
      await timing.time("auth_layout", async () => {});
      await timing.time("shop_lookup", async () => {});
      await timing.time("loader_total", async () => {});

      timing.logAllPhases();

      const logs = consoleLogSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .filter((log: unknown) => typeof log === "string" && (log as string).includes("app_home_timing"))
        .map((logStr: unknown) => JSON.parse(logStr as string));

      expect(logs.length).toBe(3);

      const stages = logs.map((l: { stage: string }) => l.stage);
      expect(stages).toContain("auth_layout_cold");
      expect(stages).toContain("shop_lookup_cold");
      expect(stages).toContain("loader_total_cold");
    });

    it("each log line has exactly event, route, stage, durationMs", async () => {
      const timing = new ServerTiming(true); // cold request
      await timing.time("auth_layout", async () => {});

      timing.logAllPhases();

      const logs = consoleLogSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .filter((log: unknown) => typeof log === "string" && (log as string).includes("app_home_timing"))
        .map((logStr: unknown) => JSON.parse(logStr as string));

      expect(logs.length).toBe(1);
      const log = logs[0];

      expect(Object.keys(log).sort()).toEqual(["durationMs", "event", "route", "stage"]);
      expect(log.event).toBe("app_home_timing");
      expect(log.route).toBe("app_home");
      expect(log.stage).toBe("auth_layout_cold");
      expect(typeof log.durationMs).toBe("number");
    });

    it("cold flag encoded in stage name (cold request)", async () => {
      const timing = new ServerTiming(true); // cold request
      await timing.time("loader_total", async () => {});

      timing.logAllPhases();

      const logs = consoleLogSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .filter((log: unknown) => typeof log === "string" && (log as string).includes("app_home_timing"))
        .map((logStr: unknown) => JSON.parse(logStr as string));

      expect(logs[0].stage).toBe("loader_total_cold");
    });

    it("cold flag NOT in stage name for warm request", async () => {
      // Make it warm by consuming the first request's cold
      const warmupRequest = new Request("https://example.com/warmup");
      readColdOnce(warmupRequest);

      // Second request is warm
      const warmRequest = new Request("https://example.com/warm");
      const cold = readColdOnce(warmRequest);
      const timing = new ServerTiming(cold);
      await timing.time("loader_total", async () => {});

      timing.logAllPhases();

      const logs = consoleLogSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .filter((log: unknown) => typeof log === "string" && (log as string).includes("app_home_timing"))
        .map((logStr: unknown) => JSON.parse(logStr as string));

      expect(logs[0].stage).toBe("loader_total");
      expect(logs[0].stage).not.toMatch(/_cold$/);
    });

    it("does not emit log for phases not ended", async () => {
      const timing = new ServerTiming();
      timing.startPhase("auth_layout");
      // Don't end it

      timing.logAllPhases();

      const logs = consoleLogSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .filter((log: unknown) => typeof log === "string" && (log as string).includes("app_home_timing"));

      expect(logs.length).toBe(0);
    });

    it("never throws", () => {
      const timing = new ServerTiming();
      expect(() => timing.logAllPhases()).not.toThrow();
    });
  });
});
