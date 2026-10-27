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
 * components with loader data using renderToString.
 *
 * Asserts:
 * - No throw during load or render
 * - No 'undefined', 'NaN', or '[object' in rendered text
 * - Visible primary heading (s-page heading or h1)
 * - For INR shop: exact seeded amounts render with ₹ and Indian grouping
 * - For non-INR shop: exact banner text present, no ₹ symbols on gated pages
 * - Every redirect must be declared; every declared redirect must happen
 * - All deferred promises are awaited before rendering
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement, type ReactNode } from "react";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import * as fs from "fs";
import * as path from "path";
import { CURRENCY_NOT_SUPPORTED_BANNER_COPY } from "~/lib/shop-currency-copy";

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

const mockUseLoaderData = vi.fn();
const mockUseActionData = vi.fn(() => undefined);
const mockUseNavigation = vi.fn(() => ({ state: "idle", formData: null }));
const mockUseRevalidator = vi.fn(() => ({ state: "idle", revalidate: vi.fn() }));
const mockUseFetcher = vi.fn(() => ({ state: "idle", data: null, submit: vi.fn() }));

vi.mock("react-router", () => ({
  useLoaderData: mockUseLoaderData,
  useActionData: mockUseActionData,
  useNavigation: mockUseNavigation,
  useRevalidator: mockUseRevalidator,
  useRouteError: vi.fn(() => null),
  useFetcher: mockUseFetcher,
  isRouteErrorResponse: vi.fn(() => false),
  data: vi.fn((d) => d),
  Await: ({
    resolve,
    children,
  }: {
    resolve: unknown;
    children: (data: unknown) => ReactNode;
  }) => {
    if (resolve instanceof Promise) {
      throw new Error(
        "Await received an unresolved Promise. All deferred data must be awaited before rendering."
      );
    }
    return children(resolve);
  },
  Outlet: () => null,
  Form: ({ children, ...props }: { children: ReactNode; method?: string }) =>
    createElement("form", props, children),
}));

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

