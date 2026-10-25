/**
 * Gap 5 fixture: No-mock-logger rule
 * 
 * This is a test file that demonstrates patterns that violate the no-mock-logger rule.
 * The guard should flag these patterns.
 */

import { describe, it, vi, expect } from "vitest";
import * as log from "~/lib/log.server";

// SHOULD FAIL: vi.mock with log.server path (arrow function factory)
vi.mock("~/lib/log.server", () => ({
  safeLog: vi.fn(),
  toErrorCode: vi.fn().mockReturnValue("mock_error"),
  shopHash: vi.fn().mockResolvedValue("mock_hash"),
}));

// SHOULD FAIL: vi.mock with relative path to log.server
vi.mock("../../lib/log.server", () => ({
  safeLog: vi.fn(),
}));

// SHOULD FAIL: vi.doMock variant
vi.doMock("~/lib/log.server", () => ({
  safeLog: vi.fn(),
}));

// SHOULD FAIL: vi.mock with function expression factory (not arrow)
vi.mock("app/lib/log.server", function() {
  return {
    safeLog: vi.fn(),
    toErrorCode: vi.fn(),
  };
});

// SHOULD FAIL: vi.mock with importOriginal spread + override
vi.mock("~/lib/log.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/log.server")>();
  return {
    ...actual,
    safeLog: vi.fn(),
  };
});

describe("mock logger violations", () => {
  // SHOULD FAIL: vi.spyOn with mockImplementation (chained)
  it("chained mockImplementation", () => {
    vi.spyOn(log, "safeLog").mockImplementation(() => {});
    expect(true).toBe(true);
  });

  // SHOULD FAIL: vi.spyOn with mockImplementationOnce (chained)
  it("chained mockImplementationOnce", () => {
    vi.spyOn(log, "toErrorCode").mockImplementationOnce(() => "mock");
    expect(true).toBe(true);
  });

  // SHOULD FAIL: vi.spyOn with mockReturnValue (chained)
  it("chained mockReturnValue", () => {
    // @ts-expect-error - type mismatch intentional for guard testing
    vi.spyOn(log, "shopHash").mockReturnValue("hash");
    expect(true).toBe(true);
  });

  // SHOULD FAIL: vi.spyOn with mockReturnValueOnce (chained)
  it("chained mockReturnValueOnce", () => {
    vi.spyOn(log, "safeLog").mockReturnValueOnce(undefined);
    expect(true).toBe(true);
  });

  // SHOULD FAIL: vi.spyOn with mockResolvedValue (chained)
  it("chained mockResolvedValue", () => {
    vi.spyOn(log, "shopHash").mockResolvedValue("hash");
    expect(true).toBe(true);
  });

  // SHOULD FAIL: vi.spyOn with mockResolvedValueOnce (chained)
  it("chained mockResolvedValueOnce", () => {
    vi.spyOn(log, "toErrorCode").mockResolvedValueOnce("err");
    expect(true).toBe(true);
  });

  // SHOULD FAIL: Two-statement spy form
  it("two-statement spy form", () => {
    const spy = vi.spyOn(log, "safeLog");
    spy.mockImplementation(() => {});
    expect(true).toBe(true);
  });

  // OK: vi.spyOn without mock* method (just for observing calls)
  it("spy without mock is ok", () => {
    const spy = vi.spyOn(log, "safeLog");
    expect(spy).toBeDefined();
    spy.mockRestore();
  });
});
