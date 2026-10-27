/**
 * Tests for email-sender-config.server.ts
 *
 * Verifies the shared email configuration check used by both
 * onboarding-steps.server.ts and reminders.server.ts.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { isEmailSendingConfigured } from "../email-sender-config.server";

describe("isEmailSendingConfigured", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("with env parameter override", () => {
    it("returns false when only API key is set (sender missing)", () => {
      expect(
        isEmailSendingConfigured({
          RESEND_API_KEY: "re_fake_key_for_test_only_12345",
          RESEND_FROM: undefined,
        })
      ).toBe(false);
    });

    it("returns false when only sender is set (API key missing)", () => {
      expect(
        isEmailSendingConfigured({
          RESEND_API_KEY: undefined,
          RESEND_FROM: "noreply@example.com",
        })
      ).toBe(false);
    });

    it("returns true when both API key and sender are set", () => {
      expect(
        isEmailSendingConfigured({
          RESEND_API_KEY: "re_fake_key_for_test_only_12345",
          RESEND_FROM: "noreply@example.com",
        })
      ).toBe(true);
    });

    it("returns false when both are undefined", () => {
      expect(
        isEmailSendingConfigured({
          RESEND_API_KEY: undefined,
          RESEND_FROM: undefined,
        })
      ).toBe(false);
    });

    it("returns false when API key is empty string", () => {
      expect(
        isEmailSendingConfigured({
          RESEND_API_KEY: "",
          RESEND_FROM: "noreply@example.com",
        })
      ).toBe(false);
    });

    it("returns false when sender is empty string", () => {
      expect(
        isEmailSendingConfigured({
          RESEND_API_KEY: "re_fake_key_for_test_only_12345",
          RESEND_FROM: "",
        })
      ).toBe(false);
    });

    it("returns false when API key is whitespace only", () => {
      expect(
        isEmailSendingConfigured({
          RESEND_API_KEY: "   ",
          RESEND_FROM: "noreply@example.com",
        })
      ).toBe(false);
    });

    it("returns false when sender is whitespace only", () => {
      expect(
        isEmailSendingConfigured({
          RESEND_API_KEY: "re_fake_key_for_test_only_12345",
          RESEND_FROM: "   ",
        })
      ).toBe(false);
    });
  });

  describe("with process.env fallback", () => {
    it("returns true when both are set in process.env", () => {
      vi.stubEnv("RESEND_API_KEY", undefined);
      vi.stubEnv("RESEND_FROM", undefined);
      vi.stubEnv("RESEND_API_KEY", "re_fake_key_for_test_only_12345");
      vi.stubEnv("RESEND_FROM", "noreply@example.com");

      expect(isEmailSendingConfigured()).toBe(true);
    });

    it("returns false when only API key is in process.env", () => {
      vi.stubEnv("RESEND_API_KEY", undefined);
      vi.stubEnv("RESEND_FROM", undefined);
      vi.stubEnv("RESEND_API_KEY", "re_fake_key_for_test_only_12345");

      expect(isEmailSendingConfigured()).toBe(false);
    });

    it("returns false when only sender is in process.env", () => {
      vi.stubEnv("RESEND_API_KEY", undefined);
      vi.stubEnv("RESEND_FROM", undefined);
      vi.stubEnv("RESEND_FROM", "noreply@example.com");

      expect(isEmailSendingConfigured()).toBe(false);
    });

    it("env parameter takes precedence over process.env when provided", () => {
      vi.stubEnv("RESEND_API_KEY", undefined);
      vi.stubEnv("RESEND_FROM", undefined);
      vi.stubEnv("RESEND_API_KEY", "re_fake_key_for_test_only_12345");
      vi.stubEnv("RESEND_FROM", "noreply@example.com");

      expect(
        isEmailSendingConfigured({
          RESEND_API_KEY: "re_different_key_12345",
          RESEND_FROM: "different@example.com",
        })
      ).toBe(true);
    });

    it("undefined in env parameter falls back to process.env (nullish coalescing)", () => {
      vi.stubEnv("RESEND_API_KEY", undefined);
      vi.stubEnv("RESEND_FROM", undefined);
      vi.stubEnv("RESEND_API_KEY", "re_fake_key_for_test_only_12345");
      vi.stubEnv("RESEND_FROM", "noreply@example.com");

      expect(
        isEmailSendingConfigured({
          RESEND_API_KEY: undefined,
          RESEND_FROM: undefined,
        })
      ).toBe(true);
    });
  });
});