async function awaitAllDeferredData(
  data: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value instanceof Promise) {
      result[key] = await value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

type ShopState = "fresh" | "inr" | "non_inr";

interface RedirectExpectation {
  location: string | RegExp;
}

interface ErrorExpectation {
  error: string | RegExp;
}

interface BaseRouteConfig {
  name: string;
  importPath: string;
  urlPath: string;
  hasParams?: Record<string, string>;
}

interface ResourceOnlyRouteConfig extends BaseRouteConfig {
  resourceOnly: true;
  resourceOnlyReason: string;
}

interface TestableRouteConfig extends BaseRouteConfig {
  resourceOnly?: false;
  currencyGate: "gated" | { exempt: string };
  expectedRedirect?: Partial<Record<ShopState, RedirectExpectation>>;
  expectedError?: Partial<Record<ShopState, ErrorExpectation>>;
  expectsSeededMoney?: boolean;
  seededMoneyValues?: string[];
  seededTextValues?: string[];
}

type RouteTestConfig = ResourceOnlyRouteConfig | TestableRouteConfig;

function isTestableRoute(route: RouteTestConfig): route is TestableRouteConfig {
  return route.resourceOnly !== true;
}

const FRESH_EMPTY_STATE_HEADING = "No outstanding receivables";
const FRESH_EMPTY_STATE_SUBHEADING = "You don&#x27;t have any open invoices yet";

const APP_ROUTES: RouteTestConfig[] = [
  {
    name: "app",
    importPath: "../app",
    urlPath: "/app",
    resourceOnly: true,
    resourceOnlyReason: "Layout wrapper with Outlet only, no page content to render independently",
  },
  {
    name: "app._index",
    importPath: "../app._index",
    urlPath: "/app",
    expectedRedirect: {
      fresh: { location: "/app/onboarding" },
    },
    currencyGate: "gated",
    expectsSeededMoney: true,
    seededMoneyValues: ["₹1,23,456.00"],
    seededTextValues: ["Test Buyer Corp INR"],
  },
  {
    name: "app.onboarding",
    importPath: "../app.onboarding",
    urlPath: "/app/onboarding",
    currencyGate: "gated",
  },
  {
    name: "app.welcome",
    importPath: "../app.welcome",
    urlPath: "/app/welcome",
    resourceOnly: true,
    resourceOnlyReason: "Redirect-only route with no default export component",
  },
  {
    name: "app.plan",
    importPath: "../app.plan",
    urlPath: "/app/plan",
    currencyGate: { exempt: "Plan page shows subscription status which is currency-agnostic" },
  },
  {
    name: "app.reconcile",
    importPath: "../app.reconcile",
    urlPath: "/app/reconcile",
    currencyGate: "gated",
    expectsSeededMoney: true,
    seededMoneyValues: ["₹1,23,456.00"],
  },
  {
    name: "app.imports",
    importPath: "../app.imports",
    urlPath: "/app/imports",
    currencyGate: "gated",
  },
  {
    name: "app.settings.reminders",
    importPath: "../app.settings.reminders",
    urlPath: "/app/settings/reminders",
    currencyGate: "gated",
  },
  {
    name: "app.tag-rules",
    importPath: "../app.tag-rules",
    urlPath: "/app/tag-rules",
    currencyGate: "gated",
  },
  {
    name: "app.data-requests",
    importPath: "../app.data-requests",
    urlPath: "/app/data-requests",
    currencyGate: { exempt: "GDPR/CCPA data requests are compliance-mandated and must remain accessible regardless of currency" },
  },
  {
    name: "app.accounts.$id",
    importPath: "../app.accounts.$id",
    urlPath: "/app/accounts/BUYER_ID",
    hasParams: { id: "BUYER_ID" },
    currencyGate: "gated",
    expectsSeededMoney: true,
    seededMoneyValues: ["₹1,23,456.00"],
    seededTextValues: ["Test Buyer Corp INR"],
    expectedError: {
      fresh: { error: "Account not found" },
    },
  },
  {
    name: "app.data-requests.$id.download",
    importPath: "../app.data-requests.$id.download",
    urlPath: "/app/data-requests/REQ_ID/download",
    resourceOnly: true,
    resourceOnlyReason: "Resource-only download handler route with no default export component",
  },
  {
    name: "app.$",
    importPath: "../app.$",
    urlPath: "/app/unknown-path",
    resourceOnly: true,
    resourceOnlyReason: "Catch-all 404 route that throws in loader and renders ErrorBoundary",
  },
];

const RESOURCE_ONLY_ROUTES = APP_ROUTES.filter(
  (r): r is ResourceOnlyRouteConfig => r.resourceOnly === true
);
const TESTABLE_ROUTES = APP_ROUTES.filter(isTestableRoute);

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

  const USD_BUYER_ID = `buyer-usd-${TEST_SUFFIX}`;

  const SEEDED_AMOUNT_RUPEES = 123456;
  const SEEDED_BUYER_NAME = "Test Buyer Corp INR";
  const USD_BUYER_NAME = "Test Buyer Corp USD";

  const mockGraphQL = vi.fn();

  function createMockContext(shopDomain: string) {
    return {
      shopify: {
        authenticate: {
          admin: vi.fn().mockResolvedValue({
            session: { shop: shopDomain, accessToken: "test-token" },
            sessionToken: { sub: "12345" },
            admin: { graphql: mockGraphQL },
            redirect: (url: string) => {
              throw new Response(null, { status: 302, headers: { Location: url } });
            },
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
      case "fresh":
        return FRESH_SHOP_DOMAIN;
      case "inr":
        return INR_SHOP_DOMAIN;
      case "non_inr":
        return NON_INR_SHOP_DOMAIN;
    }
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    vi.doMock("~/lib/request-context.server", () => ({
      getRequestSql: () => sql,
      getRequestWaitUntil: () => undefined,
    }));

    vi.stubEnv("PLAN_GATING_ENFORCED", "false");

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
        ${SEEDED_BUYER_NAME}, ${SEEDED_AMOUNT_RUPEES}, 'OK', false, false, NULL, NULL, NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "syncPending",
        "reminderOptOutAt", "reminderOptOutSource",
        "createdAt", "updatedAt"
      )
      VALUES (
        ${USD_BUYER_ID}, ${NON_INR_SHOP_ID}, 'COMPANY', ${"co-usd-" + TEST_SUFFIX}, ${"loc-usd-" + TEST_SUFFIX}, 
        ${USD_BUYER_NAME}, 50000, 'OK', false, false, NULL, NULL, NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", name, "orderId",
        total, outstanding, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${INR_INVOICE_ID}, ${INR_SHOP_ID}, ${INR_BUYER_ID}, 'INV-2024-001', ${"order-inr-" + TEST_SUFFIX}, 
        ${SEEDED_AMOUNT_RUPEES}, ${SEEDED_AMOUNT_RUPEES}, NOW(), NOW() + interval '30 days', NOW(), NOW()
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
        ${INR_PAYMENT_ID}, ${INR_SHOP_ID}, ${INR_IMPORT_ID}, ${SEEDED_AMOUNT_RUPEES}, ${"UTR-INR-" + TEST_SUFFIX}, 
        'unmatched', 'NEFT', 'Payment narration', NOW(), NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "Match" (
        id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt"
      )
      VALUES (
        ${INR_MATCH_ID}, ${INR_SHOP_ID}, ${INR_PAYMENT_ID}, ${INR_INVOICE_ID}, 
        ${SEEDED_AMOUNT_RUPEES}, 85, '[]'::jsonb, 'suggested', NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${INR_RULE_ID}, ${INR_SHOP_ID}, -7, 'email', true, NOW(), NOW())
    `;

    await sql`
      INSERT INTO s22_data_requests (id, shop_id, customer_gid, request_id, status, received_at, expires_at, export_data)
      VALUES (
        ${INR_DATA_REQUEST_ID}, ${INR_SHOP_ID}, ${"cust-inr-" + TEST_SUFFIX}, ${"req-" + TEST_SUFFIX}, 'completed', 
        NOW(), NOW() + interval '30 days', '{"customerId": "cust-inr-1"}'::jsonb
      )
    `;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseLoaderData.mockReturnValue({});
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({ state: "idle", formData: null });
    mockUseRevalidator.mockReturnValue({ state: "idle", revalidate: vi.fn() });
    mockUseFetcher.mockReturnValue({ state: "idle", data: null, submit: vi.fn() });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await sql`DELETE FROM "Match" WHERE id = ${INR_MATCH_ID}`;
    await sql`DELETE FROM "Payment" WHERE id = ${INR_PAYMENT_ID}`;
    await sql`DELETE FROM "Invoice" WHERE id = ${INR_INVOICE_ID}`;
    await sql`DELETE FROM "BankImport" WHERE id = ${INR_IMPORT_ID}`;
    await sql`DELETE FROM "ReminderRule" WHERE id = ${INR_RULE_ID}`;
    await sql`DELETE FROM s22_data_requests WHERE id = ${INR_DATA_REQUEST_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE id IN (${INR_BUYER_ID}, ${USD_BUYER_ID})`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" IN (${FRESH_SHOP_ID}, ${INR_SHOP_ID}, ${NON_INR_SHOP_ID})`;
    await sql`DELETE FROM "Shop" WHERE id IN (${FRESH_SHOP_ID}, ${INR_SHOP_ID}, ${NON_INR_SHOP_ID})`;
    await sql.end();
  });

  describe("Route coverage guard", () => {
    const ROUTES_DIR = path.join(__dirname, "..");

    it("all app.* routes with default export are in the test table", () => {
      const routeFiles = fs
        .readdirSync(ROUTES_DIR)
        .filter((f) => f.startsWith("app.") && f.endsWith(".tsx") && !f.includes("test"));

      const missing: string[] = [];

      for (const routeFile of routeFiles) {
        const routeName = routeFile.replace(".tsx", "");
        const inTable = APP_ROUTES.some((r) => r.name === routeName);
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

    it("resource-only routes are explicitly documented with reasons", () => {
      for (const route of RESOURCE_ONLY_ROUTES) {
        expect(
          route.resourceOnlyReason,
          `${route.name} marked resourceOnly but missing resourceOnlyReason`
        ).toBeTruthy();
      }

      expect(RESOURCE_ONLY_ROUTES.length).toBe(4);
      expect(RESOURCE_ONLY_ROUTES.map((r) => r.name).sort()).toEqual([
        "app",
        "app.$",
        "app.data-requests.$id.download",
        "app.welcome",
      ]);
    });

    it("testable routes have currencyGate declared", () => {
      const missing: string[] = [];
      for (const route of TESTABLE_ROUTES) {
        if (!route.currencyGate) {
          missing.push(route.name);
        }
      }
      expect(
        missing,
        `Testable routes missing currencyGate config: ${missing.join(", ")}. ` +
          `Add currencyGate: "gated" or currencyGate: { exempt: "reason" } to each.`
      ).toHaveLength(0);
    });
  });

  describe("Excluded by design (resource-only routes)", () => {
    for (const route of RESOURCE_ONLY_ROUTES) {
      it(`${route.name}: ${route.resourceOnlyReason}`, () => {
        expect(route.resourceOnly).toBe(true);
        expect(route.resourceOnlyReason).toBeTruthy();
      });
    }
  });

  for (const route of TESTABLE_ROUTES) {
    describe(route.name, () => {
      for (const state of ["fresh", "inr", "non_inr"] as ShopState[]) {
        const stateLabel =
          state === "fresh"
            ? "(a) Fresh install"
            : state === "inr"
              ? "(b) Seeded INR"
              : "(c) Non-INR (USD)";

        it(`${stateLabel}: loads and renders without errors`, async () => {
          const shopDomain = getShopDomain(state);
          let urlPath = route.urlPath;
          const params: Record<string, string> = route.hasParams ? { ...route.hasParams } : {};

          if (route.hasParams?.id === "BUYER_ID") {
            if (state === "inr") {
              urlPath = urlPath.replace("BUYER_ID", INR_BUYER_ID);
              params.id = INR_BUYER_ID;
            } else if (state === "non_inr") {
              urlPath = urlPath.replace("BUYER_ID", USD_BUYER_ID);
              params.id = USD_BUYER_ID;
            } else {
              urlPath = urlPath.replace("BUYER_ID", "nonexistent-buyer-" + TEST_SUFFIX);
              params.id = "nonexistent-buyer-" + TEST_SUFFIX;
            }
          }

          const loaderArgs = createLoaderArgs(urlPath, params, shopDomain);
          const mod = await import(route.importPath);

          let loaderResult: unknown;
          let redirectResponse: Response | null = null;

          try {
            loaderResult = await mod.loader(loaderArgs as never);
          } catch (err) {
            if (err instanceof Response && (err.status === 302 || err.status === 303)) {
              redirectResponse = err;
            } else {
              throw new Error(
                `Loader threw unexpected error for ${route.name} in state ${state}: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }

          if (redirectResponse) {
            const location = redirectResponse.headers.get("Location");
            const expectedRedirect = route.expectedRedirect?.[state];

            expect(
              expectedRedirect,
              `${route.name} redirected to "${location}" in state ${state} but no expectedRedirect was declared. ` +
                `Add expectedRedirect.${state} = { location: "${location}" } to the route config.`
            ).toBeTruthy();

            expect(
              location,
              `${route.name} redirected but no Location header in state ${state}`
            ).toBeTruthy();

            if (typeof expectedRedirect!.location === "string") {
              expect(location).toBe(expectedRedirect!.location);
            } else {
              expect(location).toMatch(expectedRedirect!.location);
            }
            return;
          }

          const expectedRedirect = route.expectedRedirect?.[state];
          expect(
            expectedRedirect,
            `${route.name} was expected to redirect in state ${state} (expectedRedirect.${state} declared) but it did not redirect.`
          ).toBeFalsy();

          const rawData = extractLoaderResult<Record<string, unknown>>(loaderResult);
          const data = await awaitAllDeferredData(rawData);

          const expectedError = route.expectedError?.[state];
          if (expectedError) {
            const errorField = data.error as string | undefined;
            expect(
              errorField,
              `${route.name} expected error in state ${state} but loader returned no error field`
            ).toBeTruthy();

            if (typeof expectedError.error === "string") {
              expect(errorField).toBe(expectedError.error);
            } else {
              expect(errorField).toMatch(expectedError.error);
            }
          } else if ("error" in data && data.error) {
            throw new Error(
              `${route.name} returned unexpected error in state ${state}: "${data.error}". ` +
                `Add expectedError.${state} = { error: "${data.error}" } to the route config if this is expected.`
            );
          }

          mockUseLoaderData.mockReturnValue(data);

          let html: string;
          try {
            html = renderToString(createElement(mod.default));
          } catch (err) {
            throw new Error(
              `Render threw error for ${route.name} in state ${state}: ${err instanceof Error ? err.message : String(err)}`
            );
          }

          const junkCheck = hasJunkText(html);
          expect(junkCheck.found, `Found junk text "${junkCheck.match}" in ${route.name}`).toBe(
            false
          );

          expect(
            hasVisibleHeading(html),
            `Missing visible heading (s-page heading or h1) in ${route.name}`
          ).toBe(true);

          if (state === "non_inr") {
            if (route.currencyGate === "gated") {
              if (!route.expectedError?.[state]) {
                expect(
                  html.includes(CURRENCY_NOT_SUPPORTED_BANNER_COPY),
                  `${route.name} should show currency banner in non-INR state`
                ).toBe(true);

                expect(
                  hasRupeeSymbol(html),
                  `${route.name} should NOT show ₹ symbol on currency-gated page in non-INR state`
                ).toBe(false);
              }
            } else if (typeof route.currencyGate === "object" && route.currencyGate.exempt) {
              expect(
                html.includes(CURRENCY_NOT_SUPPORTED_BANNER_COPY),
                `${route.name} is currency-gate exempt (${route.currencyGate.exempt}) but showed the banner`
              ).toBe(false);

              expect(
                hasRupeeSymbol(html),
                `${route.name} (exempt: ${route.currencyGate.exempt}) should NOT show ₹ symbol in non-INR state`
              ).toBe(false);
            }
          }

          if (state === "inr" && route.expectsSeededMoney) {
            expect(
              hasRupeeSymbol(html),
              `${route.name} should show ₹ symbol for INR amounts in state ${state}`
            ).toBe(true);

            if (route.seededMoneyValues) {
              for (const expectedAmount of route.seededMoneyValues) {
                expect(
                  html.includes(expectedAmount),
                  `${route.name} should include exact seeded amount "${expectedAmount}" in state ${state}. ` +
                    `This validates Indian grouping (lakhs/crores) format.`
                ).toBe(true);
              }
            }

            if (route.seededTextValues) {
              for (const expectedText of route.seededTextValues) {
                expect(
                  html.includes(expectedText),
                  `${route.name} should include seeded text "${expectedText}" proving loader data reached the component`
                ).toBe(true);
              }
            }
          }

          if (state === "fresh" && route.name === "app._index") {
            expect(
              html.includes(FRESH_EMPTY_STATE_HEADING),
              `${route.name} in fresh state should show empty-state heading "${FRESH_EMPTY_STATE_HEADING}"`
            ).toBe(true);

            expect(
              html.includes(FRESH_EMPTY_STATE_SUBHEADING),
              `${route.name} in fresh state should show empty-state subheading containing "${FRESH_EMPTY_STATE_SUBHEADING}"`
            ).toBe(true);
          }
        });
      }
    });
  }
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

  it("Indian grouping for lakhs (10,00,000 paise = ₹10,000.00)", async () => {
    const { formatPaiseAmount } = await import("~/lib/aging");
    expect(formatPaiseAmount(1000000n, "INR")).toBe("₹10,000.00");
  });

  it("Indian grouping for crores", async () => {
    const { formatPaiseAmount } = await import("~/lib/aging");
    expect(formatPaiseAmount(10000000000n, "INR")).toBe("₹10,00,00,000.00");
  });
});
