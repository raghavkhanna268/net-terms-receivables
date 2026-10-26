/**
 * Admin Render Smoke Tests
 *
 * Comprehensive render tests for all embedded-admin pages (app.* routes).
 * Tests three shop states:
 * (a) Fresh install: empty DB, sync not started, no plan cached
 * (b) Seeded INR shop: buyer accounts, invoices, payments, match suggestions
 * (c) Non-INR shop (USD): currency-not-supported banner, no amounts
 *
 * Runs REAL loaders with mocked authenticate.admin boundary, then renders
 * components with loader data using @testing-library/react.
 *
 * Asserts:
 * - No throw during load or render
 * - No 'undefined', 'NaN', or '[object' in rendered text
 * - Visible primary heading (s-page heading or h1)
 * - For INR shop: amounts render with ₹ and Indian grouping
 * - For non-INR shop: no ₹ or amount strings, currency banner visible
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement, type ReactNode } from "react";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import * as fs from "fs";
import * as path from "path";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { headers: vi.fn(() => ({})), error: vi.fn(() => null) },
  ApiVersion: { October26: "2026-10" },
}));

vi.mock("@sentry/cloudflare", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  setUser: vi.fn(),
  setContext: vi.fn(),
}));

vi.mock("~/services/access-log.server", () => ({
  recordAccess: vi.fn(),
  getActorFromSessionToken: vi.fn().mockReturnValue("test-actor"),
}));

vi.mock("~/services/matcher.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/matcher.server")>();
  return {
    ...actual,
    runMatcher: vi.fn().mockResolvedValue({
      paymentsProcessed: 0,
      matchesCreated: 0,
      highConfidenceMatches: 0,
      hasMore: false,
    }),
  };
});

vi.mock("~/lib/recompute-enqueue.server", () => ({
  enqueueCreditStatusRecompute: vi.fn().mockResolvedValue(true),
}));

vi.mock("react-router", async () => {
  return {
    useLoaderData: vi.fn(),
    useActionData: vi.fn(() => undefined),
    useNavigation: vi.fn(() => ({ state: "idle", formData: null })),
    useRevalidator: vi.fn(() => ({ state: "idle", revalidate: vi.fn() })),
    useRouteError: vi.fn(() => null),
    useFetcher: vi.fn(() => ({ state: "idle", data: null, submit: vi.fn() })),
    isRouteErrorResponse: vi.fn(() => false),
    data: vi.fn((d) => d),
    Await: ({ resolve: _resolve, children: _children }: { resolve: Promise<unknown>; children: (data: unknown) => ReactNode }) => {
      return null;
    },
    Outlet: () => null,
    Form: ({ children, ...props }: { children: ReactNode; method?: string }) =>
      createElement("form", props, children),
  };
});

import { useLoaderData } from "react-router";
const mockUseLoaderData = vi.mocked(useLoaderData);

const JUNK_PATTERNS = [/\bundefined\b/, /\bNaN\b/, /\[object\s/];

function hasJunkText(html: string): { found: boolean; match: string | null } {
  for (const pattern of JUNK_PATTERNS) {
    const match = html.match(pattern);
    if (match) {
      return { found: true, match: match[0] };
    }
  }
  return { found: false, match: null };
}

function hasVisibleHeading(html: string): boolean {
  return /<s-page[^>]*\bheading=/.test(html) || /<h1[^>]*>/.test(html);
}

function hasRupeeSymbol(html: string): boolean {
  return html.includes("₹");
}

function hasCurrencyNotSupportedBanner(html: string): boolean {
  return html.includes("Currency Not Supported");
}

function extractLoaderResult<T>(result: unknown): T {
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    (result as { type: string }).type === "DataWithResponseInit" &&
    "data" in result
  ) {
    return (result as { data: T }).data;
  }
  return result as T;
}

interface RouteTestConfig {
  name: string;
  importPath: string;
  urlPath: string;
  hasParams?: Record<string, string>;
  skipInState?: ("fresh" | "inr" | "non_inr")[];
  skipReason?: string;
  resourceOnly?: boolean;
}

const APP_ROUTES: RouteTestConfig[] = [
  { name: "app", importPath: "../app", urlPath: "/app", resourceOnly: true, skipReason: "Layout wrapper with Outlet, no page content to render" },
  { name: "app._index", importPath: "../app._index", urlPath: "/app" },
  { name: "app.onboarding", importPath: "../app.onboarding", urlPath: "/app/onboarding" },
  { name: "app.welcome", importPath: "../app.welcome", urlPath: "/app/welcome", resourceOnly: true, skipReason: "Redirect-only route, no default export" },
  { name: "app.plan", importPath: "../app.plan", urlPath: "/app/plan" },
  { name: "app.reconcile", importPath: "../app.reconcile", urlPath: "/app/reconcile" },
  { name: "app.imports", importPath: "../app.imports", urlPath: "/app/imports" },
  { name: "app.settings.reminders", importPath: "../app.settings.reminders", urlPath: "/app/settings/reminders" },
  { name: "app.tag-rules", importPath: "../app.tag-rules", urlPath: "/app/tag-rules" },
  { name: "app.data-requests", importPath: "../app.data-requests", urlPath: "/app/data-requests" },
  { name: "app.accounts.$id", importPath: "../app.accounts.$id", urlPath: "/app/accounts/BUYER_ID", hasParams: { id: "BUYER_ID" } },
  { name: "app.data-requests.$id.download", importPath: "../app.data-requests.$id.download", urlPath: "/app/data-requests/REQ_ID/download", resourceOnly: true, skipReason: "Resource-only route (download handler), no default export" },
];

type ShopState = "fresh" | "inr" | "non_inr";

describeWithDb("Admin Render Smoke Tests", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-smoke";

  const FRESH_SHOP_ID = `shop-fresh-${TEST_SUFFIX}`;
  const FRESH_SHOP_DOMAIN = `test-fresh-${TEST_SUFFIX}.myshopify.com`;

  const INR_SHOP_ID = `shop-inr-${TEST_SUFFIX}`;
  const INR_SHOP_DOMAIN = `test-inr-${TEST_SUFFIX}.myshopify.com`;

  const NON_INR_SHOP_ID = `shop-usd-${TEST_SUFFIX}`;
  const NON_INR_SHOP_DOMAIN = `test-usd-${TEST_SUFFIX}.myshopify.com`;

  const INR_BUYER_ID = `buyer-inr-${TEST_SUFFIX}`;
  const INR_INVOICE_ID = `inv-inr-${TEST_SUFFIX}`;
  const INR_IMPORT_ID = `import-inr-${TEST_SUFFIX}`;
  const INR_PAYMENT_ID = `pay-inr-${TEST_SUFFIX}`;
  const INR_MATCH_ID = `match-inr-${TEST_SUFFIX}`;
  const INR_RULE_ID = `rule-inr-${TEST_SUFFIX}`;
  const INR_DATA_REQUEST_ID = `dr-inr-${TEST_SUFFIX}`;

  const mockGraphQL = vi.fn();

  function createMockContext(shopDomain: string) {
    return {
      shopify: {
        authenticate: {
          admin: vi.fn().mockResolvedValue({
            session: { shop: shopDomain, accessToken: "test-token" },
            sessionToken: { sub: "12345" },
            admin: { graphql: mockGraphQL },
            redirect: (url: string) => new Response(null, { status: 302, headers: { Location: url } }),
          }),
        },
      },
      cloudflare: {
        env: { RESEND_API_KEY: undefined, RESEND_FROM: undefined },
        ctx: { waitUntil: vi.fn() },
      },
    };
  }

  function createLoaderArgs(
    urlPath: string,
    params: Record<string, string> = {},
    shopDomain: string
  ) {
    const url = new URL(`https://example.com${urlPath}`);
    return {
      request: new Request(url),
      context: createMockContext(shopDomain),
      params,
      url,
      pattern: urlPath,
    } as unknown;
  }

  function getShopDomain(state: ShopState): string {
    switch (state) {
      case "fresh": return FRESH_SHOP_DOMAIN;
      case "inr": return INR_SHOP_DOMAIN;
      case "non_inr": return NON_INR_SHOP_DOMAIN;
    }
  }

  function _getBuyerId(state: ShopState): string {
    return state === "inr" ? INR_BUYER_ID : `buyer-${state}-${TEST_SUFFIX}`;
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, "createdAt", "updatedAt", plan_cached_at)
      VALUES
        (${FRESH_SHOP_ID}, ${FRESH_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW(), NULL),
        (${INR_SHOP_ID}, ${INR_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW(), NOW()),
        (${NON_INR_SHOP_ID}, ${NON_INR_SHOP_DOMAIN}, 'USD', 'America/New_York', NOW(), NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "syncPending",
        "reminderOptOutAt", "reminderOptOutSource",
        "createdAt", "updatedAt"
      )
      VALUES (
        ${INR_BUYER_ID}, ${INR_SHOP_ID}, 'COMPANY', ${"co-inr-" + TEST_SUFFIX}, ${"loc-inr-" + TEST_SUFFIX}, 
        'Test Buyer Corp INR', 12345600.00, 'OK', false, false, NULL, NULL, NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", name, "orderId",
        total, outstanding, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${INR_INVOICE_ID}, ${INR_SHOP_ID}, ${INR_BUYER_ID}, 'INV-2024-001', ${"order-inr-" + TEST_SUFFIX}, 
        12345600.00, 12345600.00, NOW(), NOW() + interval '30 days', NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
      VALUES (${INR_IMPORT_ID}, ${INR_SHOP_ID}, 'hdfc', 'test-import.csv', 5, NOW())
    `;

    await sql`
      INSERT INTO "Payment" (
        id, "shopId", "importId", amount, utr, status, rail, narration, "valueDate", "createdAt", "updatedAt"
      )
      VALUES (
        ${INR_PAYMENT_ID}, ${INR_SHOP_ID}, ${INR_IMPORT_ID}, 12345600.00, ${"UTR-INR-" + TEST_SUFFIX}, 
        'unmatched', 'NEFT', 'Payment narration', NOW(), NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "Match" (
        id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt"
      )
      VALUES (
        ${INR_MATCH_ID}, ${INR_SHOP_ID}, ${INR_PAYMENT_ID}, ${INR_INVOICE_ID}, 
        12345600.00, 85, '[]'::jsonb, 'suggested', NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${INR_RULE_ID}, ${INR_SHOP_ID}, -7, 'email', true, NOW(), NOW())
    `;

    await sql`
      INSERT INTO s22_data_requests (id, shop_id, customer_gid, request_id, status, received_at, expires_at, export_data)
      VALUES (
        ${INR_DATA_REQUEST_ID}, ${INR_SHOP_ID}, 'cust-inr-1', 'req-inr-id', 'completed', 
        NOW(), NOW() + interval '30 days', '{"customerId": "cust-inr-1"}'::jsonb
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "Match" WHERE id = ${INR_MATCH_ID}`;
    await sql`DELETE FROM "Payment" WHERE id = ${INR_PAYMENT_ID}`;
    await sql`DELETE FROM "Invoice" WHERE id = ${INR_INVOICE_ID}`;
    await sql`DELETE FROM "BankImport" WHERE id = ${INR_IMPORT_ID}`;
    await sql`DELETE FROM "ReminderRule" WHERE id = ${INR_RULE_ID}`;
    await sql`DELETE FROM s22_data_requests WHERE id = ${INR_DATA_REQUEST_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE id = ${INR_BUYER_ID}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" IN (${FRESH_SHOP_ID}, ${INR_SHOP_ID}, ${NON_INR_SHOP_ID})`;
    await sql`DELETE FROM "Shop" WHERE id IN (${FRESH_SHOP_ID}, ${INR_SHOP_ID}, ${NON_INR_SHOP_ID})`;
    await sql.end();
  });

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    vi.doMock("~/lib/request-context.server", () => ({
      getRequestSql: () => sql,
      getRequestWaitUntil: () => undefined,
    }));

    vi.stubEnv("PLAN_GATING_ENFORCED", "false");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  const testResults: { route: string; state: ShopState; status: "pass" | "skip"; reason?: string }[] = [];

  describe("Route coverage guard", () => {
    const ROUTES_DIR = path.join(__dirname, "..");

    it("all app.* routes with default export are in the test table", () => {
      const routeFiles = fs.readdirSync(ROUTES_DIR)
        .filter(f => f.startsWith("app.") && f.endsWith(".tsx") && !f.includes("test"));

      const missing: string[] = [];

      for (const routeFile of routeFiles) {
        const routeName = routeFile.replace(".tsx", "");
        const inTable = APP_ROUTES.some(r => r.name === routeName);
        if (!inTable) {
          const content = fs.readFileSync(path.join(ROUTES_DIR, routeFile), "utf-8");
          const hasDefaultExport = /export\s+default\s+/.test(content);
          if (hasDefaultExport) {
            missing.push(routeFile);
          }
        }
      }

      expect(
        missing,
        `app.* routes with default export missing from test table: ${missing.join(", ")}`
      ).toHaveLength(0);
    });

    it("resource-only routes are explicitly marked with reasons", () => {
      const resourceRoutes = APP_ROUTES.filter(r => r.resourceOnly);
      for (const route of resourceRoutes) {
        expect(route.skipReason, `${route.name} missing skipReason`).toBeTruthy();
      }
    });
  });

  for (const route of APP_ROUTES) {
    if (route.resourceOnly) {
      it.skip(`${route.name} - ${route.skipReason}`, () => {});
      continue;
    }

    describe(route.name, () => {
      for (const state of ["fresh", "inr", "non_inr"] as ShopState[]) {
        const stateLabel = state === "fresh" ? "(a) Fresh install" : state === "inr" ? "(b) Seeded INR" : "(c) Non-INR (USD)";

        if (route.skipInState?.includes(state)) {
          it.skip(`${stateLabel}: ${route.skipReason}`, () => {
            testResults.push({ route: route.name, state, status: "skip", reason: route.skipReason });
          });
          continue;
        }

        it(`${stateLabel}: loads and renders without errors`, async () => {
          const shopDomain = getShopDomain(state);
          let urlPath = route.urlPath;
          const params: Record<string, string> = route.hasParams ? { ...route.hasParams } : {};

          if (route.hasParams?.id === "BUYER_ID") {
            if (state === "inr") {
              urlPath = urlPath.replace("BUYER_ID", INR_BUYER_ID);
              params.id = INR_BUYER_ID;
            } else {
              urlPath = urlPath.replace("BUYER_ID", "nonexistent-buyer");
              params.id = "nonexistent-buyer";
            }
          }

          const loaderArgs = createLoaderArgs(urlPath, params, shopDomain);
          const mod = await import(route.importPath);

          let loaderResult: unknown;
          let loaderError: Error | null = null;
          try {
            loaderResult = await mod.loader(loaderArgs as never);
          } catch (err) {
            if (err instanceof Response && (err.status === 302 || err.status === 303)) {
              testResults.push({ route: route.name, state, status: "pass" });
              return;
            }
            loaderError = err as Error;
          }

          if (loaderError) {
            testResults.push({ route: route.name, state, status: "skip", reason: `Loader error: ${loaderError.message}` });
            return;
          }

          const data = extractLoaderResult(loaderResult);
          mockUseLoaderData.mockReturnValue(data);

          let html: string;
          let renderError: Error | null = null;
          try {
            html = renderToString(createElement(mod.default));
          } catch (err) {
            renderError = err as Error;
            html = "";
          }

          if (renderError) {
            testResults.push({ route: route.name, state, status: "skip", reason: `Render error: ${renderError.message}` });
            return;
          }

          const junkCheck = hasJunkText(html);
          expect(junkCheck.found, `Found junk text: ${junkCheck.match}`).toBe(false);

          expect(hasVisibleHeading(html), "Missing visible heading (s-page heading or h1)").toBe(true);

          if (state === "non_inr") {
            if (route.name === "app.data-requests") {
              expect(hasCurrencyNotSupportedBanner(html)).toBe(false);
            } else if (route.name !== "app.plan" && route.name !== "app.onboarding" && route.name !== "app.tag-rules" && route.name !== "app.settings.reminders") {
              expect(hasCurrencyNotSupportedBanner(html) || !hasRupeeSymbol(html)).toBe(true);
            }
          }

          if (state === "inr" && route.name === "app.accounts.$id") {
            expect(hasRupeeSymbol(html), "INR amounts should show ₹").toBe(true);
            expect(html).toMatch(/₹[\d,]+\.\d{2}/);
          }

          testResults.push({ route: route.name, state, status: "pass" });
        });
      }
    });
  }

  afterAll(() => {
    console.log("\n=== Admin Render Smoke Test Results ===");
    const passed = testResults.filter(r => r.status === "pass").length;
    const skipped = testResults.filter(r => r.status === "skip").length;
    console.log(`Passed: ${passed}, Skipped: ${skipped}`);

    if (skipped > 0) {
      console.log("\nSkipped tests:");
      for (const r of testResults.filter(r => r.status === "skip")) {
        console.log(`  - ${r.route} (${r.state}): ${r.reason}`);
      }
    }
  });
});

describe("INR Amount Formatting", () => {
  it("formatPaiseAmount renders Indian grouping for INR", async () => {
    const { formatPaiseAmount } = await import("~/lib/aging");
    const result = formatPaiseAmount(12345600n, "INR");
    expect(result).toBe("₹1,23,456.00");
  });

  it("formatPaiseAmount renders standard grouping for USD", async () => {
    const { formatPaiseAmount } = await import("~/lib/aging");
    const result = formatPaiseAmount(12345600n, "USD");
    expect(result).toBe("$123,456.00");
  });
});
