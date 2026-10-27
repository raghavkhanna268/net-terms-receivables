import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for A9 landing page copy change.
 *
 * Verifies the landing page contains the new phrase about
 * suggested matches for confirmation and does NOT contain
 * the old "automatically" matching copy.
 */

describe("Landing Page Copy (A9)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("renders the new suggested matches copy", async () => {
    const { default: App } = await import("../_index/route");

    const result = App();

    const stringified = JSON.stringify(result);

    expect(stringified).toContain("suggested matches");
    expect(stringified).toContain("for you to confirm");
  });

  it("does NOT contain the old 'automatically' matching copy", async () => {
    const { default: App } = await import("../_index/route");

    const result = App();

    const stringified = JSON.stringify(result);

    expect(stringified).not.toContain("back to orders automatically");
  });

  it("contains the correct Payment Matching feature description", async () => {
    const { default: App } = await import("../_index/route");

    const result = App();

    const stringified = JSON.stringify(result);

    expect(stringified).toContain("Payment Matching");
    expect(stringified).toContain("NEFT/RTGS/IMPS/UPI/CMS");
    expect(stringified).toContain("get suggested matches to orders for you to confirm");
  });
});
