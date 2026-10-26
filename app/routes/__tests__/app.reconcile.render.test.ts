/**
 * Render tests for ReconcilePage component (#292 currency gate).
 *
 * Verifies that:
 * - INR shop (notSupported=false): actions enabled, no currency banner
 * - Non-INR shop (notSupported=true): shows exactly one currency banner with shared copy
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement, type ReactNode } from "react";

// Mock react-router hooks and Form component before importing the component
vi.mock("react-router", async () => {
  return {
    useLoaderData: vi.fn(),
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

import { useLoaderData } from "react-router";
import ReconcilePage from "../app.reconcile";
import { CURRENCY_NOT_SUPPORTED_BANNER_COPY } from "~/lib/shop-currency-copy";

const mockUseLoaderData = vi.mocked(useLoaderData);

/**
 * Build fixture loader data for ReconcilePage.
 */
function buildLoaderData(overrides: {
  notSupported?: boolean;
  shopCurrency?: string;
  payments?: Array<{
    id: string;
    amountPaise: string;
    narration: string;
    payerText: string | null;
    utr: string | null;
    rail: string | null;
  }>;
  error?: string | null;
} = {}) {
  const {
    notSupported = false,
    shopCurrency = "INR",
    payments = [],
    error = null,
  } = overrides;

  return {
    shopCurrency,
    payments,
    matches: [],
    selectedPayment: null,
    pagination: { page: 1, pageSize: 20, totalCount: 0 },
    view: "suggested" as const,
    error,
    tabCounts: { suggested: 0, unmatched: 0, confirmed: 0, pushing: 0 },
    notSupported,
  };
}

describe("ReconcilePage render tests (#292 currency gate)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("INR shop (notSupported=false)", () => {
    it("renders without currency banner and with actions enabled", () => {
      const loaderData = buildLoaderData({
        notSupported: false,
        shopCurrency: "INR",
      });
      mockUseLoaderData.mockReturnValue(loaderData);

      const html = renderToString(createElement(ReconcilePage));

      // Page heading renders
      expect(html).toContain("Payment Reconciliation");

      // NO currency not supported banner
      expect(html).not.toContain("Currency Not Supported");
      expect(html).not.toContain(CURRENCY_NOT_SUPPORTED_BANNER_COPY);

      // Action buttons render and are NOT disabled
      expect(html).toContain("Run Matcher");
      // Check that the button has disabled="false" (not disabled="true" or disabled="")
      expect(html).toContain('disabled="false"');
      expect(html).not.toContain('disabled="true"');
      expect(html).not.toContain('disabled=""');
    });

    it("renders action bar and tab buttons for INR shop", () => {
      const loaderData = buildLoaderData({
        notSupported: false,
        shopCurrency: "INR",
      });
      mockUseLoaderData.mockReturnValue(loaderData);

      const html = renderToString(createElement(ReconcilePage));

      // Tab buttons render (these are the view switchers)
      expect(html).toContain("Suggested");
      expect(html).toContain("Unmatched");
      expect(html).toContain("Confirmed");
      expect(html).not.toContain("Currency Not Supported");
    });
  });

  describe("non-INR shop (notSupported=true)", () => {
    it("renders exactly one currency banner with shared copy for USD shop", () => {
      const loaderData = buildLoaderData({
        notSupported: true,
        shopCurrency: "USD",
      });
      mockUseLoaderData.mockReturnValue(loaderData);

      const html = renderToString(createElement(ReconcilePage));

      // Page heading renders
      expect(html).toContain("Payment Reconciliation");

      // Exactly one currency not supported banner with the shared copy
      expect(html).toContain("Currency Not Supported");
      expect(html).toContain(CURRENCY_NOT_SUPPORTED_BANNER_COPY);

      // Count occurrences of the banner heading - should be exactly 1
      const bannerMatches = html.match(/Currency Not Supported/g);
      expect(bannerMatches).toHaveLength(1);

      // No payment list or action buttons (early return)
      expect(html).not.toContain("Run Matcher");
    });

    it("renders currency banner for XXX (unknown) shop", () => {
      const loaderData = buildLoaderData({
        notSupported: true,
        shopCurrency: "XXX",
      });
      mockUseLoaderData.mockReturnValue(loaderData);

      const html = renderToString(createElement(ReconcilePage));

      expect(html).toContain("Currency Not Supported");
      expect(html).toContain(CURRENCY_NOT_SUPPORTED_BANNER_COPY);

      // Only one banner
      const bannerMatches = html.match(/Currency Not Supported/g);
      expect(bannerMatches).toHaveLength(1);
    });

    it("renders currency banner for NULL currency shop", () => {
      const loaderData = buildLoaderData({
        notSupported: true,
        shopCurrency: "XXX", // NULL becomes XXX sentinel
      });
      mockUseLoaderData.mockReturnValue(loaderData);

      const html = renderToString(createElement(ReconcilePage));

      expect(html).toContain("Currency Not Supported");
      expect(html).toContain(CURRENCY_NOT_SUPPORTED_BANNER_COPY);
    });
  });
});

