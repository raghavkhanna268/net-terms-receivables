/**
 * Unit tests for getSyncErrorInfo helper.
 * 
 * Verifies:
 * - All known error codes map to correct categories
 * - Messages contain appropriate wording
 * - Raw error codes NEVER appear in messages
 */
import { describe, it, expect } from "vitest";
import { getSyncErrorInfo } from "../sync-error-info";

const SESSION_ERROR_CODES = [
  "no_session",
  "invalid_grant",
  "token_refresh_failed",
  "no_refresh_token",
  "missing_credentials",
];

const GENERIC_ERROR_CODES = [
  "user_error",
  "redacted",
  "some_unknown_error",
  "random_code_123",
];

describe("getSyncErrorInfo", () => {
  describe("session errors", () => {
    it.each(SESSION_ERROR_CODES)("maps %s to session category", (code) => {
      const result = getSyncErrorInfo(code);
      expect(result.category).toBe("session");
      expect(result.message).toContain("reopen the app or reinstall");
    });

    it.each(SESSION_ERROR_CODES)("message for %s does NOT contain raw code", (code) => {
      const result = getSyncErrorInfo(code);
      expect(result.message).not.toContain(code);
    });
  });

  describe("permission error", () => {
    it("maps access_denied to permission category", () => {
      const result = getSyncErrorInfo("access_denied");
      expect(result.category).toBe("permission");
      expect(result.message).toContain("missing required permissions");
    });

    it("message does NOT contain 'access_denied'", () => {
      const result = getSyncErrorInfo("access_denied");
      expect(result.message).not.toContain("access_denied");
    });
  });

  describe("owner error", () => {
    it("maps owner_not_found to owner category", () => {
      const result = getSyncErrorInfo("owner_not_found");
      expect(result.category).toBe("owner");
      expect(result.message).toContain("no longer exists");
    });

    it("message does NOT contain 'owner_not_found'", () => {
      const result = getSyncErrorInfo("owner_not_found");
      expect(result.message).not.toContain("owner_not_found");
    });
  });

  describe("generic errors", () => {
    it.each(GENERIC_ERROR_CODES)("maps %s to generic category", (code) => {
      const result = getSyncErrorInfo(code);
      expect(result.category).toBe("generic");
      expect(result.message).toContain("contact support");
    });

    it.each(GENERIC_ERROR_CODES)("message for %s does NOT contain raw code", (code) => {
      const result = getSyncErrorInfo(code);
      expect(result.message).not.toContain(code);
    });
  });

  describe("null error code (dead-letter only)", () => {
    it("maps null to generic category", () => {
      const result = getSyncErrorInfo(null);
      expect(result.category).toBe("generic");
      expect(result.message).toContain("multiple failures");
    });

    it("message for null is user-friendly", () => {
      const result = getSyncErrorInfo(null);
      expect(result.message).toContain("contact support");
    });
  });

  describe("message content validation", () => {
    it("session message mentions reinstalling", () => {
      const result = getSyncErrorInfo("no_session");
      expect(result.message).toMatch(/reinstall|reopen/i);
    });

    it("permission message mentions permissions", () => {
      const result = getSyncErrorInfo("access_denied");
      expect(result.message).toMatch(/permission/i);
    });

    it("owner message mentions company/customer", () => {
      const result = getSyncErrorInfo("owner_not_found");
      expect(result.message).toMatch(/company.*customer|customer.*company/i);
    });

    it("all messages except owner_not_found mention retries stopped", () => {
      const codes = [...SESSION_ERROR_CODES, "access_denied", "user_error", null];
      for (const code of codes) {
        const result = getSyncErrorInfo(code);
        expect(result.message).toContain("retries");
      }
    });

    it("owner_not_found message explains the entity is deleted", () => {
      const result = getSyncErrorInfo("owner_not_found");
      expect(result.message).toContain("no longer exists");
      expect(result.message).toContain("removed or reassigned");
    });
  });
});
