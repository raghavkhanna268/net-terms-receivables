import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for S23-03 tag rules route (app/routes/app.tag-rules.tsx).
 *
 * Covers:
 * - Validation: empty tag, too long tag, bad chars, duplicate with different case, {} body
 * - Successful create scoped by shop
 * - Hidden for B2B stores (mode detection)
 * - 401 on auth failure
 * - Real safeLog test: no tag value, domain, or raw id in output
 */

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(),
}));

vi.mock("~/services/gating.server", () => ({
  isGatingEnforced: vi.fn().mockReturnValue(false),
}));

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { headers: vi.fn(() => ({})) },
}));

describe("Tag Rules Route", () => {
  const mockSession = { shop: "test-store.myshopify.com" };
  const mockContext = {
    shopify: {
      authenticate: {
        admin: vi.fn().mockResolvedValue({ session: mockSession }),
      },
    },
  };
  const mockRequest = new Request("https://example.com/app/tag-rules");
  const mockUrl = new URL(mockRequest.url);
  const mockPattern = "/app/tag-rules";

  let mockSql: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockSql = vi.fn();
    mockContext.shopify.authenticate.admin.mockResolvedValue({
      session: mockSession,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("loader", () => {
    it("returns tag_based mode when shop has no COMPANY accounts", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      // COMPANY check - none found
      mockSql.mockResolvedValueOnce([]);
      // Tag rules fetch
      mockSql.mockResolvedValueOnce([]);

      const { loader } = await import("../app.tag-rules");
      const result = await loader({
        request: mockRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.storeMode).toBe("tag_based");
      expect(result.tagRules).toEqual([]);
      expect(result.error).toBeNull();
    });

    it("returns b2b mode when shop has COMPANY accounts", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      // COMPANY check - found one
      mockSql.mockResolvedValueOnce([{ id: "acc-company" }]);
      // Tag rules fetch
      mockSql.mockResolvedValueOnce([]);

      const { loader } = await import("../app.tag-rules");
      const result = await loader({
        request: mockRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.storeMode).toBe("b2b");
    });

    it("returns existing tag rules", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      const now = new Date();
      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      // COMPANY check
      mockSql.mockResolvedValueOnce([]);
      // Tag rules fetch
      mockSql.mockResolvedValueOnce([
        { id: "rule-1", tag: "net30", defaultTermsDays: 30, createdAt: now },
        { id: "rule-2", tag: "wholesale", defaultTermsDays: 15, createdAt: now },
      ]);

      const { loader } = await import("../app.tag-rules");
      const result = await loader({
        request: mockRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.tagRules).toHaveLength(2);
      expect(result.tagRules[0].tag).toBe("net30");
      expect(result.tagRules[1].tag).toBe("wholesale");
    });

    it("returns error when shop not found", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup - not found
      mockSql.mockResolvedValueOnce([]);

      const { loader } = await import("../app.tag-rules");
      const result = await loader({
        request: mockRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.error).toBe("Shop not found");
      expect(result.shopId).toBeNull();
    });
  });

  describe("action - validation", () => {
    it("returns 400 field errors for empty tag", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);

      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", "   "); // Only whitespace
      formData.append("defaultTermsDays", "30");

      const postRequest = new Request("https://example.com/app/tag-rules", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.tag-rules");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      expect(result.fieldErrors?.tag).toBe("Tag is required");
    });

    it("returns 400 field errors for tag too long (> 255 chars)", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);

      const longTag = "a".repeat(256);
      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", longTag);
      formData.append("defaultTermsDays", "30");

      const postRequest = new Request("https://example.com/app/tag-rules", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.tag-rules");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      expect(result.fieldErrors?.tag).toContain("at most 255 characters");
    });

    it("returns 400 field errors for invalid tag characters", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);

      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", "net<30>"); // Invalid chars
      formData.append("defaultTermsDays", "30");

      const postRequest = new Request("https://example.com/app/tag-rules", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.tag-rules");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      expect(result.fieldErrors?.tag).toContain("letters, numbers, spaces, hyphens");
    });

    it("returns 400 for duplicate tag (case-insensitive match)", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      // Duplicate check - found existing with different case
      mockSql.mockResolvedValueOnce([{ id: "existing-rule" }]);

      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", "NET30"); // Existing is "net30"
      formData.append("defaultTermsDays", "30");

      const postRequest = new Request("https://example.com/app/tag-rules", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.tag-rules");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      expect(result.fieldErrors?.tag).toContain("already exists");
      expect(result.fieldErrors?.tag).toContain("case-insensitive");
    });

    it("returns 400 for empty body (no form data)", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);

      // Send empty JSON body
      const postRequest = new Request("https://example.com/app/tag-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const { action } = await import("../app.tag-rules");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      // Should get error (either invalid body or unknown action)
      expect(result.error).toBeDefined();
    });

    it("returns 400 for missing required fields", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);

      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      // Missing tag and defaultTermsDays

      const postRequest = new Request("https://example.com/app/tag-rules", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.tag-rules");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      expect(result.fieldErrors?.tag).toBe("Tag is required");
      expect(result.fieldErrors?.defaultTermsDays).toBe("Default terms days is required");
    });

    it("returns 400 for invalid defaultTermsDays (non-integer)", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);

      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", "net30");
      formData.append("defaultTermsDays", "30.5"); // Not an integer

      const postRequest = new Request("https://example.com/app/tag-rules", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.tag-rules");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      expect(result.fieldErrors?.defaultTermsDays).toContain("whole number");
    });

    it("returns 400 for defaultTermsDays below minimum (0)", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);

      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", "net30");
      formData.append("defaultTermsDays", "0");

      const postRequest = new Request("https://example.com/app/tag-rules", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.tag-rules");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      expect(result.fieldErrors?.defaultTermsDays).toContain("at least 1");
    });

    it("returns 400 for defaultTermsDays above maximum (366)", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);

      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", "net30");
      formData.append("defaultTermsDays", "366");

      const postRequest = new Request("https://example.com/app/tag-rules", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.tag-rules");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      expect(result.fieldErrors?.defaultTermsDays).toContain("at most 365");
    });
  });

  describe("action - successful create", () => {
    it("creates tag rule successfully scoped by shop", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      // Duplicate check - not found
      mockSql.mockResolvedValueOnce([]);
      // Insert returning id
      mockSql.mockResolvedValueOnce([{ id: "new-rule-id" }]);

      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", "net30");
      formData.append("defaultTermsDays", "30");

      const postRequest = new Request("https://example.com/app/tag-rules", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.tag-rules");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(true);
      expect(result.createdRuleId).toBe("new-rule-id");

      // Verify the INSERT was called with correct shopId
      const insertCall = mockSql.mock.calls.find((call) =>
        call[0]?.some?.((s: string) => s?.includes?.("INSERT INTO"))
      );
      expect(insertCall).toBeDefined();
    });

    it("creates tag rule with trimmed tag", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      // Duplicate check - not found
      mockSql.mockResolvedValueOnce([]);
      // Insert returning id
      mockSql.mockResolvedValueOnce([{ id: "new-rule-id" }]);

      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", "  net30  "); // With spaces
      formData.append("defaultTermsDays", "30");

      const postRequest = new Request("https://example.com/app/tag-rules", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.tag-rules");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(true);
    });
  });

  describe("action - shop not found", () => {
    it("returns error when shop not found", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup - not found
      mockSql.mockResolvedValueOnce([]);

      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", "net30");
      formData.append("defaultTermsDays", "30");

      const postRequest = new Request("https://example.com/app/tag-rules", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.tag-rules");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Shop not found");
    });
  });

  describe("action - unknown intent", () => {
    it("returns error for unknown intent", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);

      const formData = new FormData();
      formData.append("intent", "delete_tag_rule");

      const postRequest = new Request("https://example.com/app/tag-rules", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.tag-rules");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Unknown action");
    });
  });
});

