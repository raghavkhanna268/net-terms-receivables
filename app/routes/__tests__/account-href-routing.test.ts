/**
 * Tests that encoded account hrefs route to app.accounts.$id, not app.$.
 *
 * When buyer account ids contain '/' or ':' (e.g. seed ids with embedded
 * path separators), the href must be URL-encoded so React Router matches
 * the $id param route, not the catch-all.
 *
 * Route config is derived from real app/routes/*.tsx filenames so the test
 * breaks if route files are renamed or removed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement, type ReactNode } from "react";
import { matchRoutes, type RouteObject } from "react-router";
import { readdirSync } from "fs";
import { resolve } from "path";
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

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useLoaderData: vi.fn(),
    useActionData: vi.fn(() => undefined),
    useNavigation: vi.fn(() => ({ state: "idle", formData: null })),
    data: vi.fn((d) => d),
    useRevalidator: vi.fn(() => ({ state: "idle", revalidate: vi.fn() })),
    Await: ({
      resolve: _resolve,
      children: _children,
    }: {
      resolve: Promise<unknown>;
      children: (data: unknown) => ReactNode;
    }) => {
      return createElement("div", {}, "Await placeholder");
    },
    Form: ({ children, ...props }: { children: ReactNode }) =>
      createElement("form", props, children),
  };
});

import { useLoaderData } from "react-router";
const mockUseLoaderData = vi.mocked(useLoaderData);

/**
 * Convert a flatRoutes filename segment to a route path segment.
 * - $param → :param (dynamic segment)
 * - $ alone → * (catch-all splat)
 * - _index → index route (returns null, handled separately)
 * - _prefix → layout route (ignored in path)
 */
function segmentToPath(segment: string): string | null {
  if (segment === "_index") return null;
  if (segment.startsWith("_")) return "";
  if (segment === "$") return "*";
  if (segment.startsWith("$")) return ":" + segment.slice(1);
  return segment;
}

/**
 * Build route config from real app/routes/*.tsx filenames.
 *
 * Reads the filesystem and converts flatRoutes naming convention to
 * React Router route objects. This ensures the test breaks if route
 * files are renamed or removed.
 */
function buildAppRouteConfig(): RouteObject[] {
  const routesDir = resolve(__dirname, "../../routes");
  const files = readdirSync(routesDir).filter(
    (f) => f.startsWith("app.") && f.endsWith(".tsx") && f !== "app.tsx"
  );

  const children: RouteObject[] = [];
  const catchAll: RouteObject[] = [];

  for (const file of files) {
    const name = file.replace(/\.tsx$/, "");
    const id = `routes/${name}`;
    const segments = name.split(".").slice(1);

    if (segments.length === 1 && segments[0] === "_index") {
      children.push({ id, index: true });
      continue;
    }

    const pathParts = segments.map(segmentToPath).filter((p) => p !== null && p !== "");
    const path = pathParts.join("/");

    const route: RouteObject = { id, path: path || undefined };

    if (path === "*") {
      catchAll.push(route);
    } else {
      children.push(route);
    }
  }

  children.push(...catchAll);

  return [
    {
      id: "routes/app",
      path: "app",
      children,
    },
  ];
}

describe("Account href routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Real route matching with matchRoutes", () => {
    const routes = buildAppRouteConfig();

    it("encoded href matches routes/app.accounts.$id", () => {
      const href = accountHref(TEST_ID_WITH_SLASHES);
      const matches = matchRoutes(routes, href);

      expect(matches).not.toBeNull();
      expect(matches!.length).toBeGreaterThan(0);

      const leafMatch = matches![matches!.length - 1];
      expect(leafMatch.route.id).toBe("routes/app.accounts.$id");
      expect(leafMatch.params.id).toBe(TEST_ID_WITH_SLASHES);
    });

    it("unencoded href matches routes/app.$ catch-all (the bug)", () => {
      const unencoded = `/app/accounts/${TEST_ID_WITH_SLASHES}`;
      const matches = matchRoutes(routes, unencoded);

      expect(matches).not.toBeNull();
      expect(matches!.length).toBeGreaterThan(0);

      const leafMatch = matches![matches!.length - 1];
      expect(leafMatch.route.id).toBe("routes/app.$");
    });

    it("params.id from matchRoutes decodes to original id", () => {
      const href = accountHref(TEST_ID_WITH_SLASHES);
      const matches = matchRoutes(routes, href);

      const leafMatch = matches![matches!.length - 1];
      expect(leafMatch.params.id).toBe(TEST_ID_WITH_SLASHES);
    });

    it("simple id (no special chars) matches routes/app.accounts.$id", () => {
      const simpleId = "acc-simple-001";
      const href = accountHref(simpleId);
      const matches = matchRoutes(routes, href);

      const leafMatch = matches![matches!.length - 1];
      expect(leafMatch.route.id).toBe("routes/app.accounts.$id");
      expect(leafMatch.params.id).toBe(simpleId);
    });
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

  describe("ReconcilePage pushing view emits encoded href", () => {
    it("renders account link with encoded id in pushing matches", async () => {
      const loaderData = {
        shopCurrency: "INR",
        payments: [],
        matches: [
          {
            id: "match-test-001",
            paymentId: "pay-test-001",
            invoiceId: "inv-test-001",
            invoiceName: "INV-2024-001",
            amountPaise: "100000",
            score: 85,
            reasons: [{ type: "amount_exact", points: 20 }],
            state: "pushing",
            buyerName: "Test Corp",
            buyerAccountId: TEST_ID_WITH_SLASHES,
          },
        ],
        selectedPayment: null,
        pagination: { page: 1, pageSize: 20, totalCount: 0 },
        view: "pushing" as const,
        error: null,
        tabCounts: { suggested: 0, unmatched: 0, confirmed: 0, pushing: 1 },
        notSupported: false,
      };
      mockUseLoaderData.mockReturnValue(loaderData);

      const ReconcilePage = (await import("../app.reconcile")).default;
      const html = renderToString(createElement(ReconcilePage));

      expect(html).toContain(`href="${accountHref(TEST_ID_WITH_SLASHES)}"`);
      expect(html).toContain(ENCODED_ID);
      expect(html).not.toContain(`href="/app/accounts/${TEST_ID_WITH_SLASHES}"`);
    });
  });
});
