/**
 * Real safeLog test for unsubscribe route (S18 #232).
 *
 * Tests that no PII (token, email, name) appears in console output
 * when processing an invalid token. Uses the real safeLog implementation
 * with a raw console mock to verify the actual log output.
 *
 * This test forces the invalid-token path and verifies the logged JSON
 * contains no sensitive data - no conditional asserts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Do NOT mock safeLog - use the real implementation
vi.mock("~/services/reminder-unsubscribe-token.server", () => ({
  verifyUnsubscribeToken: vi.fn(),
}));

vi.mock("~/services/reminder-optout.server", () => ({
  setBuyerOptOut: vi.fn(),
  isBuyerOptedOut: vi.fn(),
}));

vi.mock("postgres", () => {
  const mockEnd = vi.fn();
  const mockSql = vi.fn();
  (mockSql as typeof mockSql & { end: typeof mockEnd }).end = mockEnd;
  return { default: vi.fn(() => mockSql) };
});

vi.mock("~/lib/db-light.server", () => ({
  sqlOptions: {},
}));

import { verifyUnsubscribeToken } from "~/services/reminder-unsubscribe-token.server";
import { action } from "../unsubscribe";

const mockVerifyUnsubscribeToken = vi.mocked(verifyUnsubscribeToken);

describe("unsubscribe route safeLog PII test", () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  function createActionArgs(token: string) {
    const url = `https://example.com/unsubscribe?token=${token}`;
    return {
      request: new Request(url, {
        method: "POST",
        body: "List-Unsubscribe=One-Click",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
      context: {
        cloudflare: {
          env: { REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake" },
        },
      },
      params: {},
    } as unknown as Parameters<typeof action>[0];
  }

  it("invalid token POST logs no token, email, or name in console output", async () => {
    // Force invalid token path
    mockVerifyUnsubscribeToken.mockReturnValue(null);

    // Use a token that looks like it contains PII patterns
    const suspiciousToken = "buyer@example.com.John-Doe.secret123";

    await action(createActionArgs(suspiciousToken));

    // Collect all console output
    const allCalls = [
      ...consoleWarnSpy.mock.calls,
      ...consoleLogSpy.mock.calls,
      ...consoleErrorSpy.mock.calls,
    ];

    // Must have at least one log call (the invalid token warning)
    expect(allCalls.length).toBeGreaterThan(0);

    // Check each logged string for PII
    for (const call of allCalls) {
      const loggedString = String(call[0]);

      // Token must not appear
      expect(loggedString).not.toContain(suspiciousToken);
      expect(loggedString).not.toContain("secret123");

      // Email patterns must not appear
      expect(loggedString).not.toContain("@example.com");
      expect(loggedString).not.toContain("buyer@");

      // Name must not appear
      expect(loggedString).not.toContain("John");
      expect(loggedString).not.toContain("Doe");

      // The log should be valid JSON with expected event
      const parsed = JSON.parse(loggedString);
      expect(parsed.event).toBe("unsubscribe_invalid_token_post");

      // Verify only safe fields are present
      expect(parsed).toHaveProperty("valid", false);
      expect(Object.keys(parsed)).toEqual(["event", "valid"]);
    }
  });

  it("logs contain only allowlisted keys (valid boolean)", async () => {
    mockVerifyUnsubscribeToken.mockReturnValue(null);

    await action(createActionArgs("tampered-token-attempt"));

    const warnCalls = consoleWarnSpy.mock.calls;
    expect(warnCalls.length).toBe(1);

    const loggedJson = JSON.parse(warnCalls[0][0] as string);

    // Only 'event' and 'valid' should be present
    expect(Object.keys(loggedJson).sort()).toEqual(["event", "valid"]);
    expect(loggedJson.valid).toBe(false);
  });
});