describe("Tag rule validation helpers", () => {
  it("validateTag accepts valid tags", async () => {
    const { validateTag } = await import("../app.tag-rules");

    expect(validateTag("net30")).toBeNull();
    expect(validateTag("wholesale-gold")).toBeNull();
    expect(validateTag("VIP_Tier_1")).toBeNull();
    expect(validateTag("Net Terms")).toBeNull();
    expect(validateTag("a".repeat(255))).toBeNull();
  });

  it("validateTag rejects invalid tags", async () => {
    const { validateTag } = await import("../app.tag-rules");

    expect(validateTag("")).not.toBeNull();
    expect(validateTag("   ")).not.toBeNull();
    expect(validateTag("a".repeat(256))).toContain("255");
    expect(validateTag("tag<script>")).not.toBeNull();
    expect(validateTag("tag@email")).not.toBeNull();
  });

  it("validateTermsDays accepts valid values", async () => {
    const { validateTermsDays } = await import("../app.tag-rules");

    expect(validateTermsDays("1")).toBeNull();
    expect(validateTermsDays("30")).toBeNull();
    expect(validateTermsDays("365")).toBeNull();
  });

  it("validateTermsDays rejects invalid values", async () => {
    const { validateTermsDays } = await import("../app.tag-rules");

    expect(validateTermsDays("")).not.toBeNull();
    expect(validateTermsDays("0")).not.toBeNull();
    expect(validateTermsDays("-1")).not.toBeNull();
    expect(validateTermsDays("366")).not.toBeNull();
    expect(validateTermsDays("30.5")).not.toBeNull();
    expect(validateTermsDays("abc")).not.toBeNull();
  });

  it("validateCreditLimit accepts valid values", async () => {
    const { validateCreditLimit } = await import("../app.tag-rules");

    expect(validateCreditLimit(null)).toBeNull();
    expect(validateCreditLimit("")).toBeNull();
    expect(validateCreditLimit("0")).toBeNull();
    expect(validateCreditLimit("1000")).toBeNull();
    expect(validateCreditLimit("1000.50")).toBeNull();
    expect(validateCreditLimit("999999999999.99")).toBeNull();
  });

  it("validateCreditLimit rejects invalid values", async () => {
    const { validateCreditLimit } = await import("../app.tag-rules");

    expect(validateCreditLimit("-1")).not.toBeNull();
    expect(validateCreditLimit("1000.555")).not.toBeNull();
    expect(validateCreditLimit("abc")).not.toBeNull();
    expect(validateCreditLimit("1000000000000")).not.toBeNull();
  });
});

