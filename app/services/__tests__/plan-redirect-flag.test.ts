import { describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * Tests for isPlanSelectionRedirectEnabled in gating.server.ts.
 *
 * Only the exact string "true" enables the redirect.
 * Missing, empty, "false", "True", "TRUE", "1", or any other value means OFF.
 */

describe("isPlanSelectionRedirectEnabled", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.PLAN_SELECTION_REDIRECT_ENABLED;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns true when PLAN_SELECTION_REDIRECT_ENABLED is exactly "true"', async () => {
    process.env.PLAN_SELECTION_REDIRECT_ENABLED = "true";
    const { isPlanSelectionRedirectEnabled } = await import("../gating.server");
    expect(isPlanSelectionRedirectEnabled()).toBe(true);
  });

  it('returns false when PLAN_SELECTION_REDIRECT_ENABLED is "false"', async () => {
    process.env.PLAN_SELECTION_REDIRECT_ENABLED = "false";
    const { isPlanSelectionRedirectEnabled } = await import("../gating.server");
    expect(isPlanSelectionRedirectEnabled()).toBe(false);
  });

  it("returns false when PLAN_SELECTION_REDIRECT_ENABLED is undefined", async () => {
    delete process.env.PLAN_SELECTION_REDIRECT_ENABLED;
    const { isPlanSelectionRedirectEnabled } = await import("../gating.server");
    expect(isPlanSelectionRedirectEnabled()).toBe(false);
  });

  it("returns false when PLAN_SELECTION_REDIRECT_ENABLED is empty string", async () => {
    process.env.PLAN_SELECTION_REDIRECT_ENABLED = "";
    const { isPlanSelectionRedirectEnabled } = await import("../gating.server");
    expect(isPlanSelectionRedirectEnabled()).toBe(false);
  });

  it('returns false when PLAN_SELECTION_REDIRECT_ENABLED is "True" (capitalized)', async () => {
    process.env.PLAN_SELECTION_REDIRECT_ENABLED = "True";
    const { isPlanSelectionRedirectEnabled } = await import("../gating.server");
    expect(isPlanSelectionRedirectEnabled()).toBe(false);
  });

  it('returns false when PLAN_SELECTION_REDIRECT_ENABLED is "TRUE" (uppercase)', async () => {
    process.env.PLAN_SELECTION_REDIRECT_ENABLED = "TRUE";
    const { isPlanSelectionRedirectEnabled } = await import("../gating.server");
    expect(isPlanSelectionRedirectEnabled()).toBe(false);
  });

  it('returns false when PLAN_SELECTION_REDIRECT_ENABLED is "1"', async () => {
    process.env.PLAN_SELECTION_REDIRECT_ENABLED = "1";
    const { isPlanSelectionRedirectEnabled } = await import("../gating.server");
    expect(isPlanSelectionRedirectEnabled()).toBe(false);
  });

  it('returns false when PLAN_SELECTION_REDIRECT_ENABLED is "yes"', async () => {
    process.env.PLAN_SELECTION_REDIRECT_ENABLED = "yes";
    const { isPlanSelectionRedirectEnabled } = await import("../gating.server");
    expect(isPlanSelectionRedirectEnabled()).toBe(false);
  });

  it("returns false when PLAN_SELECTION_REDIRECT_ENABLED is whitespace", async () => {
    process.env.PLAN_SELECTION_REDIRECT_ENABLED = "   ";
    const { isPlanSelectionRedirectEnabled } = await import("../gating.server");
    expect(isPlanSelectionRedirectEnabled()).toBe(false);
  });
});
