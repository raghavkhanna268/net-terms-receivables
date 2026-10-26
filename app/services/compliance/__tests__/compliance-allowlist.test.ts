import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for compliance email sending with recipient allowlist.
 *
 * These tests verify that:
 * 1. Skipped sends don't throw
 * 2. No email addresses or domains are logged (uses REAL safeLog)
 */

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("sendDataRequestNotification - allowlist", () => {
  let consoleLogOutput: string[] = [];
  let consoleInfoOutput: string[] = [];
  let consoleWarnOutput: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    vi.unstubAllEnvs();
    consoleLogOutput = [];
    consoleInfoOutput = [];
    consoleWarnOutput = [];

    vi.spyOn(console, "log").mockImplementation((...args) => {
      consoleLogOutput.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "info").mockImplementation((...args) => {
      consoleInfoOutput.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "warn").mockImplementation((...args) => {
      consoleWarnOutput.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("does not throw when recipient is not allowlisted", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_1234");
    vi.stubEnv("RESEND_FROM", "noreply@test-example.com");
    vi.stubEnv("RESEND_TEST_RECIPIENTS", "other@test-example.com");

    const { sendDataRequestNotification } = await import("../compliance.server");

    const result = await sendDataRequestNotification(
      "test-shop.myshopify.com",
      "owner@test-shop-domain.com",
      "req-123"
    );

    expect(result.sent).toBe(false);
    expect(result.skippedReason).toBe("recipient_not_allowlisted");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not throw when allowlist is empty", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_1234");
    vi.stubEnv("RESEND_FROM", "noreply@test-example.com");
    vi.stubEnv("RESEND_TEST_RECIPIENTS", "");

    const { sendDataRequestNotification } = await import("../compliance.server");

    const result = await sendDataRequestNotification(
      "test-shop.myshopify.com",
      "owner@test-shop-domain.com",
      "req-456"
    );

    expect(result.sent).toBe(false);
    expect(result.skippedReason).toBe("recipient_allowlist_empty");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not log any email addresses when skipped (recipient_not_allowlisted)", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_1234");
    vi.stubEnv("RESEND_FROM", "noreply@test-example.com");
    vi.stubEnv("RESEND_TEST_RECIPIENTS", "allowed@test-example.com");

    const { sendDataRequestNotification } = await import("../compliance.server");

    await sendDataRequestNotification(
      "test-shop.myshopify.com",
      "owner@test-shop-domain.com",
      "req-789"
    );

    const allLogs = [...consoleLogOutput, ...consoleInfoOutput, ...consoleWarnOutput].join("\n");

    expect(allLogs).not.toContain("owner@test-shop-domain.com");
    expect(allLogs).not.toContain("test-shop-domain.com");
    expect(allLogs).not.toContain("allowed@test-example.com");
    expect(allLogs).toContain("recipient_not_allowlisted");
  });

  it("does not log any email addresses when skipped (recipient_allowlist_empty)", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_1234");
    vi.stubEnv("RESEND_FROM", "noreply@test-example.com");
    vi.stubEnv("RESEND_TEST_RECIPIENTS", "");

    const { sendDataRequestNotification } = await import("../compliance.server");

    await sendDataRequestNotification(
      "test-another-shop.myshopify.com",
      "shopowner@test-another-domain.com",
      "req-101"
    );

    const allLogs = [...consoleLogOutput, ...consoleInfoOutput, ...consoleWarnOutput].join("\n");

    expect(allLogs).not.toContain("shopowner@test-another-domain.com");
    expect(allLogs).not.toContain("test-another-domain.com");
    expect(allLogs).toContain("recipient_allowlist_empty");
  });

  it("logs reason enum only, not addresses", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_1234");
    vi.stubEnv("RESEND_FROM", "noreply@test-example.com");
    vi.stubEnv("RESEND_TEST_RECIPIENTS", "allowed@test-example.com");

    const { sendDataRequestNotification } = await import("../compliance.server");

    await sendDataRequestNotification(
      "test-myshop.myshopify.com",
      "notallowed@test-some-domain.com",
      "req-202"
    );

    const allLogs = [...consoleLogOutput, ...consoleInfoOutput, ...consoleWarnOutput].join("\n");

    expect(allLogs).toContain("data_request_email_skipped");
    expect(allLogs).toContain("recipient_not_allowlisted");

    expect(allLogs).not.toContain("notallowed@test-some-domain.com");
    expect(allLogs).not.toContain("test-some-domain.com");
    expect(allLogs).not.toContain("allowed@test-example.com");
  });

  it("sends successfully when recipient is allowlisted", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_1234");
    vi.stubEnv("RESEND_FROM", "noreply@test-example.com");
    vi.stubEnv("RESEND_TEST_RECIPIENTS", "allowed@test-example.com");

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "email-123" }),
    });

    const { sendDataRequestNotification } = await import("../compliance.server");

    const result = await sendDataRequestNotification(
      "test-shop.myshopify.com",
      "allowed@test-example.com",
      "req-303"
    );

    expect(result.sent).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("sends with empty allowlist when RESEND_RECIPIENT_ALLOWLIST_ENFORCED is 'false'", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_1234");
    vi.stubEnv("RESEND_FROM", "noreply@test-example.com");
    vi.stubEnv("RESEND_TEST_RECIPIENTS", "");
    vi.stubEnv("RESEND_RECIPIENT_ALLOWLIST_ENFORCED", "false");

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "email-enforcement-123" }),
    });

    const { sendDataRequestNotification } = await import("../compliance.server");

    const result = await sendDataRequestNotification(
      "test-enforcement-shop.myshopify.com",
      "anyrecipient@example.com",
      "req-enforcement-1"
    );

    expect(result.sent).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("blocks with empty allowlist when RESEND_RECIPIENT_ALLOWLIST_ENFORCED is unset", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_1234");
    vi.stubEnv("RESEND_FROM", "noreply@test-example.com");
    vi.stubEnv("RESEND_TEST_RECIPIENTS", "");

    const { sendDataRequestNotification } = await import("../compliance.server");

    const result = await sendDataRequestNotification(
      "test-enforcement-shop.myshopify.com",
      "anyrecipient@example.com",
      "req-enforcement-2"
    );

    expect(result.sent).toBe(false);
    expect(result.skippedReason).toBe("recipient_allowlist_empty");
    expect(mockFetch).not.toHaveBeenCalled();

    const allLogs = [...consoleLogOutput, ...consoleInfoOutput, ...consoleWarnOutput].join("\n");
    expect(allLogs).toContain("recipient_allowlist_empty");
  });

  it("blocks with empty allowlist when RESEND_RECIPIENT_ALLOWLIST_ENFORCED is 'False' (wrong case)", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_1234");
    vi.stubEnv("RESEND_FROM", "noreply@test-example.com");
    vi.stubEnv("RESEND_TEST_RECIPIENTS", "");
    vi.stubEnv("RESEND_RECIPIENT_ALLOWLIST_ENFORCED", "False");

    const { sendDataRequestNotification } = await import("../compliance.server");

    const result = await sendDataRequestNotification(
      "test-enforcement-shop.myshopify.com",
      "anyrecipient@example.com",
      "req-enforcement-3"
    );

    expect(result.sent).toBe(false);
    expect(result.skippedReason).toBe("recipient_allowlist_empty");
    expect(mockFetch).not.toHaveBeenCalled();

    const allLogs = [...consoleLogOutput, ...consoleInfoOutput, ...consoleWarnOutput].join("\n");
    expect(allLogs).toContain("recipient_allowlist_empty");
  });
});