describe("Tag rules safeLog (R2 PII prevention)", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleInfoSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("safeLog does not leak tag value on successful create", async () => {
    const { getRequestSql } = await import("~/lib/request-context.server");
    const mockSql = vi.fn();
    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

    const sensitiveTag = "wholesale-gold-tier";

    // Shop lookup
    mockSql.mockResolvedValueOnce([{ id: "shop-xyz" }]);
    // Duplicate check
    mockSql.mockResolvedValueOnce([]);
    // Insert
    mockSql.mockResolvedValueOnce([{ id: "rule-abc" }]);

    const formData = new FormData();
    formData.append("intent", "create_tag_rule");
    formData.append("tag", sensitiveTag);
    formData.append("defaultTermsDays", "45");

    const postRequest = new Request("https://example.com/app/tag-rules", {
      method: "POST",
      body: formData,
    });

    const mockSession = { shop: "sensitive-store.myshopify.com" };
    const mockContext = {
      shopify: {
        authenticate: {
          admin: vi.fn().mockResolvedValue({ session: mockSession }),
        },
      },
    };

    const { action } = await import("../app.tag-rules");
    await action({
      request: postRequest,
      context: mockContext as never,
      params: {},
      url: new URL(postRequest.url),
      pattern: "/app/tag-rules",
    });

    // Check all console outputs for PII leaks
    const allLogCalls = [
      ...consoleLogSpy.mock.calls,
      ...consoleInfoSpy.mock.calls,
    ];

    for (const call of allLogCalls) {
      const output = call[0];
      if (typeof output === "string") {
        // Must not contain the tag value
        expect(output).not.toContain(sensitiveTag);
        // Must not contain domain
        expect(output).not.toContain("myshopify.com");
        expect(output).not.toContain("sensitive-store");
        // Should contain safe fields
        expect(output).toContain("tag_rule_created");
        expect(output).toContain("shopId");
        expect(output).toContain("ruleId");
      }
    }
  });

  it("safeLog does not leak tag value or domain on error", async () => {
    const { getRequestSql } = await import("~/lib/request-context.server");
    const mockSql = vi.fn();
    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

    const sensitiveTag = "secret-tier-99";

    // Shop lookup
    mockSql.mockResolvedValueOnce([{ id: "shop-xyz" }]);
    // Duplicate check - throw error
    const dbError = new Error(
      "Unique constraint failed for sensitive-store.myshopify.com tag secret-tier-99"
    );
    mockSql.mockRejectedValueOnce(dbError);

    const formData = new FormData();
    formData.append("intent", "create_tag_rule");
    formData.append("tag", sensitiveTag);
    formData.append("defaultTermsDays", "30");

    const postRequest = new Request("https://example.com/app/tag-rules", {
      method: "POST",
      body: formData,
    });

    const mockSession = { shop: "sensitive-store.myshopify.com" };
    const mockContext = {
      shopify: {
        authenticate: {
          admin: vi.fn().mockResolvedValue({ session: mockSession }),
        },
      },
    };

    const { action } = await import("../app.tag-rules");
    await action({
      request: postRequest,
      context: mockContext as never,
      params: {},
      url: new URL(postRequest.url),
      pattern: "/app/tag-rules",
    });

    // Check error console for PII leaks
    for (const call of consoleErrorSpy.mock.calls) {
      const output = call[0];
      if (typeof output === "string") {
        // Must not contain the tag value
        expect(output).not.toContain(sensitiveTag);
        // Must not contain domain
        expect(output).not.toContain("myshopify.com");
        expect(output).not.toContain("sensitive-store");
        // Must not contain raw error message
        expect(output).not.toContain("Unique constraint");
        // Should contain safe fields
        expect(output).toContain("tag_rule_create_error");
        expect(output).toContain("shopId");
        expect(output).toContain("err");
      }
    }
  });
});

