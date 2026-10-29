/**
 * Timezone rendering tests for Dashboard due dates.
 *
 * Verifies that invoice due dates in BuyerInvoiceList render using
 * the shop's timezone, not a hard-coded fallback.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";

vi.mock("react-router", async () => {
  return {
    useLoaderData: vi.fn(),
    useRevalidator: vi.fn(() => ({ revalidate: vi.fn() })),
    Await: ({ children, resolve }: { children: (data: unknown) => unknown; resolve: Promise<unknown> | unknown }) => {
      if (resolve && typeof resolve === "object" && "then" in resolve) {
        return null;
      }
      return children(resolve);
    },
    data: vi.fn((d) => d),
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    Suspense: ({ children }: { children: unknown }) => children,
  };
});

import { useLoaderData } from "react-router";

const mockUseLoaderData = vi.mocked(useLoaderData);

function buildLoaderData(overrides: {
  shopTimezone?: string;
  invoiceRows?: Array<{
    id: string;
    name: string;
    order_id: string | null;
    due_at: string | null;
    outstanding_paise: string;
    currency: string;
    days_past_due: number;
    buyer_name: string;
  }>;
} = {}) {
  const {
    shopTimezone = "Asia/Kolkata",
    invoiceRows = [],
  } = overrides;

  return {
    shopName: "test-shop",
    shopDomain: "test-shop.myshopify.com",
    storeHandle: "test-shop",
    shopCurrency: "INR",
    shopTimezone,
    currencySupported: true as const,
    currencyFlipBlocked: false,
    gatingEnforced: false,
    upgradeUrl: null,
    sortBy: "outstanding" as const,
    sortOrder: "desc" as const,
    onlyOverLimit: false,
    selectedBuyerId: invoiceRows.length > 0 ? "buyer-1" : null,
    dashboardData: {
      plan: { key: "starter", name: "Starter", isTest: false },
      usage: { companies: { current: 1, limit: 25 }, importsThisMonth: { current: 0, limit: -1 } },
      agingTotals: {
        totalByCurrency: { INR: "100000" },
        buckets: {
          current: { byCurrency: { INR: "100000" } },
          "1-30": { byCurrency: {} },
          "31-60": { byCurrency: {} },
          "61-90": { byCurrency: {} },
          "90+": { byCurrency: {} },
        },
        overdueByCurrency: {},
        oldestOverdueDays: null,
      },
      buyerLedger: { rows: [], totalCount: 0 },
      selectedBuyerInvoices: invoiceRows.length > 0 ? {
        rows: invoiceRows,
        totalCount: invoiceRows.length,
        buyerName: "Test Buyer",
      } : null,
      overLimitCount: 0,
      error: null,
      newAccountsPausedBanner: { show: false, heading: "", bodyText: "", upgradeUrl: null },
      pagination: { page: 1, pageSize: 20, totalCount: 0, totalPages: 0 },
    },
  };
}

describe("Dashboard BuyerInvoiceList timezone rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("America/New_York: end-of-day 26 Nov EST → renders 26/11", async () => {
    const loaderData = buildLoaderData({
      shopTimezone: "America/New_York",
      invoiceRows: [
        {
          id: "test-inv-1",
          name: "INV-001",
          order_id: null,
          due_at: "2026-11-27T04:59:59.999Z",
          outstanding_paise: "100000",
          currency: "INR",
          days_past_due: 0,
          buyer_name: "Test Buyer",
        },
      ],
    });
    mockUseLoaderData.mockReturnValue(loaderData);

    const { default: Index } = await import("../app._index");
    const html = renderToString(createElement(Index));

    expect(html).toContain("26/11/2026");
    expect(html).not.toContain("27/11/2026");
  });

  it("Asia/Kolkata: same instant → renders 27/11", async () => {
    const loaderData = buildLoaderData({
      shopTimezone: "Asia/Kolkata",
      invoiceRows: [
        {
          id: "test-inv-1",
          name: "INV-001",
          order_id: null,
          due_at: "2026-11-27T04:59:59.999Z",
          outstanding_paise: "100000",
          currency: "INR",
          days_past_due: 0,
          buyer_name: "Test Buyer",
        },
      ],
    });
    mockUseLoaderData.mockReturnValue(loaderData);

    const { default: Index } = await import("../app._index");
    const html = renderToString(createElement(Index));

    expect(html).toContain("27/11/2026");
  });
});
