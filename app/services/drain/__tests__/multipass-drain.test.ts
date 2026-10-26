/**
 * Tests for bounded multi-pass drain constants.
 *
 * Verifies:
 * - MAX_DRAIN_PASSES is 4
 * - PASS_START_MARGIN_MS is 3000
 * - Constants are exported
 *
 * DB-backed tests for actual behavior are in multipass-drain-db.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

describe("Multi-pass drain constants", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("MAX_DRAIN_PASSES is 4", async () => {
    const { MAX_DRAIN_PASSES } = await import("../processor.server");
    expect(MAX_DRAIN_PASSES).toBe(4);
  });

  it("PASS_START_MARGIN_MS is 3000 (derived from timeBudgetMs)", async () => {
    const { PASS_START_MARGIN_MS } = await import("../processor.server");
    expect(PASS_START_MARGIN_MS).toBe(3000);
  });

  it("exports MAX_DRAIN_PASSES and PASS_START_MARGIN_MS", async () => {
    const mod = await import("../processor.server");
    expect(mod.MAX_DRAIN_PASSES).toBeDefined();
    expect(mod.PASS_START_MARGIN_MS).toBeDefined();
    expect(typeof mod.MAX_DRAIN_PASSES).toBe("number");
    expect(typeof mod.PASS_START_MARGIN_MS).toBe("number");
  });

  it("DEFAULT_DRAIN_CONFIG.timeBudgetMs minus PASS_START_MARGIN_MS leaves room for passes", async () => {
    const { DEFAULT_DRAIN_CONFIG, PASS_START_MARGIN_MS } = await import("../processor.server");
    const safetyMargin = DEFAULT_DRAIN_CONFIG.timeBudgetMs - PASS_START_MARGIN_MS;
    expect(safetyMargin).toBe(12000);
    expect(safetyMargin).toBeGreaterThan(0);
  });

  it("MAX_DRAIN_PASSES > 1 enables multi-pass behavior", async () => {
    const { MAX_DRAIN_PASSES } = await import("../processor.server");
    expect(MAX_DRAIN_PASSES).toBeGreaterThan(1);
  });

  it("PASS_START_MARGIN_MS creates time safety margin", async () => {
    const { PASS_START_MARGIN_MS, DEFAULT_DRAIN_CONFIG } = await import("../processor.server");
    expect(PASS_START_MARGIN_MS).toBeGreaterThan(0);
    expect(PASS_START_MARGIN_MS).toBeLessThan(DEFAULT_DRAIN_CONFIG.timeBudgetMs);
  });
});