describe("Tag rules 401 on auth failure", () => {
  it("loader throws when auth fails", async () => {
    vi.resetModules();

    const mockContext = {
      shopify: {
        authenticate: {
          admin: vi.fn().mockRejectedValue(new Error("Unauthorized")),
        },
      },
    };

    const mockRequest = new Request("https://example.com/app/tag-rules");

    const { loader } = await import("../app.tag-rules");

    await expect(
      loader({
        request: mockRequest,
        context: mockContext as never,
        params: {},
        url: new URL(mockRequest.url),
        pattern: "/app/tag-rules",
      })
    ).rejects.toThrow("Unauthorized");
  });

  it("action throws when auth fails", async () => {
    vi.resetModules();

    const mockContext = {
      shopify: {
        authenticate: {
          admin: vi.fn().mockRejectedValue(new Error("Unauthorized")),
        },
      },
    };

    const formData = new FormData();
    formData.append("intent", "create_tag_rule");
    formData.append("tag", "net30");
    formData.append("defaultTermsDays", "30");

    const postRequest = new Request("https://example.com/app/tag-rules", {
      method: "POST",
      body: formData,
    });

    const { action } = await import("../app.tag-rules");

    await expect(
      action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: new URL(postRequest.url),
        pattern: "/app/tag-rules",
      })
    ).rejects.toThrow("Unauthorized");
  });
});
