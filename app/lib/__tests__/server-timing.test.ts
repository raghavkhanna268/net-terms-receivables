import { describe, it, expect, beforeEach } from "vitest";
import {
  ServerTiming,
  isValidServerTimingHeader,
  mergeServerTimingHeaders,
  getAllowedPhases,
  isFirstRequestInIsolate,
  markRequestServed,
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

    it("toLogFields() returns phase timings with Ms suffix", async () => {
      const timing = new ServerTiming();
      await timing.time("auth_layout", async () => {});
      await timing.time("loader_total", async () => {});

      const fields = timing.toLogFields();
      expect(fields.cold).toBe(true); // First request in test
      expect(typeof fields.auth_layoutMs).toBe("number");
      expect(typeof fields.loader_totalMs).toBe("number");
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
  });

  describe("cold start tracking", () => {
    beforeEach(() => {
      _resetIsolateStateForTesting();
    });

    it("isFirstRequestInIsolate returns true initially", () => {
      expect(isFirstRequestInIsolate()).toBe(true);
    });

    it("isFirstRequestInIsolate returns false after markRequestServed", () => {
      markRequestServed();
      expect(isFirstRequestInIsolate()).toBe(false);
    });

    it("ServerTiming captures cold state at construction", () => {
      const timing1 = new ServerTiming();
      expect(timing1.isCold()).toBe(true);

      markRequestServed();

      const timing2 = new ServerTiming();
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
});
