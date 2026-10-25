import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for S16/S17 reconcile route (app/routes/app.reconcile.tsx).
 *
 * Covers M5 (#174): safeLog/toErrorCode logging with no PII leaks.
 * Uses REAL safeLog/toErrorCode (no mocking of log.server).
 * Spies on console.error to verify no domain/email/amount in output.
 */

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(),
}));

vi.mock("~/lib/matching/queries.server", () => ({
  getUnmatchedPayments: vi.fn(),
  getSuggestedMatches: vi.fn(),
  getPaymentWithMatches: vi.fn(),
}));

vi.mock("~/services/matcher.server", () => ({
  runMatcher: vi.fn(),
  confirmMatch: vi.fn(),
  rejectMatch: vi.fn(),
  MAX_PAYMENTS_PER_REQUEST: 50,
}));

vi.mock("~/services/apply.server", () => ({
  applyMatch: vi.fn(),
  unmatchMatch: vi.fn(),
  RECONCILE_HUMAN_MESSAGES: [
    "Couldn't update the order in Shopify. Please retry.",
    "Couldn't update the order in Shopify. Please check permissions.",
    "Shopify is busy. Please try again in a moment.",
  ],
}));

vi.mock("~/services/plan.server", () => ({
  resolvePlan: vi.fn(),
}));

vi.mock("~/services/gating.server", () => ({
  isGatingEnforced: vi.fn().mockReturnValue(false),
}));

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { headers: vi.fn(() => ({})) },
}));

