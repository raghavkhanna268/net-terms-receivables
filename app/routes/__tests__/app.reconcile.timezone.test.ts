/**
 * Timezone rendering tests for Reconcile page payment value dates.
 *
 * Verifies that payment value dates in PaymentDetailView render using
 * the shop's timezone, not a hard-coded fallback.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement, type ReactNode } from "react";

vi.mock("react-router", async () => {
  return {
    useLoaderData: vi.fn(),
    useActionData: vi.fn(() => undefined),
    useNavigation: vi.fn(() => ({ state: "idle", formData: null })),
    Form: ({ children, ...props }: { children: ReactNode; method?: string }) =>
      createElement("form", props, children),
  };
});

import { useLoaderData } from "react-router";
import ReconcilePage from "../app.reconcile";

const mockUseLoaderData = vi.mocked(useLoaderData);

function buildLoaderData(overrides: {
  shopTimezone?: string;
  valueDate?: string;
} = {}) {
  const {
    shopTimezone = "Asia/Kolkata",
    valueDate = "2026-11-27T04:59:59.999Z",
  } = overrides;

  return {
    shopCurrency: "INR",
    shopTimezone,
    payments: [],
    matches: [],
    selectedPayment: {
      payment: {
        id: "payment-1",
        amountPaise: "100000",
        narration: "Test payment",
        payerText: "Test Payer",
        utr: "UTR123",
        rail: "IMPS",
        valueDate,
        importFileName: "test-import.csv",
      },
      matches: [],
    },
    pagination: { page: 1, pageSize: 20, totalCount: 0 },
    view: "suggested",
    error: null,
    tabCounts: { suggested: 0, unmatched: 0, confirmed: 0, pushing: 0 },
    notSupported: false,
  };
}

describe("Reconcile PaymentDetailView timezone rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("America/New_York: end-of-day 26 Nov EST → renders 26/11", () => {
    const loaderData = buildLoaderData({
      shopTimezone: "America/New_York",
      valueDate: "2026-11-27T04:59:59.999Z",
    });
    mockUseLoaderData.mockReturnValue(loaderData);

    const html = renderToString(createElement(ReconcilePage));

    expect(html).toContain("26/11/2026");
    expect(html).not.toContain("27/11/2026");
  });

  it("Asia/Kolkata: same instant → renders 27/11", () => {
    const loaderData = buildLoaderData({
      shopTimezone: "Asia/Kolkata",
      valueDate: "2026-11-27T04:59:59.999Z",
    });
    mockUseLoaderData.mockReturnValue(loaderData);

    const html = renderToString(createElement(ReconcilePage));

    expect(html).toContain("27/11/2026");
  });
});
