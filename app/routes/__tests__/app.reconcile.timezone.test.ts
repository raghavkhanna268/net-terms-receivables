/**
 * Timezone rendering tests for Reconcile page payment value dates.
 *
 * Payment value dates are calendar dates stored as midnight UTC (from bank
 * imports that append T00:00:00Z). They must render with timeZone: 'UTC' so
 * the displayed date matches the original bank statement regardless of shop
 * timezone.
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
  valueDate?: string;
} = {}) {
  const {
    valueDate = "2026-11-27T00:00:00.000Z",
  } = overrides;

  return {
    shopCurrency: "INR",
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

describe("Reconcile PaymentDetailView value date rendering (UTC)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("midnight-UTC value date 2026-11-27T00:00:00.000Z renders 27/11/2026 regardless of shop timezone", () => {
    const loaderData = buildLoaderData({
      valueDate: "2026-11-27T00:00:00.000Z",
    });
    mockUseLoaderData.mockReturnValue(loaderData);

    const html = renderToString(createElement(ReconcilePage));

    expect(html).toContain("27/11/2026");
  });

  it("value date renders the bank statement date, not shifted by timezone", () => {
    const loaderData = buildLoaderData({
      valueDate: "2026-12-15T00:00:00.000Z",
    });
    mockUseLoaderData.mockReturnValue(loaderData);

    const html = renderToString(createElement(ReconcilePage));

    expect(html).toContain("15/12/2026");
  });
});