describe("Reconcile Route (M5)", () => {
  const mockSession = { shop: "test-sensitive-store.myshopify.com" };
  const mockContext = {
    shopify: {
      authenticate: {
        admin: vi.fn().mockResolvedValue({ session: mockSession }),
      },
    },
  };
  const mockRequest = new Request("https://example.com/app/reconcile");
  const mockUrl = new URL(mockRequest.url);
  const mockPattern = "/app/reconcile";

  let mockSql: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockSql = vi.fn();
    mockContext.shopify.authenticate.admin.mockResolvedValue({
      session: mockSession,
    });
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.clearAllMocks();
  });

  describe("loader error logging (M5)", () => {
    it("logs error code via real safeLog, not raw error with domain", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      const { resolvePlan } = await import("~/services/plan.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123", currency: "INR" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      const sensitiveError = new Error(
        "Database error for test-sensitive-store.myshopify.com: user@example.com owes 125000"
      );
      (resolvePlan as ReturnType<typeof vi.fn>).mockRejectedValue(
        sensitiveError
      );
      mockSql
        .mockRejectedValueOnce(sensitiveError)
        .mockRejectedValueOnce(sensitiveError)
        .mockRejectedValueOnce(sensitiveError)
        .mockRejectedValueOnce(sensitiveError);

      const { loader } = await import("../app.reconcile");
      await loader({
        request: mockRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(consoleErrorSpy).toHaveBeenCalled();
      const allLogs = consoleErrorSpy.mock.calls.map((c: unknown[]) => c[0]).join(" ");

      expect(allLogs).not.toContain("myshopify.com");
      expect(allLogs).not.toContain("@example.com");
      expect(allLogs).not.toContain("125000");
      expect(allLogs).not.toContain("owes");

      expect(allLogs).toContain("reconcile_tab_counts_error");
      expect(allLogs).toContain('"shopId":"shop-123"');
      expect(allLogs).toContain('"err":');
    });

    it("logs shopId and errorCode for tab counts error", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      const { resolvePlan } = await import("~/services/plan.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-456", currency: "INR" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      const dbError = new TypeError("Connection failed");
      (resolvePlan as ReturnType<typeof vi.fn>).mockRejectedValue(dbError);
      mockSql
        .mockRejectedValueOnce(dbError)
        .mockRejectedValueOnce(dbError)
        .mockRejectedValueOnce(dbError)
        .mockRejectedValueOnce(dbError);

      const { loader } = await import("../app.reconcile");
      await loader({
        request: mockRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      const logOutput = consoleErrorSpy.mock.calls[0][0];
      expect(logOutput).toContain('"event":"reconcile_tab_counts_error"');
      expect(logOutput).toContain('"shopId":"shop-456"');
      expect(logOutput).toContain('"err":"TypeError"');
    });

    it("logs shopId, stage, and errorCode for loader data error", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      const { resolvePlan } = await import("~/services/plan.server");
      const { getSuggestedMatches } = await import(
        "~/lib/matching/queries.server"
      );

      mockSql.mockResolvedValueOnce([{ id: "shop-789", currency: "INR" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({
        plan: { key: "starter" },
      });

      mockSql
        .mockResolvedValueOnce([{ count: "5" }])
        .mockResolvedValueOnce([{ count: "3" }])
        .mockResolvedValueOnce([{ count: "2" }])
        .mockResolvedValueOnce([{ count: "1" }]);

      const queryError = new Error(
        "Query failed for order owner@shop.myshopify.com"
      );
      (getSuggestedMatches as ReturnType<typeof vi.fn>).mockRejectedValue(
        queryError
      );

      const { loader } = await import("../app.reconcile");
      const result = await loader({
        request: mockRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      const logOutput = consoleErrorSpy.mock.calls[0][0];
      const parsed = JSON.parse(logOutput);

      expect(parsed.event).toBe("reconcile_loader_error");
      expect(parsed.shopId).toBe("shop-789");
      expect(parsed.stage).toBe("suggested");
      expect(parsed.err).toBeDefined();

      expect(logOutput).not.toContain("myshopify.com");
      expect(logOutput).not.toContain("@shop");

      expect(result.error).toBe("Failed to load reconciliation data");
    });

    it("maps unknown view values to 'other' in stage field", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      const { resolvePlan } = await import("~/services/plan.server");
      const { getSuggestedMatches } = await import(
        "~/lib/matching/queries.server"
      );

      mockSql.mockResolvedValueOnce([{ id: "shop-unknown", currency: "INR" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({
        plan: { key: "starter" },
      });

      mockSql
        .mockResolvedValueOnce([{ count: "0" }])
        .mockResolvedValueOnce([{ count: "0" }])
        .mockResolvedValueOnce([{ count: "0" }])
        .mockResolvedValueOnce([{ count: "0" }]);

      const queryError = new Error("Query failed");
      (getSuggestedMatches as ReturnType<typeof vi.fn>).mockRejectedValue(
        queryError
      );

      const maliciousUrl = new URL("https://example.com/app/reconcile?view=<script>alert(1)</script>");
      const maliciousRequest = new Request(maliciousUrl);

      const { loader } = await import("../app.reconcile");
      await loader({
        request: maliciousRequest,
        context: mockContext as never,
        params: {},
        url: maliciousUrl,
        pattern: mockPattern,
      });

      const logOutput = consoleErrorSpy.mock.calls[0][0];
      const parsed = JSON.parse(logOutput);

      expect(parsed.stage).toBe("other");
      expect(logOutput).not.toContain("<script>");
    });
  });

  describe("action error logging (M5)", () => {
    it("logs shopId, action, and errorCode for action error", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      const { confirmMatch } = await import("~/services/matcher.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-action-test" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      const actionError = new Error(
        "Match failed for buyer@company.com with amount 50000"
      );
      (confirmMatch as ReturnType<typeof vi.fn>).mockRejectedValue(actionError);

      const formData = new FormData();
      formData.append("intent", "confirm");
      formData.append("matchId", "match-123");

      const postRequest = new Request("https://example.com/app/reconcile", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.reconcile");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      const logOutput = consoleErrorSpy.mock.calls[0][0];
      expect(logOutput).toContain('"event":"reconcile_action_error"');
      expect(logOutput).toContain('"shopId":"shop-action-test"');
      expect(logOutput).toContain('"action":"confirm"');
      expect(logOutput).toContain('"err":');

      expect(logOutput).not.toContain("@company.com");
      expect(logOutput).not.toContain("50000");
      expect(logOutput).not.toContain("buyer");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Action failed");
    });

    it("does not log raw error message with UTR or narration", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      const { applyMatch } = await import("~/services/apply.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-utr-test" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      const errorWithSensitiveData = new Error(
        "Apply failed: UTR HDFC12345678 narration INVOICE-PAY-2024"
      );
      (applyMatch as ReturnType<typeof vi.fn>).mockRejectedValue(
        errorWithSensitiveData
      );

      const formData = new FormData();
      formData.append("intent", "apply");
      formData.append("matchId", "match-456");

      const postRequest = new Request("https://example.com/app/reconcile", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.reconcile");
      await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      const logOutput = consoleErrorSpy.mock.calls[0][0];
      expect(logOutput).not.toContain("HDFC12345678");
      expect(logOutput).not.toContain("narration");
      expect(logOutput).not.toContain("INVOICE-PAY");
    });

    it("logs hostile intent as 'other' (toSafeIntent)", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-hostile-intent" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});

      const formData = new FormData();
      // Hostile intent that could be an email or XSS attempt
      formData.append("intent", "x@y.com");

      const postRequest = new Request("https://example.com/app/reconcile", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.reconcile");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Unknown action");

      const logOutput = consoleWarnSpy.mock.calls[0][0];
      // Should log "other" instead of the hostile intent
      expect(logOutput).toContain('"event":"reconcile_unknown_action"');
      expect(logOutput).toContain('"action":"other"');
      // Should NOT contain the hostile input
      expect(logOutput).not.toContain("x@y.com");

      consoleWarnSpy.mockRestore();
    });
  });

  describe("toHumanError mapping (P2.6)", () => {
    it("maps error codes with prefixes to generic message", async () => {
      const { applyMatch } = await import("~/services/apply.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-human-error" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      (applyMatch as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: "retryable:shopify_api_error",
      });

      const formData = new FormData();
      formData.append("intent", "apply");
      formData.append("matchId", "match-123");

      const postRequest = new Request("https://example.com/app/reconcile", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.reconcile");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("An error occurred. Please try again.");
      expect(result.error).not.toContain("retryable:");
      expect(result.error).not.toContain("shopify_api_error");
    });

    it("preserves human-readable error messages", async () => {
      const { unmatchMatch } = await import("~/services/apply.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-human-readable" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      (unmatchMatch as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: "Cannot unmatch: push is in progress",
      });

      const formData = new FormData();
      formData.append("intent", "unmatch");
      formData.append("matchId", "match-456");

      const postRequest = new Request("https://example.com/app/reconcile", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.reconcile");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Cannot unmatch: push is in progress");
    });

    it("maps plain error codes (no prefix) to generic message", async () => {
      const { unmatchMatch } = await import("~/services/apply.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-code-only" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      (unmatchMatch as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: "unknown_error",
      });

      const formData = new FormData();
      formData.append("intent", "unmatch");
      formData.append("matchId", "match-789");

      const postRequest = new Request("https://example.com/app/reconcile", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.reconcile");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("An error occurred. Please try again.");
    });

    it("maps free text errors to generic message (fail-closed)", async () => {
      const { applyMatch } = await import("~/services/apply.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-free-text" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      (applyMatch as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: "Database error: connection refused to sensitive-host.example.com",
      });

      const formData = new FormData();
      formData.append("intent", "apply");
      formData.append("matchId", "match-free-text");

      const postRequest = new Request("https://example.com/app/reconcile", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.reconcile");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("An error occurred. Please try again.");
      expect(result.error).not.toContain("Database");
      expect(result.error).not.toContain("sensitive-host");
    });

    it("maps error codes with digits to generic message", async () => {
      const { applyMatch } = await import("~/services/apply.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-digits" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      (applyMatch as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: "error_code_123",
      });

      const formData = new FormData();
      formData.append("intent", "apply");
      formData.append("matchId", "match-digits");

      const postRequest = new Request("https://example.com/app/reconcile", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.reconcile");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("An error occurred. Please try again.");
    });

    it("maps prefixed error codes to generic message", async () => {
      const { applyMatch } = await import("~/services/apply.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-prefixed" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      (applyMatch as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: "permanent:shopify_rate_limit_exceeded",
      });

      const formData = new FormData();
      formData.append("intent", "apply");
      formData.append("matchId", "match-prefixed");

      const postRequest = new Request("https://example.com/app/reconcile", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.reconcile");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("An error occurred. Please try again.");
      expect(result.error).not.toContain("permanent:");
      expect(result.error).not.toContain("shopify");
    });

    it("mock RECONCILE_HUMAN_MESSAGES matches actual export (#190)", async () => {
      const { RECONCILE_HUMAN_MESSAGES } = await import("~/services/apply.server");
      expect(RECONCILE_HUMAN_MESSAGES).toEqual([
        "Couldn't update the order in Shopify. Please retry.",
        "Couldn't update the order in Shopify. Please check permissions.",
        "Shopify is busy. Please try again in a moment.",
      ]);
    });

    it("passes RECONCILE_ERROR_MESSAGES values through unchanged (#190)", async () => {
      const { RECONCILE_HUMAN_MESSAGES } = await import("~/services/apply.server");

      for (const humanMessage of RECONCILE_HUMAN_MESSAGES) {
        vi.resetModules();
        const freshApplyMatch = (await import("~/services/apply.server"))
          .applyMatch;
        const freshGetRequestSql = (
          await import("~/lib/request-context.server")
        ).getRequestSql;

        const freshMockSql = vi.fn();
        freshMockSql.mockResolvedValueOnce([
          { id: `shop-reconcile-msg-${humanMessage.slice(0, 10)}` },
        ]);
        (freshGetRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(
          freshMockSql
        );

        (freshApplyMatch as ReturnType<typeof vi.fn>).mockResolvedValue({
          success: false,
          error: humanMessage,
        });

        const formData = new FormData();
        formData.append("intent", "apply");
        formData.append("matchId", "match-reconcile-human");

        const postRequest = new Request("https://example.com/app/reconcile", {
          method: "POST",
          body: formData,
        });

        const { action } = await import("../app.reconcile");
        const result = await action({
          request: postRequest,
          context: mockContext as never,
          params: {},
          url: mockUrl,
          pattern: mockPattern,
        });

        expect(result.success).toBe(false);
        expect(result.error).toBe(humanMessage);
      }
    });

    it("maps strings with domain to generic message (fail-closed)", async () => {
      const { applyMatch } = await import("~/services/apply.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-domain-test" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      const errorWithDomain = "Error for test-store.myshopify.com";
      (applyMatch as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: errorWithDomain,
      });

      const formData = new FormData();
      formData.append("intent", "apply");
      formData.append("matchId", "match-domain");

      const postRequest = new Request("https://example.com/app/reconcile", {
        method: "POST",
        body: formData,
      });

      const { action } = await import("../app.reconcile");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("An error occurred. Please try again.");
      expect(result.error).not.toContain("myshopify");
      expect(result.error).not.toContain("test-store");
    });
  });

  describe("loader success paths (no errors)", () => {
    it("does not call console.error when no errors occur", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      const { resolvePlan } = await import("~/services/plan.server");
      const { getSuggestedMatches } = await import(
        "~/lib/matching/queries.server"
      );

      mockSql.mockResolvedValueOnce([{ id: "shop-ok", currency: "INR" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({
        plan: { key: "starter" },
      });

      mockSql
        .mockResolvedValueOnce([{ count: "0" }])
        .mockResolvedValueOnce([{ count: "0" }])
        .mockResolvedValueOnce([{ count: "0" }])
        .mockResolvedValueOnce([{ count: "0" }]);

      (getSuggestedMatches as ReturnType<typeof vi.fn>).mockResolvedValue({
        matches: [],
        totalCount: 0,
      });

      const { loader } = await import("../app.reconcile");
      await loader({
        request: mockRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });
});
