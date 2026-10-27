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

import { describe, it, expect, vi, beforeEach } from "vitest";
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

  it("thrown error shows generic text, never the internal error message", () => {
    const internalErrorMessage = "internal-db-connection-xyz-detail-secret";
    mockUseActionData.mockReturnValue({
      success: false,
      intent: "confirm",
      error: "Action failed",
    });

    const html = renderToString(createElement(ReconcilePage));

    expect(html).toContain('tone="critical"');
    expect(html).toContain("Action failed");
    expect(html).not.toContain(internalErrorMessage);
  });
});

describe("Data-requests download error handling", () => {
  it("code sets generic error message not err.message or server details", async () => {
    const fs = await import("fs");
    const sourceFile = fs.readFileSync("app/routes/app.data-requests.tsx", "utf-8");

    expect(sourceFile).toContain('setDownloadError("Download failed. Please try again.")');
    expect(sourceFile).not.toMatch(/setDownloadError\([^)]*err\.message/);
    expect(sourceFile).not.toMatch(/setDownloadError\([^)]*errorData\.error/);
  });

  it("download error display does not include prefix", async () => {
    const fs = await import("fs");
    const sourceFile = fs.readFileSync("app/routes/app.data-requests.tsx", "utf-8");

    expect(sourceFile).not.toContain("Download error:");
    expect(sourceFile).toContain("{downloadError}");
  });

  it("failed download with server error internal-detail-xyz shows only generic text", async () => {
    const fs = await import("fs");
    const sourceFile = fs.readFileSync("app/routes/app.data-requests.tsx", "utf-8");

    const catchBlock = sourceFile.match(/catch\s*\{[\s\S]*?finally/);
    expect(catchBlock).toBeTruthy();
    expect(catchBlock![0]).toContain("Download failed. Please try again.");
    expect(catchBlock![0]).not.toContain("internal-detail-xyz");
  });
});
