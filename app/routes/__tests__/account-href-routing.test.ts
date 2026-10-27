/**
 * Tests that encoded account hrefs route to app.accounts.$id, not app.$.
 *
 * When buyer account ids contain '/' or ':' (e.g. seed ids), the href must
 * be URL-encoded so React Router matches the $id param route, not the catch-all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement, type ReactNode } from "react";
import { accountHref } from "~/lib/account-href";

const TEST_ID_WITH_SLASHES = "seed-test-0000-example/part:9";
const ENCODED_ID = encodeURIComponent(TEST_ID_WITH_SLASHES);

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { headers: vi.fn(() => ({})) },
  ApiVersion: { October26: "2026-10" },
}));

vi.mock("@sentry/cloudflare", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  setUser: vi.fn(),
  setContext: vi.fn(),
}));

vi.mock("react-router", async () => {
  return {
    useLoaderData: vi.fn(),
    useActionData: vi.fn(() => undefined),
    useNavigation: vi.fn(() => ({ state: "idle", formData: null })),
    data: vi.fn((d) => d),
    useRevalidator: vi.fn(() => ({ state: "idle", revalidate: vi.fn() })),
    Await: ({ resolve, children }: { resolve: Promise<unknown>; children: (data: unknown) => ReactNode }) => {
      return createElement("div", {}, "Await placeholder");
    },
    Form: ({ children, ...props }: { children: ReactNode }) =>
      createElement("form", props, children),
  };
});

import { useLoaderData } from "react-router";
const mockUseLoaderData = vi.mocked(useLoaderData);

describe("Account href routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("BuyerLedgerTable emits encoded href", () => {
    it("renders account link with encoded id containing '/' and ':'", async () => {
      const { BuyerLedgerTable } = await import("../app._index");

      const html = renderToString(
        createElement(BuyerLedgerTable, {
          rows: [
            {
              buyer_account_id: TEST_ID_WITH_SLASHES,
              buyer_name: "Test Buyer",
              credit_limit_paise: "10000000",
              hold_state: "OK",
              currency: "INR",
              outstanding_paise: "500000",
              overdue_paise: "0",
              oldest_overdue_days: null,
              is_gated: false,
            },
          ],
          sortBy: "outstanding",
          sortOrder: "desc",
          page: 1,
          totalCount: 1,
          pageSize: 20,
          onlyOverLimit: false,
          onNextPage: "?page=2",
          onPreviousPage: "?page=0",
          gatingEnforced: false,
        })
      );

      expect(html).toContain(`href="${accountHref(TEST_ID_WITH_SLASHES)}"`);
      expect(html).toContain(ENCODED_ID);
      expect(html).not.toContain(`href="/app/accounts/${TEST_ID_WITH_SLASHES}"`);
    });

    it("renders query param buyer link with encoded id", async () => {
      const { BuyerLedgerTable } = await import("../app._index");

      const html = renderToString(
        createElement(BuyerLedgerTable, {
          rows: [
            {
              buyer_account_id: TEST_ID_WITH_SLASHES,
              buyer_name: "Test Buyer",
              credit_limit_paise: null,
              hold_state: "OK",
              currency: "INR",
              outstanding_paise: "500000",
              overdue_paise: "100000",
              oldest_overdue_days: 5,
              is_gated: false,
            },
          ],
          sortBy: "outstanding",
          sortOrder: "desc",
          page: 1,
          totalCount: 1,
          pageSize: 20,
          onlyOverLimit: false,
          onNextPage: "?page=2",
          onPreviousPage: "?page=0",
          gatingEnforced: false,
        })
      );

      expect(html).toContain(`?buyer=${ENCODED_ID}`);
      expect(html).not.toContain(`?buyer=${TEST_ID_WITH_SLASHES}`);
    });
  });

  describe("BuyerInvoiceList emits encoded href", () => {
    it("renders 'View account' button with encoded href when empty", async () => {
      const { BuyerInvoiceList } = await import("../app._index");

      const html = renderToString(
        createElement(BuyerInvoiceList, {
          invoices: [],
          buyerName: "Test Buyer",
          buyerAccountId: TEST_ID_WITH_SLASHES,
          onClose: "?sortBy=outstanding&sortOrder=desc",
          shopTimezone: "Asia/Kolkata",
        })
      );

      expect(html).toContain(`href="${accountHref(TEST_ID_WITH_SLASHES)}"`);
      expect(html).toContain(ENCODED_ID);
    });

    it("renders 'View account' button with encoded href when has invoices", async () => {
      const { BuyerInvoiceList } = await import("../app._index");

      const html = renderToString(
        createElement(BuyerInvoiceList, {
          invoices: [
            {
              id: "inv-test-001",
              name: "#INV-001",
              order_id: "order-test-001",
              due_at: new Date("2026-10-15T00:00:00Z"),
              outstanding_paise: "50000",
              currency: "INR",
              days_past_due: 5,
            },
          ],
          buyerName: "Test Buyer",
          buyerAccountId: TEST_ID_WITH_SLASHES,
          onClose: "?sortBy=outstanding&sortOrder=desc",
          shopTimezone: "Asia/Kolkata",
        })
      );

      expect(html).toContain(`href="${accountHref(TEST_ID_WITH_SLASHES)}"`);
      expect(html).toContain(ENCODED_ID);
    });
  });

  describe("Route matching simulation", () => {
    it("encoded path has exactly 3 segments (app, accounts, encoded-id)", () => {
      const href = accountHref(TEST_ID_WITH_SLASHES);
      const segments = href.split("/").filter(Boolean);

      expect(segments).toHaveLength(3);
      expect(segments[0]).toBe("app");
      expect(segments[1]).toBe("accounts");
      expect(segments[2]).toBe(ENCODED_ID);
    });

    it("unencoded path would have more than 3 segments (would 404)", () => {
      const unencoded = `/app/accounts/${TEST_ID_WITH_SLASHES}`;
      const segments = unencoded.split("/").filter(Boolean);

      expect(segments.length).toBeGreaterThan(3);
    });

    it("decoding the encoded segment recovers the original id", () => {
      const href = accountHref(TEST_ID_WITH_SLASHES);
      const encoded = href.replace("/app/accounts/", "");
      const decoded = decodeURIComponent(encoded);

      expect(decoded).toBe(TEST_ID_WITH_SLASHES);
    });
  });
});
