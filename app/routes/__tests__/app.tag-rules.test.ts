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

vi.mock("~/services/drain/reconcile-handlers.server", () => ({
  enqueueReconcileStage: vi.fn().mockResolvedValue(true),
}));

vi.mock("~/services/gating.server", () => ({
  getUsageStats: vi.fn().mockResolvedValue({
    companies: { current: 5, limit: 25 },
    importsThisMonth: { current: 0, limit: -1 },
  }),
  isGatingEnforced: vi.fn().mockReturnValue(false),
}));

vi.mock("~/lib/plan-url", () => ({
  getAppHandle: vi.fn().mockReturnValue("net-terms-receivables-1"),
  buildPlanSelectionUrl: vi.fn().mockReturnValue("https://example.com/upgrade"),
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
  finishingSetup?: boolean;
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
      mockSql.mockResolvedValueOnce([{ id: "shop-123", currency: "INR" }]);
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
      mockSql.mockResolvedValueOnce([{ id: "shop-123", currency: "INR" }]);
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
      mockSql.mockResolvedValueOnce([{ id: "shop-123", currency: "INR" }]);
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

    it("returns 200 with finishingSetup flag when shop not found (S24 audit)", async () => {
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
      expect(status).toBeUndefined(); // 200 OK returns plain object
      expect(result.finishingSetup).toBe(true);
      expect(result.error).toBeNull();
      expect(result.shopId).toBeNull();
      expect(result.tagRules).toEqual([]);

      // Verify auth called; only the shop lookup ran (no further DB queries)
      expect(mockContext.shopify.authenticate.admin).toHaveBeenCalledTimes(1);
      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it("returns finishingSetup=false for normal shop lookup", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123", currency: "INR" }]);
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
      expect(result.finishingSetup).toBe(false);
      expect(result.error).toBeNull();
      expect(result.shopId).toBe("shop-123");
    });

    it("does not call getUsageStats when gating flag is off", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      const { isGatingEnforced, getUsageStats } = await import("~/services/gating.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (isGatingEnforced as ReturnType<typeof vi.fn>).mockReturnValue(false);
      (getUsageStats as ReturnType<typeof vi.fn>).mockClear();

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123", currency: "INR" }]);
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
      
      // getUsageStats should NOT have been called when flag is off
      expect(getUsageStats).not.toHaveBeenCalled();
      // Banner should not show
      expect((result as { newAccountsPausedBanner?: { show: boolean } }).newAccountsPausedBanner?.show).toBe(false);
    });

    it("loader resolves with no banner when gating flag is on but getUsageStats rejects", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      const { isGatingEnforced, getUsageStats } = await import("~/services/gating.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (isGatingEnforced as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (getUsageStats as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Database error"));

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123", currency: "INR" }]);
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
      
      // Loader should resolve despite getUsageStats error (fail-soft)
      expect(result.error).toBeNull();
      // Banner should not show when getUsageStats fails
      expect((result as { newAccountsPausedBanner?: { show: boolean } }).newAccountsPausedBanner?.show).toBe(false);
    });

    it("shows banner when gating flag is on and usage is at limit", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      const { isGatingEnforced, getUsageStats } = await import("~/services/gating.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (isGatingEnforced as ReturnType<typeof vi.fn>).mockReturnValue(true);
      // At limit: current=25, limit=25
      (getUsageStats as ReturnType<typeof vi.fn>).mockResolvedValue({
        companies: { current: 25, limit: 25 },
        importsThisMonth: { current: 0, limit: -1 },
      });

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123", currency: "INR" }]);
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
      
      // Banner should show when at limit
      expect((result as { newAccountsPausedBanner?: { show: boolean; heading?: string } }).newAccountsPausedBanner?.show).toBe(true);
      expect((result as { newAccountsPausedBanner?: { heading?: string } }).newAccountsPausedBanner?.heading).toBeDefined();
    });
  });

  describe("action - validation", () => {
    it("returns 400 field errors for empty tag", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123", currency: "INR" }]);
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
      mockSql.mockResolvedValueOnce([{ id: "shop-123", currency: "INR" }]);
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
      mockSql.mockResolvedValueOnce([{ id: "shop-123", currency: "INR" }]);
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
      mockSql.mockResolvedValueOnce([{ id: "shop-123", currency: "INR" }]);
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

    it("returns 400 for case-variant duplicate via pre-check (no INSERT attempted)", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123", currency: "INR" }]);
      // Store mode check (tag_based)
      mockSql.mockResolvedValueOnce([]);
      // Pre-check finds existing rule with different case
      mockSql.mockResolvedValueOnce([{ id: "existing-rule-id" }]);

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

      // Verify pre-check uses LOWER for case-insensitive match
      const preCheckCall = mockSql.mock.calls.find((call) =>
        call[0]?.some?.((s: string) => s?.includes?.("LOWER(tag)"))
      );
      expect(preCheckCall).toBeDefined();
      expect(preCheckCall?.[0]?.some?.((s: string) => s?.includes?.("SELECT id FROM"))).toBe(true);

      // Verify NO INSERT was attempted (pre-check returned early)
      const insertCall = mockSql.mock.calls.find((call) =>
        call[0]?.some?.((s: string) => s?.includes?.("INSERT INTO"))
      );
      expect(insertCall).toBeUndefined();
    });

    it("returns 400 for exact-case duplicate via ON CONFLICT empty RETURNING", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123", currency: "INR" }]);
      // Store mode check (tag_based)
      mockSql.mockResolvedValueOnce([]);
      // Pre-check finds no case-variant duplicate
      mockSql.mockResolvedValueOnce([]);
      // Insert returns empty due to ON CONFLICT DO NOTHING (exact-case match)
      mockSql.mockResolvedValueOnce([]);

      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", "net30"); // Exact match exists
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

      // Verify INSERT was attempted with correct ON CONFLICT target
      const insertCall = mockSql.mock.calls.find((call) =>
        call[0]?.some?.((s: string) => s?.includes?.("INSERT INTO"))
      );
      expect(insertCall).toBeDefined();
      // Assert conflict target is exactly ("shopId", tag) - no LOWER
      expect(insertCall?.[0]?.some?.((s: string) => s?.includes?.('ON CONFLICT ("shopId", tag)'))).toBe(true);
    });

    it("returns 400 for empty body (no form data)", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123", currency: "INR" }]);
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
      mockSql.mockResolvedValueOnce([{ id: "shop-123", currency: "INR" }]);
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
      mockSql.mockResolvedValueOnce([{ id: "shop-123", currency: "INR" }]);
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
      mockSql.mockResolvedValueOnce([{ id: "shop-123", currency: "INR" }]);
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
      mockSql.mockResolvedValueOnce([{ id: "shop-123", currency: "INR" }]);
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

      // Shop lookup (action uses SELECT id, domain FROM "Shop")
      mockSql.mockResolvedValueOnce([{ id: "shop-123", domain: "test-s8-tagrules.myshopify.com", currency: "INR" }]);
      // Store mode check (tag_based)
      mockSql.mockResolvedValueOnce([]);
      // Pre-check for case-insensitive duplicate - none found
      mockSql.mockResolvedValueOnce([]);
      // Insert returning id
      mockSql.mockResolvedValueOnce([{ id: "new-rule-id" }]);
      // Idempotency check - message already exists (skip enqueue)
      mockSql.mockResolvedValueOnce([{ msg_id: "existing-msg" }]);

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
      // Assert conflict target is exactly ("shopId", tag) - not LOWER(tag)
      expect(insertCall?.[0]?.some?.((s: string) => s?.includes?.('ON CONFLICT ("shopId", tag)'))).toBe(true);
    });

    it("creates tag rule with trimmed tag", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup (action uses SELECT id, domain FROM "Shop")
      mockSql.mockResolvedValueOnce([{ id: "shop-123", domain: "test-s8-tagrules.myshopify.com", currency: "INR" }]);
      // Store mode check (tag_based)
      mockSql.mockResolvedValueOnce([]);
      // Pre-check - none found
      mockSql.mockResolvedValueOnce([]);
      // Insert returning id
      mockSql.mockResolvedValueOnce([{ id: "new-rule-id" }]);
      // Idempotency check - message already exists (skip enqueue)
      mockSql.mockResolvedValueOnce([{ msg_id: "existing-msg" }]);

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

  describe("action - tag-rule customers enqueue", () => {
    it("enqueues customers reconcile when first tag rule is created", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      const { enqueueReconcileStage } = await import(
        "~/services/drain/reconcile-handlers.server"
      );
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup (action uses SELECT id, domain FROM "Shop")
      mockSql.mockResolvedValueOnce([{ id: "shop-first", domain: "test-s8-first.myshopify.com", currency: "INR" }]);
      // Store mode check (tag_based)
      mockSql.mockResolvedValueOnce([]);
      // Pre-check - none found
      mockSql.mockResolvedValueOnce([]);
      // Insert returning id
      mockSql.mockResolvedValueOnce([{ id: "first-rule-id" }]);
      // Idempotency check - no existing message
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
      expect(result.success).toBe(true);
      expect(result.createdRuleId).toBe("first-rule-id");

      // Verify enqueueReconcileStage was called with "customers"
      expect(enqueueReconcileStage).toHaveBeenCalledWith(
        expect.anything(),
        "test-s8-first.myshopify.com",
        "customers",
        expect.stringContaining("manual:")
      );
    });

    it("enqueues customers reconcile when second tag rule is created too", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      const { enqueueReconcileStage } = await import(
        "~/services/drain/reconcile-handlers.server"
      );
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (enqueueReconcileStage as ReturnType<typeof vi.fn>).mockClear();

      // Shop lookup (action uses SELECT id, domain FROM "Shop")
      mockSql.mockResolvedValueOnce([{ id: "shop-second", domain: "test-s8-second.myshopify.com", currency: "INR" }]);
      // Store mode check (tag_based)
      mockSql.mockResolvedValueOnce([]);
      // Pre-check - none found
      mockSql.mockResolvedValueOnce([]);
      // Insert returning id
      mockSql.mockResolvedValueOnce([{ id: "second-rule-id" }]);
      // Idempotency check - no existing message (second rule, but still enqueues)
      mockSql.mockResolvedValueOnce([]);

      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", "wholesale");
      formData.append("defaultTermsDays", "45");

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
      expect(result.createdRuleId).toBe("second-rule-id");

      // Verify enqueueReconcileStage WAS called (every new rule enqueues)
      expect(enqueueReconcileStage).toHaveBeenCalledWith(
        expect.anything(),
        "test-s8-second.myshopify.com",
        "customers",
        expect.stringContaining("manual:")
      );
    });

    it("does NOT enqueue when duplicate rule is rejected via ON CONFLICT", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      const { enqueueReconcileStage } = await import(
        "~/services/drain/reconcile-handlers.server"
      );
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (enqueueReconcileStage as ReturnType<typeof vi.fn>).mockClear();

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-dup", domain: "test-s8-dup.myshopify.com", currency: "INR" }]);
      // Store mode check (tag_based)
      mockSql.mockResolvedValueOnce([]);
      // Pre-check finds no case-variant duplicate
      mockSql.mockResolvedValueOnce([]);
      // Insert returns empty due to ON CONFLICT DO NOTHING (exact-case match)
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
      expect(status).toBe(400);
      expect(result.success).toBe(false);
      expect(result.fieldErrors?.tag).toContain("already exists");

      // Verify enqueueReconcileStage was NOT called (duplicate rejected before enqueue)
      expect(enqueueReconcileStage).not.toHaveBeenCalled();
    });

    it("customers enqueue is idempotent (skips if message already queued)", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      const { enqueueReconcileStage } = await import(
        "~/services/drain/reconcile-handlers.server"
      );
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (enqueueReconcileStage as ReturnType<typeof vi.fn>).mockClear();

      // Shop lookup (action uses SELECT id, domain FROM "Shop")
      mockSql.mockResolvedValueOnce([{ id: "shop-idem", domain: "test-s8-idem.myshopify.com", currency: "INR" }]);
      // Store mode check (tag_based)
      mockSql.mockResolvedValueOnce([]);
      // Pre-check - none found
      mockSql.mockResolvedValueOnce([]);
      // Insert returning id
      mockSql.mockResolvedValueOnce([{ id: "idem-rule-id" }]);
      // Idempotency check - message ALREADY exists in queue
      mockSql.mockResolvedValueOnce([{ msg_id: "existing-msg-123" }]);

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
      expect(result.success).toBe(true);
      expect(result.createdRuleId).toBe("idem-rule-id");

      // Verify enqueueReconcileStage was NOT called (idempotent skip)
      expect(enqueueReconcileStage).not.toHaveBeenCalled();
    });
  });

  describe("action - shop not found (S24 audit)", () => {
    it("returns 400 with user-friendly message when shop not found", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup - not found
      mockSql.mockResolvedValueOnce([]);

      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", "test-net30");
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
      expect(result.error).toContain("still being set up");
      // Not 404 or 500 (the user-friendly 400 is the correct response)
      expect(status).not.toBe(404);
      expect(status).not.toBe(500);

      // Verify auth called; only the shop lookup ran (no further DB queries after early return)
      expect(mockContext.shopify.authenticate.admin).toHaveBeenCalledTimes(1);
      expect(mockSql).toHaveBeenCalledTimes(1);
    });
  });

  describe("action - unknown intent", () => {
    it("returns error for unknown intent", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Shop lookup
      mockSql.mockResolvedValueOnce([{ id: "shop-123", currency: "INR" }]);
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
      mockSql.mockResolvedValueOnce([{ id: "shop-123", currency: "INR" }]);
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
      mockSql.mockResolvedValueOnce([{ id: "shop-123", currency: "INR" }]);
      // Store mode check (tag_based)
      mockSql.mockResolvedValueOnce([]);
      // Pre-check finds no duplicate
      mockSql.mockResolvedValueOnce([]);
      // Insert throws 23505 unique violation (race condition)
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
      mockSql.mockResolvedValueOnce([{ id: "shop-123", currency: "INR" }]);
      // Store mode check (tag_based)
      mockSql.mockResolvedValueOnce([]);
      // Pre-check finds no duplicate
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
    // DEL character (0x7f)
    expect(validateTag("tag\x7fdel")).toContain("control characters");
    // Line separator (U+2028) and paragraph separator (U+2029)
    expect(validateTag("tag\u2028linesep")).toContain("control characters");
    expect(validateTag("tag\u2029parasep")).toContain("control characters");
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
    mockSql.mockResolvedValueOnce([{ id: "shop-xyz", domain: "test-sensitive-store.myshopify.com", currency: "INR" }]);
    // Store mode check (tag_based)
    mockSql.mockResolvedValueOnce([]);
    // Pre-check for case-insensitive duplicate
    mockSql.mockResolvedValueOnce([]);
    // Insert
    mockSql.mockResolvedValueOnce([{ id: "rule-abc" }]);
    // Idempotency check
    mockSql.mockResolvedValueOnce([{ msg_id: "existing-msg" }]);

    const formData = new FormData();
    formData.append("intent", "create_tag_rule");
    formData.append("tag", sensitiveTag);
    formData.append("defaultTermsDays", "45");

    const postRequest = new Request("https://example.com/app/tag-rules", {
      method: "POST",
      body: formData,
    });

    const mockSession = { shop: "test-sensitive-store.myshopify.com" };
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
        expect(output).not.toContain("test-sensitive-store");
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
    mockSql.mockResolvedValueOnce([{ id: "shop-xyz", domain: "test-sensitive-store.myshopify.com", currency: "INR" }]);
    // Store mode check (tag_based)
    mockSql.mockResolvedValueOnce([]);
    // Pre-check for case-insensitive duplicate
    mockSql.mockResolvedValueOnce([]);
    // Insert - throw error
    const dbError = new Error(
      "Database error for test-sensitive-store.myshopify.com tag secret-tier-99"
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

    const mockSession = { shop: "test-sensitive-store.myshopify.com" };
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
        expect(output).not.toContain("test-sensitive-store");
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

describe("S24: Finishing setup empty state (real render)", () => {
  afterEach(() => {
    vi.doUnmock("react-router");
    vi.resetModules();
  });

  it("useRevalidator hook is called during render in finishing setup state", async () => {
    const { renderToString } = await import("react-dom/server");
    const { createElement } = await import("react");

    let revalidatorCalled = false;

    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>("react-router");
      return {
        ...actual,
        useLoaderData: () => ({
          storeMode: "tag_based",
          tagRules: [],
          shopId: null,
          error: null,
          finishingSetup: true,
        }),
        useActionData: () => null,
        useNavigation: () => ({ state: "idle" }),
        useRevalidator: () => {
          revalidatorCalled = true;
          return { revalidate: vi.fn(), state: "idle" };
        },
      };
    });

    vi.resetModules();
    const { default: TagRulesPage } = await import("../app.tag-rules");

    const html = renderToString(createElement(TagRulesPage));

    expect(html).toContain("Setting up your store");
    expect(revalidatorCalled).toBe(true);
  });

  it("renders finishing setup banner and empty state when finishingSetup is true", async () => {
    const { renderToString } = await import("react-dom/server");
    const { createElement } = await import("react");

    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>("react-router");
      return {
        ...actual,
        useLoaderData: () => ({
          storeMode: "tag_based",
          tagRules: [],
          shopId: null,
          error: null,
          finishingSetup: true,
        }),
        useActionData: () => null,
        useNavigation: () => ({ state: "idle" }),
        useRevalidator: () => ({ revalidate: vi.fn(), state: "idle" }),
      };
    });

    vi.resetModules();
    const { default: TagRulesPage } = await import("../app.tag-rules");

    const html = renderToString(createElement(TagRulesPage));

    expect(html).toContain("s-banner");
    expect(html).toContain("Setting up your store");
    expect(html).toContain("finishing setting up your store");
    expect(html).not.toContain("s-empty-state");
  });

  it("does not render create form when finishingSetup is true", async () => {
    const { renderToString } = await import("react-dom/server");
    const { createElement } = await import("react");

    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>("react-router");
      return {
        ...actual,
        useLoaderData: () => ({
          storeMode: "tag_based",
          tagRules: [],
          shopId: null,
          error: null,
          finishingSetup: true,
        }),
        useActionData: () => null,
        useNavigation: () => ({ state: "idle" }),
        useRevalidator: () => ({ revalidate: vi.fn(), state: "idle" }),
      };
    });

    vi.resetModules();
    const { default: TagRulesPage } = await import("../app.tag-rules");

    const html = renderToString(createElement(TagRulesPage));

    expect(html).not.toContain("Create Tag Rule");
    expect(html).not.toContain('name="tag"');
    expect(html).not.toContain('name="defaultTermsDays"');
  });

  it("renders normal UI with create form when finishingSetup is false", async () => {
    const { renderToString } = await import("react-dom/server");
    const { createElement } = await import("react");

    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>("react-router");
      return {
        ...actual,
        useLoaderData: () => ({
          storeMode: "tag_based",
          tagRules: [],
          shopId: "shop-123",
          error: null,
          finishingSetup: false,
          newAccountsPausedBanner: {
            show: false,
            heading: "",
            bodyText: "",
            upgradeUrl: null,
          },
        }),
        useActionData: () => null,
        useNavigation: () => ({ state: "idle" }),
        useRevalidator: () => ({ revalidate: vi.fn(), state: "idle" }),
        Form: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) =>
          createElement("form", props, children),
      };
    });

    vi.resetModules();
    const { default: TagRulesPage } = await import("../app.tag-rules");

    const html = renderToString(createElement(TagRulesPage));

    expect(html).not.toContain("Setting up your store");
    expect(html).toContain("Create Tag Rule");
    expect(html).toContain('name="tag"');
    expect(html).toContain('name="defaultTermsDays"');
  });

  it("renders existing tag rules when finishingSetup is false", async () => {
    const { renderToString } = await import("react-dom/server");
    const { createElement } = await import("react");

    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>("react-router");
      return {
        ...actual,
        useLoaderData: () => ({
          storeMode: "tag_based",
          tagRules: [
            { id: "rule-1", tag: "mock-wholesale", defaultTermsDays: 30, createdAt: "2026-10-01T00:00:00Z" },
          ],
          shopId: "shop-123",
          error: null,
          finishingSetup: false,
          newAccountsPausedBanner: {
            show: false,
            heading: "",
            bodyText: "",
            upgradeUrl: null,
          },
        }),
        useActionData: () => null,
        useNavigation: () => ({ state: "idle" }),
        useRevalidator: () => ({ revalidate: vi.fn(), state: "idle" }),
        Form: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) =>
          createElement("form", props, children),
      };
    });

    vi.resetModules();
    const { default: TagRulesPage } = await import("../app.tag-rules");

    const html = renderToString(createElement(TagRulesPage));

    expect(html).toContain("mock-wholesale");
    expect(html).toContain("Net");
    expect(html).toContain("30");
    expect(html).toContain("days");
  });

  it("renders newAccountsPausedBanner when show is true", async () => {
    const { renderToString } = await import("react-dom/server");
    const { createElement } = await import("react");

    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>("react-router");
      return {
        ...actual,
        useLoaderData: () => ({
          storeMode: "tag_based",
          tagRules: [],
          shopId: "shop-123",
          error: null,
          finishingSetup: false,
          newAccountsPausedBanner: {
            show: true,
            heading: "New accounts paused",
            bodyText: "You've reached your plan's account limit.",
            upgradeUrl: "https://admin.shopify.com/store/test/charges/net-terms/pricing_plans",
          },
        }),
        useActionData: () => null,
        useNavigation: () => ({ state: "idle" }),
        useRevalidator: () => ({ revalidate: vi.fn(), state: "idle" }),
        Form: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) =>
          createElement("form", props, children),
      };
    });

    vi.resetModules();
    const { default: TagRulesPage } = await import("../app.tag-rules");

    const html = renderToString(createElement(TagRulesPage));

    // Verify banner renders with correct content
    expect(html).toContain("s-banner");
    expect(html).toContain("New accounts paused");
    expect(html).toContain("account limit");
    expect(html).toContain("Upgrade your plan");
    expect(html).toContain("https://admin.shopify.com/store/test/charges/net-terms/pricing_plans");
  });
});
