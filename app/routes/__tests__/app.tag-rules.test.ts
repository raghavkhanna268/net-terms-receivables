import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for S23-03 tag rules route (app/routes/app.tag-rules.tsx).
 *
 * Covers:
 * - Validation: empty tag, too long tag, commas/control chars, duplicate with different case, {} body
 * - Successful create scoped by shop
 * - Hidden for B2B stores (mode detection in loader)
 * - B2B rejection in action (400 before any write)
 * - ON CONFLICT duplicate handling (race-safe)
 * - 23505 unique violation error code handling
 * - 401 on auth failure
 * - Real safeLog test: no tag value, domain, or raw id in output
 */

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(),
}));

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { headers: vi.fn(() => ({})) },
}));

/**
 * ActionData type for test assertions.
 */
interface TestActionData {
  success?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  createdRuleId?: string;
}

/**
 * LoaderData type for test assertions.
 */
interface TestLoaderData {
  storeMode?: string;
  tagRules?: Array<{ id: string; tag: string; defaultTermsDays: number }>;
  shopId?: string | null;
  error?: string | null;
}

/**
 * Helper to extract loader data from result.
 */
function extractLoaderData(result: unknown): TestLoaderData {
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    (result as { type: string }).type === "DataWithResponseInit" &&
    "data" in result
  ) {
    return (result as { data: TestLoaderData }).data;
  }
  return result as TestLoaderData;
}

/**
 * Helper to extract action data from result.
 */
function extractActionData(result: unknown): TestActionData {
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    (result as { type: string }).type === "DataWithResponseInit" &&
    "data" in result
  ) {
    return (result as { data: TestActionData }).data;
  }
  return result as TestActionData;
}

/**
 * Helper to extract HTTP status from result.
 * Returns undefined for plain objects (200 OK).
 */
