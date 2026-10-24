import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for S16/S17 reconcile route (app/routes/app.reconcile.tsx).
 *
 * Covers M5 (#174): safeLog/toErrorCode logging with no PII leaks.
 * Verifies that error logs contain only shopId/errorCode, never domain/email/amount.
 */

vi.mock("~/lib/log.server", () => ({
  safeLog: vi.fn(),
  toErrorCode: vi.fn((err) => {
    if (err instanceof Error) {
      return err.name !== "Error" ? err.name : "error";
    }
    if (typeof err === "object" && err !== null) {
      const obj = err as Record<string, unknown>;
      if (typeof obj.code === "string") return obj.code;
    }
    return "unknown";
  }),
}));

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
  const mockSession = { shop: "sensitive-store.myshopify.com" };
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

  describe("loader error logging (M5)", () => {
    it("logs error code, not raw error with domain", async () => {
      const { safeLog, toErrorCode } = await import("~/lib/log.server");
      const { getRequestSql } = await import("~/lib/request-context.server");
      const { resolvePlan } = await import("~/services/plan.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123", currency: "INR" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      const sensitiveError = new Error(
        "Database error for sensitive-store.myshopify.com: user@example.com owes 125000"
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

      expect(safeLog).toHaveBeenCalled();
      const safeLogMock = vi.mocked(safeLog);
      const calls = safeLogMock.mock.calls;

      for (const call of calls) {
        const logArgs = JSON.stringify(call);
        expect(logArgs).not.toContain("myshopify.com");
        expect(logArgs).not.toContain("@example.com");
        expect(logArgs).not.toContain("125000");
        expect(logArgs).not.toContain("owes");
      }

      expect(toErrorCode).toHaveBeenCalledWith(sensitiveError);
    });

    it("logs shopId and errorCode for tab counts error", async () => {
      const { safeLog } = await import("~/lib/log.server");
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

      expect(safeLog).toHaveBeenCalledWith(
        "error",
        "reconcile_tab_counts_error",
        expect.objectContaining({
          shopId: "shop-456",
          err: "TypeError",
        })
      );
    });

    it("logs shopId, view, and errorCode for loader data error", async () => {
      const { safeLog } = await import("~/lib/log.server");
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

      expect(safeLog).toHaveBeenCalledWith(
        "error",
        "reconcile_loader_error",
        expect.objectContaining({
          shopId: "shop-789",
          view: "suggested",
          err: expect.any(String),
        })
      );

      expect(result.error).toBe("Failed to load reconciliation data");
    });
  });

  describe("action error logging (M5)", () => {
    it("logs shopId, action, and errorCode for action error", async () => {
      const { safeLog } = await import("~/lib/log.server");
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

      expect(safeLog).toHaveBeenCalledWith(
        "error",
        "reconcile_action_error",
        expect.objectContaining({
          shopId: "shop-action-test",
          action: "confirm",
          err: expect.any(String),
        })
      );

      const safeLogMock = vi.mocked(safeLog);
      const logArgs = JSON.stringify(safeLogMock.mock.calls);
      expect(logArgs).not.toContain("@company.com");
      expect(logArgs).not.toContain("50000");
      expect(logArgs).not.toContain("buyer");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Action failed");
    });

    it("does not log raw error message with UTR or narration", async () => {
      const { safeLog } = await import("~/lib/log.server");
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

      const safeLogMock = vi.mocked(safeLog);
      const logArgs = JSON.stringify(safeLogMock.mock.calls);
      expect(logArgs).not.toContain("HDFC12345678");
      expect(logArgs).not.toContain("narration");
      expect(logArgs).not.toContain("INVOICE-PAY");
    });
  });

  describe("loader success paths (no errors)", () => {
    it("does not call safeLog when no errors occur", async () => {
      const { safeLog } = await import("~/lib/log.server");
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

      expect(safeLog).not.toHaveBeenCalled();
    });
  });
});
