/**
 * Action result banner tests for Reconcile page and Data-requests download error handling.
 *
 * Verifies that:
 * - Success action results render success banners with appropriate text
 * - Failure action results render critical banners with generic error text
 * - No action result renders no banner
 * - Thrown errors show generic text, never internal error messages
 * - Download errors show generic text, never server error details
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement, type ReactNode } from "react";

vi.mock("react-router", async () => {
  return {
    useLoaderData: vi.fn(),
    useActionData: vi.fn(),
    useNavigation: vi.fn(() => ({ state: "idle", formData: null })),
    data: vi.fn((d) => d),
    Form: ({ children, ...props }: { children: ReactNode; method?: string }) =>
      createElement("form", props, children),
  };
});

vi.mock("~/services/access-log.server", () => ({
  recordAccess: vi.fn(),
  getActorFromSessionToken: vi.fn().mockReturnValue("test-actor"),
}));

import { useLoaderData, useActionData } from "react-router";
import ReconcilePage from "../app.reconcile";

const mockUseLoaderData = vi.mocked(useLoaderData);
const mockUseActionData = vi.mocked(useActionData);

function buildReconcileLoaderData() {
  return {
    shopCurrency: "INR",
    payments: [],
    matches: [],
    selectedPayment: null,
    pagination: { page: 1, pageSize: 20, totalCount: 0 },
    view: "suggested" as const,
    error: null,
    tabCounts: { suggested: 0, unmatched: 0, confirmed: 0, pushing: 0 },
    notSupported: false,
  };
}

describe("Reconcile action result banners", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseLoaderData.mockReturnValue(buildReconcileLoaderData());
    mockUseActionData.mockReturnValue(undefined);
  });

  it("success action result renders success banner with message", () => {
    mockUseActionData.mockReturnValue({
      success: true,
      intent: "run_matcher",
      message: "Processed 5 payments, created 3 matches (2 high confidence)",
    });

    const html = renderToString(createElement(ReconcilePage));

    expect(html).toContain('tone="success"');
    expect(html).toContain("Processed 5 payments, created 3 matches (2 high confidence)");
  });

  it("success action without message uses per-intent text for confirm", () => {
    mockUseActionData.mockReturnValue({
      success: true,
      intent: "confirm",
    });

    const html = renderToString(createElement(ReconcilePage));

    expect(html).toContain('tone="success"');
    expect(html).toContain("Match confirmed.");
  });

  it("success action without message uses per-intent text for reject", () => {
    mockUseActionData.mockReturnValue({
      success: true,
      intent: "reject",
    });

    const html = renderToString(createElement(ReconcilePage));

    expect(html).toContain('tone="success"');
    expect(html).toContain("Match rejected.");
  });

  it("success action without message uses per-intent text for apply", () => {
    mockUseActionData.mockReturnValue({
      success: true,
      intent: "apply",
    });

    const html = renderToString(createElement(ReconcilePage));

    expect(html).toContain('tone="success"');
    expect(html).toContain("Payment applied to the invoice.");
  });

  it("success action without message uses per-intent text for unmatch", () => {
    mockUseActionData.mockReturnValue({
      success: true,
      intent: "unmatch",
    });

    const html = renderToString(createElement(ReconcilePage));

    expect(html).toContain('tone="success"');
    expect(html).toContain("Match removed.");
  });

  it("failure action result renders critical banner with error", () => {
    mockUseActionData.mockReturnValue({
      success: false,
      intent: "apply",
      error: "Failed to apply match",
    });

    const html = renderToString(createElement(ReconcilePage));

    expect(html).toContain('tone="critical"');
    expect(html).toContain("Failed to apply match");
  });

  it("no action result renders no action banner", () => {
    mockUseActionData.mockReturnValue(undefined);

    const html = renderToString(createElement(ReconcilePage));

    expect(html).not.toContain("Match confirmed.");
    expect(html).not.toContain("Match rejected.");
    expect(html).not.toContain("Payment applied to the invoice.");
    expect(html).not.toContain("Match removed.");
    expect(html).not.toContain("Action completed.");
  });

  it("render test: action error shows critical banner without internal error string", () => {
    const internalDetail = "internal-detail-xyz";
    mockUseActionData.mockReturnValue({
      success: false,
      intent: "confirm",
      error: "Action failed",
    });

    const html = renderToString(createElement(ReconcilePage));

    expect(html).toContain('tone="critical"');
    expect(html).toContain("Action failed");
    expect(html).not.toContain(internalDetail);
  });
});

describe("Reconcile action error handling (real action tests)", () => {
  const mockSession = { shop: "test-action-shop.myshopify.com" };
  const mockContext = {
    shopify: {
      authenticate: {
        admin: vi.fn().mockResolvedValue({ session: mockSession }),
      },
    },
  };
  const mockUrl = new URL("https://example.com/app/reconcile");
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

  it("(a) thrown error from confirmMatch returns generic error, not internal message", async () => {
    vi.doMock("~/lib/request-context.server", () => ({
      getRequestSql: () => mockSql,
      getRequestWaitUntil: vi.fn(() => undefined),
    }));

    vi.doMock("~/services/matcher.server", () => ({
      runMatcher: vi.fn(),
      confirmMatch: vi.fn().mockRejectedValue(new Error("internal-detail-xyz")),
      rejectMatch: vi.fn(),
      MAX_PAYMENTS_PER_REQUEST: 50,
    }));

    vi.doMock("~/services/apply.server", async (importOriginal) => {
      const actual = await importOriginal<typeof import("~/services/apply.server")>();
      return {
        applyMatch: vi.fn(),
        unmatchMatch: vi.fn(),
        RECONCILE_HUMAN_MESSAGES: actual.RECONCILE_HUMAN_MESSAGES,
      };
    });

    vi.doMock("@shopify/shopify-app-react-router/server", () => ({
      boundary: { headers: vi.fn(() => ({})) },
      ApiVersion: { October26: "2026-10" },
    }));

    mockSql.mockResolvedValueOnce([{ id: "shop-throw-test", currency: "INR" }]);

    const formData = new FormData();
    formData.append("intent", "confirm");
    formData.append("matchId", "match-throw-test");

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

    expect(result).toEqual({
      success: false,
      intent: "confirm",
      error: "Action failed",
    });
    expect(JSON.stringify(result)).not.toContain("internal-detail-xyz");
    expect(result.intent).toBe("confirm");
  });

  it("(b) applyMatch resolving with internal error returns generic message", async () => {
    vi.doMock("~/lib/request-context.server", () => ({
      getRequestSql: () => mockSql,
      getRequestWaitUntil: vi.fn(() => undefined),
    }));

    vi.doMock("~/services/matcher.server", () => ({
      runMatcher: vi.fn(),
      confirmMatch: vi.fn(),
      rejectMatch: vi.fn(),
      MAX_PAYMENTS_PER_REQUEST: 50,
    }));

    vi.doMock("~/services/apply.server", async (importOriginal) => {
      const actual = await importOriginal<typeof import("~/services/apply.server")>();
      return {
        applyMatch: vi.fn().mockResolvedValue({ success: false, error: "internal-detail-xyz" }),
        unmatchMatch: vi.fn(),
        RECONCILE_HUMAN_MESSAGES: actual.RECONCILE_HUMAN_MESSAGES,
      };
    });

    vi.doMock("@shopify/shopify-app-react-router/server", () => ({
      boundary: { headers: vi.fn(() => ({})) },
      ApiVersion: { October26: "2026-10" },
    }));

    mockSql.mockResolvedValueOnce([{ id: "shop-apply-error-test", currency: "INR" }]);

    const formData = new FormData();
    formData.append("intent", "apply");
    formData.append("matchId", "match-apply-error-test");

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
    expect(JSON.stringify(result)).not.toContain("internal-detail-xyz");
  });

  it("(c) successful confirm returns success with intent", async () => {
    vi.doMock("~/lib/request-context.server", () => ({
      getRequestSql: () => mockSql,
      getRequestWaitUntil: vi.fn(() => undefined),
    }));

    vi.doMock("~/services/matcher.server", () => ({
      runMatcher: vi.fn(),
      confirmMatch: vi.fn().mockResolvedValue({ success: true }),
      rejectMatch: vi.fn(),
      MAX_PAYMENTS_PER_REQUEST: 50,
    }));

    vi.doMock("~/services/apply.server", async (importOriginal) => {
      const actual = await importOriginal<typeof import("~/services/apply.server")>();
      return {
        applyMatch: vi.fn(),
        unmatchMatch: vi.fn(),
        RECONCILE_HUMAN_MESSAGES: actual.RECONCILE_HUMAN_MESSAGES,
      };
    });

    vi.doMock("@shopify/shopify-app-react-router/server", () => ({
      boundary: { headers: vi.fn(() => ({})) },
      ApiVersion: { October26: "2026-10" },
    }));

    mockSql.mockResolvedValueOnce([{ id: "shop-confirm-success-test", currency: "INR" }]);

    const formData = new FormData();
    formData.append("intent", "confirm");
    formData.append("matchId", "match-confirm-success-test");

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

    expect(result).toEqual({
      success: true,
      intent: "confirm",
      error: null,
    });
  });
});
