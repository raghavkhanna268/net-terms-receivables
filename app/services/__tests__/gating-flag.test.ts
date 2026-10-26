import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for gating-flag.server.ts - the leaf module that checks PLAN_GATING_ENFORCED.
 *
 * This module is the single source of truth for the gating enforcement flag.
 * Both gating.server.ts and reminders.server.ts import from here.
 *
 * IMPORTANT: Only the exact string 'true' enables gating.
 * The old code accepted '1' as well, but this was removed to enforce strictness.
 * These tests pin that behavior to prevent regression.
 */

describe("gating-flag.server.ts", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("isGatingEnforced - strict 'true' only", () => {
    /**
     * Table-driven test pinning isGatingEnforced behavior.
     * Only the exact string 'true' should return true.
     *
     * NOTE: '1' previously enabled gating in older code. It must NOT now.
     */
    const testCases: Array<{
      envValue: string | undefined;
      expected: boolean;
      description: string;
    }> = [
      { envValue: "false", expected: false, description: "'false' - the production value" },
      { envValue: undefined, expected: false, description: "unset" },
      { envValue: "", expected: false, description: "empty string" },
      { envValue: "TRUE", expected: false, description: "'TRUE' - uppercase is NOT accepted" },
      { envValue: " true", expected: false, description: "' true' - leading space is NOT accepted" },
      { envValue: "true ", expected: false, description: "'true ' - trailing space is NOT accepted" },
      { envValue: "True", expected: false, description: "'True' - title case is NOT accepted" },
      { envValue: "1", expected: false, description: "'1' - numeric is NOT accepted (regression)" },
      { envValue: "yes", expected: false, description: "'yes' is NOT accepted" },
      { envValue: "on", expected: false, description: "'on' is NOT accepted" },
      { envValue: "true", expected: true, description: "'true' - exact match enables gating" },
    ];

    for (const { envValue, expected, description } of testCases) {
      it(`returns ${expected} when PLAN_GATING_ENFORCED is ${description}`, async () => {
        if (envValue === undefined) {
          delete (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED;
        } else {
          (process.env as Record<string, string>).PLAN_GATING_ENFORCED = envValue;
        }

        vi.resetModules();
        const { isGatingEnforced } = await import("../gating-flag.server");

        expect(isGatingEnforced()).toBe(expected);
      });
    }

    it("'1' does NOT enable gating - explicit regression test", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();
      const { isGatingEnforced } = await import("../gating-flag.server");

      expect(isGatingEnforced()).toBe(false);
    });
  });

  describe("production state PLAN_GATING_ENFORCED='false'", () => {
    it("with 'false', isGatingEnforced returns false - behavior unchanged", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "false";
      vi.resetModules();
      const { isGatingEnforced } = await import("../gating-flag.server");

      expect(isGatingEnforced()).toBe(false);
    });

    it("with 'false', reminders treat all accounts as active (gated_at ignored)", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "false";
      vi.resetModules();

      const { isGatingEnforced } = await import("../gating-flag.server");
      expect(isGatingEnforced()).toBe(false);

      const { isAccountActive } = await import("../gating.server");
      expect(isAccountActive(null)).toBe(true);
      expect(isAccountActive(new Date())).toBe(true);
    });

    it("with 'true', reminders respect gated_at (gated accounts are inactive)", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "true";
      vi.resetModules();

      const { isGatingEnforced } = await import("../gating-flag.server");
      expect(isGatingEnforced()).toBe(true);

      const { isAccountActive } = await import("../gating.server");
      expect(isAccountActive(null)).toBe(true);
      expect(isAccountActive(new Date())).toBe(false);
    });
  });
});
