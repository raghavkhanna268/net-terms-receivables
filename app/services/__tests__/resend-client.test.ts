import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendViaResend } from "../resend-client.server";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("sendViaResend", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("allowlist enforcement", () => {
    it("returns skipped with recipient_allowlist_empty when allowlist is missing", async () => {
      const result = await sendViaResend(
        {
          from: "sender@test-example.com",
          to: ["buyer@test-example.com"],
          subject: "Test",
          html: "<p>Test</p>",
        },
        { RESEND_API_KEY: "re_test_1234", RESEND_TEST_RECIPIENTS: undefined }
      );

      expect(result.sent).toBe(false);
      if (!result.sent) {
        expect(result.skipped).toBe(true);
        if (result.skipped) {
          expect(result.reason).toBe("recipient_allowlist_empty");
          expect(result.skippedCount).toBe(1);
          expect(result.allowedCount).toBe(0);
        }
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns skipped with recipient_allowlist_empty when allowlist is empty string", async () => {
      const result = await sendViaResend(
        {
          from: "sender@test-example.com",
          to: ["buyer@test-example.com"],
          subject: "Test",
          html: "<p>Test</p>",
        },
        { RESEND_API_KEY: "re_test_1234", RESEND_TEST_RECIPIENTS: "" }
      );

      expect(result.sent).toBe(false);
      if (!result.sent) {
        expect(result.skipped).toBe(true);
        if (result.skipped) {
          expect(result.reason).toBe("recipient_allowlist_empty");
        }
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns skipped with recipient_not_allowlisted when no recipients match", async () => {
      const result = await sendViaResend(
        {
          from: "sender@test-example.com",
          to: ["buyer@test-example.com"],
          subject: "Test",
          html: "<p>Test</p>",
        },
        { RESEND_API_KEY: "re_test_1234", RESEND_TEST_RECIPIENTS: "other@test-example.com" }
      );

      expect(result.sent).toBe(false);
      if (!result.sent) {
        expect(result.skipped).toBe(true);
        if (result.skipped) {
          expect(result.reason).toBe("recipient_not_allowlisted");
          expect(result.skippedCount).toBe(1);
          expect(result.allowedCount).toBe(0);
        }
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("sends to allowlisted recipient only", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "email-123" }),
      });

      const result = await sendViaResend(
        {
          from: "sender@test-example.com",
          to: ["buyer@test-example.com"],
          subject: "Test",
          html: "<p>Test</p>",
        },
        { RESEND_API_KEY: "re_test_1234", RESEND_TEST_RECIPIENTS: "buyer@test-example.com" }
      );

      expect(result.sent).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.resend.com/emails");
      const body = JSON.parse(options.body);
      expect(body.to).toEqual(["buyer@test-example.com"]);
    });

    it("filters mixed recipient list to only allowed ones", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "email-123" }),
      });

      const result = await sendViaResend(
        {
          from: "sender@test-example.com",
          to: ["allowed@test-example.com", "notallowed@test-example.com"],
          subject: "Test",
          html: "<p>Test</p>",
        },
        { RESEND_API_KEY: "re_test_1234", RESEND_TEST_RECIPIENTS: "allowed@test-example.com" }
      );

      expect(result.sent).toBe(true);
      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.to).toEqual(["allowed@test-example.com"]);
    });

    it("matches case-insensitively", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "email-123" }),
      });

      const result = await sendViaResend(
        {
          from: "sender@test-example.com",
          to: ["BUYER@TEST-EXAMPLE.COM"],
          subject: "Test",
          html: "<p>Test</p>",
        },
        { RESEND_API_KEY: "re_test_1234", RESEND_TEST_RECIPIENTS: "buyer@test-example.com" }
      );

      expect(result.sent).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("handles whitespace in allowlist", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "email-123" }),
      });

      const result = await sendViaResend(
        {
          from: "sender@test-example.com",
          to: ["buyer@test-example.com"],
          subject: "Test",
          html: "<p>Test</p>",
        },
        { RESEND_API_KEY: "re_test_1234", RESEND_TEST_RECIPIENTS: "  buyer@test-example.com  " }
      );

      expect(result.sent).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("filters cc recipients through allowlist", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "email-123" }),
      });

      await sendViaResend(
        {
          from: "sender@test-example.com",
          to: ["allowed1@test-example.com"],
          cc: ["allowed2@test-example.com", "notallowed@test-example.com"],
          subject: "Test",
          html: "<p>Test</p>",
        },
        { RESEND_API_KEY: "re_test_1234", RESEND_TEST_RECIPIENTS: "allowed1@test-example.com,allowed2@test-example.com" }
      );

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.cc).toEqual(["allowed2@test-example.com"]);
    });

    it("filters bcc recipients through allowlist", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "email-123" }),
      });

      await sendViaResend(
        {
          from: "sender@test-example.com",
          to: ["allowed1@test-example.com"],
          bcc: ["allowed2@test-example.com", "notallowed@test-example.com"],
          subject: "Test",
          html: "<p>Test</p>",
        },
        { RESEND_API_KEY: "re_test_1234", RESEND_TEST_RECIPIENTS: "allowed1@test-example.com,allowed2@test-example.com" }
      );

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.bcc).toEqual(["allowed2@test-example.com"]);
    });

    it("skips when all recipients in to/cc/bcc are not allowed", async () => {
      const result = await sendViaResend(
        {
          from: "sender@test-example.com",
          to: ["notallowed1@test-example.com"],
          cc: ["notallowed2@test-example.com"],
          bcc: ["notallowed3@test-example.com"],
          subject: "Test",
          html: "<p>Test</p>",
        },
        { RESEND_API_KEY: "re_test_1234", RESEND_TEST_RECIPIENTS: "allowed@test-example.com" }
      );

      expect(result.sent).toBe(false);
      if (!result.sent) {
        expect(result.skipped).toBe(true);
        if (result.skipped) {
          expect(result.reason).toBe("recipient_not_allowlisted");
          expect(result.skippedCount).toBe(3);
          expect(result.allowedCount).toBe(0);
        }
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("reads from process.env when env param is not provided", async () => {
      process.env.RESEND_API_KEY = "re_test_from_process_env";
      process.env.RESEND_TEST_RECIPIENTS = "buyer@test-example.com";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "email-123" }),
      });

      const result = await sendViaResend({
        from: "sender@test-example.com",
        to: ["buyer@test-example.com"],
        subject: "Test",
        html: "<p>Test</p>",
      });

      expect(result.sent).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("API key handling", () => {
    it("returns error when API key is missing", async () => {
      const result = await sendViaResend(
        {
          from: "sender@test-example.com",
          to: ["buyer@test-example.com"],
          subject: "Test",
          html: "<p>Test</p>",
        },
        { RESEND_API_KEY: undefined, RESEND_TEST_RECIPIENTS: "buyer@test-example.com" }
      );

      expect(result.sent).toBe(false);
      if (!result.sent) {
        expect(result.skipped).toBe(false);
        if (!result.skipped) {
          expect(result.error).toBe("resend_no_api_key");
          expect(result.retryable).toBe(false);
        }
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns error when API key is empty", async () => {
      const result = await sendViaResend(
        {
          from: "sender@test-example.com",
          to: ["buyer@test-example.com"],
          subject: "Test",
          html: "<p>Test</p>",
        },
        { RESEND_API_KEY: "   ", RESEND_TEST_RECIPIENTS: "buyer@test-example.com" }
      );

      expect(result.sent).toBe(false);
      if (!result.sent) {
        expect(result.skipped).toBe(false);
        if (!result.skipped) {
          expect(result.error).toBe("resend_no_api_key");
        }
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("handles 401 auth error as non-retryable", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      const result = await sendViaResend(
        {
          from: "sender@test-example.com",
          to: ["buyer@test-example.com"],
          subject: "Test",
          html: "<p>Test</p>",
        },
        { RESEND_API_KEY: "re_test_1234", RESEND_TEST_RECIPIENTS: "buyer@test-example.com" }
      );

      expect(result.sent).toBe(false);
      if (!result.sent) {
        expect(result.skipped).toBe(false);
        if (!result.skipped) {
          expect(result.error).toBe("resend_auth_error");
          expect(result.httpStatus).toBe(401);
          expect(result.retryable).toBe(false);
        }
      }
    });

    it("handles 429 rate limit as retryable", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
      });

      const result = await sendViaResend(
        {
          from: "sender@test-example.com",
          to: ["buyer@test-example.com"],
          subject: "Test",
          html: "<p>Test</p>",
        },
        { RESEND_API_KEY: "re_test_1234", RESEND_TEST_RECIPIENTS: "buyer@test-example.com" }
      );

      expect(result.sent).toBe(false);
      if (!result.sent) {
        expect(result.skipped).toBe(false);
        if (!result.skipped) {
          expect(result.error).toBe("resend_rate_limited");
          expect(result.retryable).toBe(true);
        }
      }
    });

    it("handles 5xx server error as retryable", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
      });

      const result = await sendViaResend(
        {
          from: "sender@test-example.com",
          to: ["buyer@test-example.com"],
          subject: "Test",
          html: "<p>Test</p>",
        },
        { RESEND_API_KEY: "re_test_1234", RESEND_TEST_RECIPIENTS: "buyer@test-example.com" }
      );

      expect(result.sent).toBe(false);
      if (!result.sent) {
        expect(result.skipped).toBe(false);
        if (!result.skipped) {
          expect(result.error).toBe("resend_server_error");
          expect(result.retryable).toBe(true);
        }
      }
    });

    it("handles network timeout as retryable", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network timeout"));

      const result = await sendViaResend(
        {
          from: "sender@test-example.com",
          to: ["buyer@test-example.com"],
          subject: "Test",
          html: "<p>Test</p>",
        },
        { RESEND_API_KEY: "re_test_1234", RESEND_TEST_RECIPIENTS: "buyer@test-example.com" }
      );

      expect(result.sent).toBe(false);
      if (!result.sent) {
        expect(result.skipped).toBe(false);
        if (!result.skipped) {
          expect(result.error).toBe("timeout");
          expect(result.retryable).toBe(true);
        }
      }
    });
  });

  describe("email parameters", () => {
    it("includes idempotency key in headers", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "email-123" }),
      });

      await sendViaResend(
        {
          from: "sender@test-example.com",
          to: ["buyer@test-example.com"],
          subject: "Test",
          html: "<p>Test</p>",
          idempotencyKey: "test-key-123",
        },
        { RESEND_API_KEY: "re_test_1234", RESEND_TEST_RECIPIENTS: "buyer@test-example.com" }
      );

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers["Idempotency-Key"]).toBe("test-key-123");
    });

    it("includes custom headers in body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "email-123" }),
      });

      await sendViaResend(
        {
          from: "sender@test-example.com",
          to: ["buyer@test-example.com"],
          subject: "Test",
          html: "<p>Test</p>",
          headers: { "List-Unsubscribe": "<mailto:unsub@test.com>" },
        },
        { RESEND_API_KEY: "re_test_1234", RESEND_TEST_RECIPIENTS: "buyer@test-example.com" }
      );

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.headers["List-Unsubscribe"]).toBe("<mailto:unsub@test.com>");
    });

    it("includes text content when provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "email-123" }),
      });

      await sendViaResend(
        {
          from: "sender@test-example.com",
          to: ["buyer@test-example.com"],
          subject: "Test",
          html: "<p>Test</p>",
          text: "Plain text version",
        },
        { RESEND_API_KEY: "re_test_1234", RESEND_TEST_RECIPIENTS: "buyer@test-example.com" }
      );

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.text).toBe("Plain text version");
    });
  });
});
