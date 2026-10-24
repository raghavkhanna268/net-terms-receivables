/**
 * Gap 5 fixture: No-mock-logger rule
 * 
 * This is a test file that demonstrates patterns that violate the no-mock-logger rule.
 * The guard should flag these patterns.
 */

import { describe, it, vi, expect } from "vitest";

// SHOULD FAIL: vi.mock with log.server path
vi.mock("~/lib/log.server", () => ({
  safeLog: vi.fn(),
  toErrorCode: vi.fn().mockReturnValue("mock_error"),
  shopHash: vi.fn().mockResolvedValue("mock_hash"),
}));

// SHOULD FAIL: vi.mock with relative path to log.server
vi.mock("../../lib/log.server", () => ({
  safeLog: vi.fn(),
}));

describe("mock logger violations", () => {
  it("should not mock the logger", () => {
    expect(true).toBe(true);
  });
});