function extractStatus(result: unknown): number | undefined {
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    (result as { type: string }).type === "DataWithResponseInit" &&
    "init" in result
  ) {
    const init = (result as { init: { status?: number } | null }).init;
    return init?.status;
  }
  return undefined;
}

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
      const rawResult = await loader({
        request: mockRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      const result = extractLoaderData(rawResult);
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
      const rawResult = await loader({
        request: mockRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      const result = extractLoaderData(rawResult);
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
      const rawResult = await loader({
        request: mockRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      const result = extractLoaderData(rawResult);
      const tagRules = result.tagRules as Array<{ tag: string }>;
      expect(tagRules).toHaveLength(2);
      expect(tagRules[0].tag).toBe("net30");
      expect(tagRules[1].tag).toBe("wholesale");
    });

    it("returns error when shop not found", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup - not found
      mockSql.mockResolvedValueOnce([]);

      const { loader } = await import("../app.tag-rules");
      const rawResult = await loader({
        request: mockRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      const result = extractLoaderData(rawResult);
      const status = extractStatus(rawResult);
      expect(status).toBe(404);
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
      // Store mode check (tag_based)
      mockSql.mockResolvedValueOnce([]);

      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", "   "); // Only whitespace
      formData.append("defaultTermsDays", "30");

      const postRequest = new Request("https://example.com/app/tag-rules", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.tag-rules");
      const rawResult = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      const result = extractActionData(rawResult);
      const status = extractStatus(rawResult);
      expect(status).toBe(400);
      expect(result.success).toBe(false);
      expect(result.fieldErrors?.tag).toBe("Tag is required");
    });

    it("returns 400 field errors for tag too long (> 255 chars)", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      // Store mode check (tag_based)
      mockSql.mockResolvedValueOnce([]);

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
      const rawResult = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      const result = extractActionData(rawResult);
      const status = extractStatus(rawResult);
      expect(status).toBe(400);
      expect(result.success).toBe(false);
      expect(result.fieldErrors?.tag).toContain("at most 255 characters");
    });

    it("returns 400 field errors for tag with comma", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      // Store mode check (tag_based)
      mockSql.mockResolvedValueOnce([]);

      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", "net30,wholesale"); // Comma not allowed
      formData.append("defaultTermsDays", "30");

      const postRequest = new Request("https://example.com/app/tag-rules", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.tag-rules");
      const rawResult = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      const result = extractActionData(rawResult);
      const status = extractStatus(rawResult);
      expect(status).toBe(400);
      expect(result.success).toBe(false);
      expect(result.fieldErrors?.tag).toContain("commas");
    });

    it("returns 400 field errors for tag with control characters", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      // Store mode check (tag_based)
      mockSql.mockResolvedValueOnce([]);

      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", "net30\ttab"); // Tab not allowed
      formData.append("defaultTermsDays", "30");

      const postRequest = new Request("https://example.com/app/tag-rules", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.tag-rules");
      const rawResult = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      const result = extractActionData(rawResult);
      const status = extractStatus(rawResult);
      expect(status).toBe(400);
      expect(result.success).toBe(false);
      expect(result.fieldErrors?.tag).toContain("control characters");
    });

    it("returns 400 for duplicate tag via ON CONFLICT (case-insensitive match)", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      // Store mode check (tag_based)
      mockSql.mockResolvedValueOnce([]);
      // Insert returns empty due to ON CONFLICT DO NOTHING
      mockSql.mockResolvedValueOnce([]);

      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", "NET30"); // Existing is "net30"
      formData.append("defaultTermsDays", "30");

      const postRequest = new Request("https://example.com/app/tag-rules", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.tag-rules");
      const rawResult = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      const result = extractActionData(rawResult);
      const status = extractStatus(rawResult);
      expect(status).toBe(400);
      expect(result.success).toBe(false);
      expect(result.fieldErrors?.tag).toContain("already exists");
      expect(result.fieldErrors?.tag).toContain("case-insensitive");
    });

    it("returns 400 for empty body (no form data)", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      // Store mode check (tag_based)
      mockSql.mockResolvedValueOnce([]);

      // Send empty JSON body
      const postRequest = new Request("https://example.com/app/tag-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const { action } = await import("../app.tag-rules");
      const rawResult = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      const result = extractActionData(rawResult);
      const status = extractStatus(rawResult);
      expect(status).toBe(400);
      expect(result.success).toBe(false);
      // Should get error (either invalid body or unknown action)
      expect(result.error).toBeDefined();
    });

    it("returns 400 for missing required fields", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      // Store mode check (tag_based)
      mockSql.mockResolvedValueOnce([]);

      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      // Missing tag and defaultTermsDays

      const postRequest = new Request("https://example.com/app/tag-rules", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.tag-rules");
      const rawResult = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      const result = extractActionData(rawResult);
      const status = extractStatus(rawResult);
      expect(status).toBe(400);
      expect(result.success).toBe(false);
      expect(result.fieldErrors?.tag).toBe("Tag is required");
      expect(result.fieldErrors?.defaultTermsDays).toBe("Default terms days is required");
    });

    it("returns 400 for invalid defaultTermsDays (non-integer)", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      // Store mode check (tag_based)
      mockSql.mockResolvedValueOnce([]);

      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", "net30");
      formData.append("defaultTermsDays", "30.5"); // Not an integer

      const postRequest = new Request("https://example.com/app/tag-rules", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.tag-rules");
      const rawResult = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      const result = extractActionData(rawResult);
      const status = extractStatus(rawResult);
      expect(status).toBe(400);
      expect(result.success).toBe(false);
      expect(result.fieldErrors?.defaultTermsDays).toContain("whole number");
    });

    it("returns 400 for defaultTermsDays below minimum (0)", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      // Store mode check (tag_based)
      mockSql.mockResolvedValueOnce([]);

      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", "net30");
      formData.append("defaultTermsDays", "0");

      const postRequest = new Request("https://example.com/app/tag-rules", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.tag-rules");
      const rawResult = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      const result = extractActionData(rawResult);
      const status = extractStatus(rawResult);
      expect(status).toBe(400);
      expect(result.success).toBe(false);
      expect(result.fieldErrors?.defaultTermsDays).toContain("at least 1");
    });

    it("returns 400 for defaultTermsDays above maximum (366)", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      // Store mode check (tag_based)
      mockSql.mockResolvedValueOnce([]);

      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", "net30");
      formData.append("defaultTermsDays", "366");

      const postRequest = new Request("https://example.com/app/tag-rules", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.tag-rules");
      const rawResult = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      const result = extractActionData(rawResult);
      const status = extractStatus(rawResult);
      expect(status).toBe(400);
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
      // Store mode check (tag_based)
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
      const rawResult = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      const result = extractActionData(rawResult);
      const status = extractStatus(rawResult);
      expect(status).toBeUndefined(); // 200 OK returns plain object
      expect(result.success).toBe(true);
      expect(result.createdRuleId).toBe("new-rule-id");

      // Verify the INSERT was called with correct shopId and tag
      const insertCall = mockSql.mock.calls.find((call) =>
        call[0]?.some?.((s: string) => s?.includes?.("INSERT INTO"))
      );
      expect(insertCall).toBeDefined();
      // Assert the bound values: shopId="shop-123", tag="net30"
      expect(insertCall?.[1]).toBe("shop-123");
      expect(insertCall?.[2]).toBe("net30");
    });

    it("creates tag rule with trimmed tag", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      // Store mode check (tag_based)
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
      const rawResult = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      const result = extractActionData(rawResult);
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
      const rawResult = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      const result = extractActionData(rawResult);
      const status = extractStatus(rawResult);
      expect(status).toBe(404);
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
      // Store mode check (tag_based)
      mockSql.mockResolvedValueOnce([]);

      const formData = new FormData();
      formData.append("intent", "delete_tag_rule");

      const postRequest = new Request("https://example.com/app/tag-rules", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.tag-rules");
      const rawResult = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      const result = extractActionData(rawResult);
      const status = extractStatus(rawResult);
      expect(status).toBe(400);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Unknown action");
    });
  });

  describe("action - B2B store rejection", () => {
    it("returns 400 when action called on B2B store", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      // Store mode check - has COMPANY account (B2B)
      mockSql.mockResolvedValueOnce([{ id: "company-acc" }]);

      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", "net30");
      formData.append("defaultTermsDays", "30");

      const postRequest = new Request("https://example.com/app/tag-rules", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.tag-rules");
      const rawResult = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      const result = extractActionData(rawResult);
      const status = extractStatus(rawResult);
      expect(status).toBe(400);
      expect(result.success).toBe(false);
      expect(result.error).toContain("B2B stores");

      // Verify no INSERT was attempted
      const insertCall = mockSql.mock.calls.find((call) =>
        call[0]?.some?.((s: string) => s?.includes?.("INSERT INTO"))
      );
      expect(insertCall).toBeUndefined();
    });
  });

  describe("action - 23505 unique constraint handling", () => {
    it("returns 400 duplicate error when 23505 error occurs (race condition)", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      // Store mode check (tag_based)
      mockSql.mockResolvedValueOnce([]);
      // Insert throws 23505 unique violation
      const uniqueError = new Error("duplicate key value violates unique constraint");
      (uniqueError as Error & { code: string }).code = "23505";
      mockSql.mockRejectedValueOnce(uniqueError);

      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", "net30");
      formData.append("defaultTermsDays", "30");

      const postRequest = new Request("https://example.com/app/tag-rules", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.tag-rules");
      const rawResult = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      const result = extractActionData(rawResult);
      const status = extractStatus(rawResult);
      expect(status).toBe(400);
      expect(result.success).toBe(false);
      expect(result.fieldErrors?.tag).toContain("already exists");
    });

    it("returns 400 duplicate error when error message contains 23505", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      // Store mode check (tag_based)
      mockSql.mockResolvedValueOnce([]);
      // Insert throws error with 23505 in message
      mockSql.mockRejectedValueOnce(new Error("ERROR 23505: duplicate key value"));

      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", "net30");
      formData.append("defaultTermsDays", "30");

      const postRequest = new Request("https://example.com/app/tag-rules", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.tag-rules");
      const rawResult = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      const result = extractActionData(rawResult);
      const status = extractStatus(rawResult);
      expect(status).toBe(400);
      expect(result.success).toBe(false);
      expect(result.fieldErrors?.tag).toContain("already exists");
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
    // Now also valid under the new pattern (only commas/control chars forbidden)
    expect(validateTag("tag<script>")).toBeNull();
    expect(validateTag("tag@email")).toBeNull();
    expect(validateTag("special!#$%^&*()")).toBeNull();
    // Valid Shopify tag characters: : / . &
    expect(validateTag("category:wholesale")).toBeNull();
    expect(validateTag("tier/gold")).toBeNull();
    expect(validateTag("v2.0")).toBeNull();
    expect(validateTag("B&B")).toBeNull();
    expect(validateTag("path/to:tag.v1&more")).toBeNull();
    // Non-Latin tags (Unicode)
    expect(validateTag("卸売")).toBeNull(); // Japanese "wholesale"
    expect(validateTag("도매")).toBeNull(); // Korean "wholesale"
    expect(validateTag("оптовая")).toBeNull(); // Russian "wholesale"
    expect(validateTag("großhandel")).toBeNull(); // German "wholesale"
    expect(validateTag("批发商")).toBeNull(); // Chinese "wholesaler"
  });

  it("validateTag rejects empty tags", async () => {
    const { validateTag } = await import("../app.tag-rules");

    expect(validateTag("")).not.toBeNull();
    expect(validateTag("   ")).not.toBeNull();
  });

  it("validateTag rejects tags over 255 chars", async () => {
    const { validateTag } = await import("../app.tag-rules");

    expect(validateTag("a".repeat(256))).toContain("255");
  });

  it("validateTag rejects tags with commas", async () => {
    const { validateTag } = await import("../app.tag-rules");

    expect(validateTag("tag,other")).toContain("commas");
    expect(validateTag("a,b,c")).toContain("commas");
  });

  it("validateTag rejects tags with control characters", async () => {
    const { validateTag } = await import("../app.tag-rules");

    expect(validateTag("tag\ttab")).toContain("control characters");
    expect(validateTag("tag\nnewline")).toContain("control characters");
    expect(validateTag("tag\rreturn")).toContain("control characters");
    expect(validateTag("tag\x00null")).toContain("control characters");
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
    // Store mode check (tag_based)
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
    // Store mode check (tag_based)
    mockSql.mockResolvedValueOnce([]);
    // Insert - throw error
    const dbError = new Error(
      "Database error for sensitive-store.myshopify.com tag secret-tier-99"
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
        expect(output).not.toContain("Database error");
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