/**
 * Label map tests for match reasons and states.
 *
 * Verifies that:
 * - Known reason codes map to merchant-friendly labels
 * - Known state codes map to merchant-friendly labels
 * - Unknown codes have safe fallbacks
 */
describe("Match label maps", () => {
  describe("getMatchReasonLabel", () => {
    it("maps known reason types to merchant labels", async () => {
      const { getMatchReasonLabel, MATCH_REASON_LABELS } = await import("../app.reconcile");

      expect(getMatchReasonLabel("amount_exact")).toBe("Exact amount");
      expect(getMatchReasonLabel("amount_overpayment")).toBe("Overpayment");
      expect(getMatchReasonLabel("invoice_ref")).toBe("Invoice/Order ref");
      expect(getMatchReasonLabel("order_ref")).toBe("Invoice/Order ref");
      expect(getMatchReasonLabel("payer_alias")).toBe("Confirmed alias");
      expect(getMatchReasonLabel("payer_name")).toBe("Payer name");
      expect(getMatchReasonLabel("email_match")).toBe("Email match");
      expect(getMatchReasonLabel("multi_invoice")).toBe("Multiple invoices");

      expect(Object.keys(MATCH_REASON_LABELS).length).toBeGreaterThan(0);
    });

    it("falls back to readable format for unknown reason types", async () => {
      const { getMatchReasonLabel } = await import("../app.reconcile");

      expect(getMatchReasonLabel("unknown_code")).toBe("unknown code");
      expect(getMatchReasonLabel("some_other_reason")).toBe("some other reason");
    });
  });

  describe("getMatchStateLabel", () => {
    it("maps known states to merchant labels", async () => {
      const { getMatchStateLabel, MATCH_STATE_LABELS } = await import("../app.reconcile");

      expect(getMatchStateLabel("suggested")).toBe("Suggested");
      expect(getMatchStateLabel("confirmed")).toBe("Confirmed");
      expect(getMatchStateLabel("pushing")).toBe("Applying…");
      expect(getMatchStateLabel("pushed")).toBe("Recorded in Shopify");
      expect(getMatchStateLabel("unmatched")).toBe("Not matched");

      expect(Object.keys(MATCH_STATE_LABELS).length).toBeGreaterThan(0);
    });

    it("falls back to Title Case for unknown states", async () => {
      const { getMatchStateLabel } = await import("../app.reconcile");

      expect(getMatchStateLabel("unknown")).toBe("Unknown");
      expect(getMatchStateLabel("other")).toBe("Other");
    });
  });
});

/**
 * Route href validation tests.
 *
 * Verifies that all hrefs built by the reconcile page point to routes that exist
 * under app/routes, or that no link is rendered when the route doesn't exist.
 */
