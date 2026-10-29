/**
 * Unit tests for bounded multi-pass drain configuration.
 *
 * Verifies:
 * - MAX_DRAIN_PASSES = 4 (ceiling)
 * - PASS_START_MARGIN_MS = 3000
 * - DrainConfig.maxPasses defaults to 1 (today's single-pass behavior)
 *
 * DB-backed behavior tests are in multipass-drain-db.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

describe("Multi-pass drain configuration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("MAX_DRAIN_PASSES is 4 (ceiling)", async () => {
    const { MAX_DRAIN_PASSES } = await import("../processor.server");
    expect(MAX_DRAIN_PASSES).toBe(4);
  });

  it("PASS_START_MARGIN_MS is 3000ms", async () => {
    const { PASS_START_MARGIN_MS } = await import("../processor.server");
    expect(PASS_START_MARGIN_MS).toBe(3000);
  });

  it("DEFAULT_DRAIN_CONFIG.maxPasses is 1 (today's behavior)", async () => {
    const { DEFAULT_DRAIN_CONFIG } = await import("../processor.server");
    expect(DEFAULT_DRAIN_CONFIG.maxPasses).toBe(1);
  });

  it("time budget margin calculation: timeBudgetMs - PASS_START_MARGIN_MS = 12000ms", async () => {
    const { DEFAULT_DRAIN_CONFIG, PASS_START_MARGIN_MS } = await import("../processor.server");
    const safetyMargin = DEFAULT_DRAIN_CONFIG.timeBudgetMs - PASS_START_MARGIN_MS;
    expect(safetyMargin).toBe(12000);
  });
});