describe("Reconcile page href validation", () => {
  it("all hrefs built by the page point to existing route files", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const routesDir = path.resolve("app/routes");
    const routeFiles = fs.readdirSync(routesDir).filter((f) => f.endsWith(".tsx"));

    const routePatterns = new Set<string>();
    for (const file of routeFiles) {
      if (file.startsWith("app.")) {
        const routeName = file.replace(/\.tsx$/, "").replace(/\.\$\w+/g, "/:param");
        routePatterns.add("/" + routeName.replace(/\./g, "/"));
      }
    }

    const hrefsInComponent: string[] = [
      "/app/reconcile",
      "/app/reconcile?view=suggested",
      "/app/reconcile?view=unmatched",
      "/app/reconcile?view=confirmed",
      "/app/reconcile?view=pushing",
      "/app/reconcile?payment=test-id",
    ];

    for (const href of hrefsInComponent) {
      const pathOnly = href.split("?")[0];
      if (pathOnly === "/app/reconcile") {
        expect(routePatterns.has("/app/reconcile")).toBe(true);
      }
    }

    expect(routePatterns.has("/app/accounts/:param")).toBe(true);

    expect(routePatterns.has("/app/invoices/:param")).toBe(false);
  });

  it("pushing matches view links to account page (not dead invoice route)", () => {
    const loaderData = {
      ...buildLoaderData({ notSupported: false, shopCurrency: "INR" }),
      view: "pushing" as const,
      matches: [
        {
          id: "match-synth-001",
          paymentId: "pay-synth-001",
          invoiceId: "inv-synth-001",
          invoiceName: "INV-2024-001",
          amountPaise: "100000",
          score: 85,
          reasons: [{ type: "amount_exact", points: 20 }],
          state: "pushing",
          buyerName: "Test Corp",
          buyerAccountId: "acc-synth-001",
        },
      ],
      tabCounts: { suggested: 0, unmatched: 0, confirmed: 0, pushing: 1 },
    };
    mockUseLoaderData.mockReturnValue(loaderData);

    const html = renderToString(createElement(ReconcilePage));

    expect(html).toContain('href="/app/accounts/acc-synth-001"');
    expect(html).not.toContain('href="/app/invoices/');
  });

  it("pushing matches view renders plain text when buyerAccountId is missing", () => {
    const loaderData = {
      ...buildLoaderData({ notSupported: false, shopCurrency: "INR" }),
      view: "pushing" as const,
      matches: [
        {
          id: "match-synth-002",
          paymentId: "pay-synth-002",
          invoiceId: "inv-synth-002",
          invoiceName: "INV-2024-002",
          amountPaise: "100000",
          score: 85,
          reasons: [{ type: "amount_exact", points: 20 }],
          state: "pushing",
          buyerName: "Test Corp",
        },
      ],
      tabCounts: { suggested: 0, unmatched: 0, confirmed: 0, pushing: 1 },
    };
    mockUseLoaderData.mockReturnValue(loaderData);

    const html = renderToString(createElement(ReconcilePage));

    expect(html).toContain("INV-2024-002");
    expect(html).not.toContain('href="/app/invoices/');
    expect(html).not.toContain('href="/app/accounts/undefined"');
  });

  it("renders merchant-friendly labels in match reasons, not raw codes", () => {
    const loaderData = {
      ...buildLoaderData({ notSupported: false, shopCurrency: "INR" }),
      selectedPayment: {
        payment: {
          id: "pay-synth-003",
          amountPaise: "200000",
          narration: "Payment for invoice",
          payerText: "Test Payer",
          utr: "UTR123456",
          rail: "NEFT",
          valueDate: "2024-01-15T00:00:00.000Z",
          importFileName: "statement.csv",
        },
        matches: [
          {
            id: "match-synth-003",
            paymentId: "pay-synth-003",
            invoiceId: "inv-synth-003",
            invoiceName: "INV-2024-003",
            amountPaise: "200000",
            score: 90,
            reasons: [
              { type: "amount_exact", points: 20 },
              { type: "payer_alias", points: 30 },
              { type: "invoice_ref", points: 30 },
            ],
            state: "suggested",
            buyerName: "Test Corp",
          },
        ],
      },
    };
    mockUseLoaderData.mockReturnValue(loaderData);

    const html = renderToString(createElement(ReconcilePage));

    expect(html).toContain("Exact amount");
    expect(html).toContain("Confirmed alias");
    expect(html).toContain("Invoice/Order ref");
    expect(html).not.toContain("amount_exact:");
    expect(html).not.toContain("payer_alias:");
    expect(html).not.toContain("invoice_ref:");
  });

  it("renders merchant-friendly state labels, not raw state values", () => {
    const loaderData = {
      ...buildLoaderData({ notSupported: false, shopCurrency: "INR" }),
      selectedPayment: {
        payment: {
          id: "pay-synth-004",
          amountPaise: "150000",
          narration: "Payment",
          payerText: null,
          utr: null,
          rail: null,
          valueDate: "2024-01-15T00:00:00.000Z",
          importFileName: "statement.csv",
        },
        matches: [
          {
            id: "match-synth-004",
            paymentId: "pay-synth-004",
            invoiceId: "inv-synth-004",
            invoiceName: "INV-2024-004",
            amountPaise: "150000",
            score: 85,
            reasons: [],
            state: "confirmed",
            buyerName: "Test Buyer",
          },
        ],
      },
    };
    mockUseLoaderData.mockReturnValue(loaderData);

    const html = renderToString(createElement(ReconcilePage));

    expect(html).toContain("Confirmed");
  });

  it("empty state does not mention 'manually reconcile' (no such UI exists)", () => {
    const loaderData = {
      ...buildLoaderData({ notSupported: false, shopCurrency: "INR" }),
      selectedPayment: {
        payment: {
          id: "pay-synth-005",
          amountPaise: "100000",
          narration: "Payment with no matches",
          payerText: null,
          utr: null,
          rail: null,
          valueDate: "2024-01-15T00:00:00.000Z",
          importFileName: "statement.csv",
        },
        matches: [],
      },
    };
    mockUseLoaderData.mockReturnValue(loaderData);

    const html = renderToString(createElement(ReconcilePage));

    expect(html).toContain("No matches found");
    expect(html).toContain("run the matcher again");
    expect(html).not.toContain("manually reconcile");
  });
});
