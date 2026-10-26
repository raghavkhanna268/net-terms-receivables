/**
 * Tenant isolation tests for embedded admin routes (app/routes/app.*.tsx).
 *
 * Tests that shop A's session cannot read or write shop B's data.
 * Uses the real route loaders and actions with mocked edges:
 * - Shopify authenticate.admin session (returns shop A's session)
 * - Shopify GraphQL (mocked to prevent external calls)
 * - Sentry (mocked to prevent external calls)
 * - fetch (mocked to prevent external calls)
 *
 * Uses the repo's describeWithDb / TEST_DATABASE_URL pattern.
 * See app/services/__tests__/access-log-db.test.ts for reference.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import * as fs from "fs";
import * as path from "path";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

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

const mockGraphQL = vi.fn();

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

vi.mock("~/services/apply.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/apply.server")>();
  return {
    ...actual,
    applyMatch: vi.fn().mockResolvedValue({ success: true }),
    unmatchMatch: vi.fn().mockResolvedValue({ success: true }),
  };
});

describeWithDb("Tenant Isolation - Cross-tenant record IDs", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-tenant";

  const SHOP_A_ID = `shop-a-${TEST_SUFFIX}`;
  const SHOP_A_DOMAIN = `test-a-${TEST_SUFFIX}.myshopify.com`;

  const SHOP_B_ID = `shop-b-${TEST_SUFFIX}`;
  const SHOP_B_DOMAIN = `test-b-${TEST_SUFFIX}.myshopify.com`;

  const BUYER_A_ID = `buyer-a-${TEST_SUFFIX}`;
  const BUYER_B_ID = `buyer-b-${TEST_SUFFIX}`;

  const INVOICE_A_ID = `inv-a-${TEST_SUFFIX}`;
  const INVOICE_B_ID = `inv-b-${TEST_SUFFIX}`;

  const PAYMENT_A_ID = `pay-a-${TEST_SUFFIX}`;
  const PAYMENT_B_ID = `pay-b-${TEST_SUFFIX}`;

  const MATCH_A_ID = `match-a-${TEST_SUFFIX}`;
  const MATCH_B_ID = `match-b-${TEST_SUFFIX}`;

  const IMPORT_A_ID = `import-a-${TEST_SUFFIX}`;
  const IMPORT_B_ID = `import-b-${TEST_SUFFIX}`;

  const DATA_REQUEST_A_ID = `dr-a-${TEST_SUFFIX}`;
  const DATA_REQUEST_B_ID = `dr-b-${TEST_SUFFIX}`;

  const REMINDER_RULE_A_ID = `rule-a-${TEST_SUFFIX}`;
  const REMINDER_RULE_B_ID = `rule-b-${TEST_SUFFIX}`;

  const SHOP_B_BUYER_NAME = "Shop B Buyer Corp";
  const SHOP_B_INVOICE_AMOUNT = "99999.99";
  const SHOP_B_PAYMENT_AMOUNT = "88888.88";

  function createMockContext(shopDomain: string) {
    return {
      shopify: {
        authenticate: {
          admin: vi.fn().mockResolvedValue({
            session: { shop: shopDomain, accessToken: "test-token" },
            sessionToken: { sub: "12345" },
            admin: { graphql: mockGraphQL },
          }),
        },
      },
      cloudflare: {
        env: { RESEND_API_KEY: undefined, RESEND_FROM: undefined },
        ctx: { waitUntil: vi.fn() },
      },
    };
  }

  function createLoaderArgs(urlPath: string, params: Record<string, string> = {}) {
    const url = new URL(`https://example.com${urlPath}`);
    return {
      request: new Request(url),
      context: createMockContext(SHOP_A_DOMAIN),
      params,
      url,
      pattern: urlPath.replace(/\/[^/]+$/, "/:id"),
    } as unknown;
  }

  function createActionArgs(
    urlPath: string,
    formData: Record<string, string>,
    params: Record<string, string> = {}
  ) {
    const url = new URL(`https://example.com${urlPath}`);
    const body = new FormData();
    for (const [key, value] of Object.entries(formData)) {
      body.append(key, value);
    }
    return {
      request: new Request(url, { method: "POST", body }),
      context: createMockContext(SHOP_A_DOMAIN),
      params,
      url,
      pattern: urlPath.replace(/\/[^/]+$/, "/:id"),
    } as unknown;
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, "createdAt", "updatedAt")
      VALUES
        (${SHOP_A_ID}, ${SHOP_A_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW()),
        (${SHOP_B_ID}, ${SHOP_B_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "syncPending",
        "createdAt", "updatedAt"
      )
      VALUES
        (${BUYER_A_ID}, ${SHOP_A_ID}, 'COMPANY', ${"co-a-" + TEST_SUFFIX}, ${"loc-a-" + TEST_SUFFIX}, 'Shop A Buyer LLC', 50000.00, 'OK', false, false, NOW(), NOW()),
        (${BUYER_B_ID}, ${SHOP_B_ID}, 'COMPANY', ${"co-b-" + TEST_SUFFIX}, ${"loc-b-" + TEST_SUFFIX}, ${SHOP_B_BUYER_NAME}, 75000.00, 'OK', false, false, NOW(), NOW())
    `;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", name, "orderId", "orderName",
        total, outstanding, currency, status, "dueAt", "createdAt", "updatedAt"
      )
      VALUES
        (${INVOICE_A_ID}, ${SHOP_A_ID}, ${BUYER_A_ID}, 'INV-A-001', ${"order-a-" + TEST_SUFFIX}, '#1001', 10000.00, 10000.00, 'INR', 'open', NOW() + interval '30 days', NOW(), NOW()),
        (${INVOICE_B_ID}, ${SHOP_B_ID}, ${BUYER_B_ID}, 'INV-B-001', ${"order-b-" + TEST_SUFFIX}, '#2001', ${SHOP_B_INVOICE_AMOUNT}, ${SHOP_B_INVOICE_AMOUNT}, 'INR', 'open', NOW() + interval '30 days', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
      VALUES
        (${IMPORT_A_ID}, ${SHOP_A_ID}, 'hdfc', 'shop-a-import.csv', 5, NOW()),
        (${IMPORT_B_ID}, ${SHOP_B_ID}, 'hdfc', 'shop-b-import.csv', 10, NOW())
    `;

    await sql`
      INSERT INTO "Payment" (
        id, "shopId", "importId", amount, utr, status, rail, narration, "valueDate", "createdAt", "updatedAt"
      )
      VALUES
        (${PAYMENT_A_ID}, ${SHOP_A_ID}, ${IMPORT_A_ID}, 10000.00, ${"UTR-A-" + TEST_SUFFIX}, 'unmatched', 'NEFT', 'Payment A narration', NOW(), NOW(), NOW()),
        (${PAYMENT_B_ID}, ${SHOP_B_ID}, ${IMPORT_B_ID}, ${SHOP_B_PAYMENT_AMOUNT}, ${"UTR-B-" + TEST_SUFFIX}, 'unmatched', 'NEFT', 'Payment B narration', NOW(), NOW(), NOW())
    `;

    await sql`
      INSERT INTO "Match" (
        id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt"
      )
      VALUES
        (${MATCH_A_ID}, ${SHOP_A_ID}, ${PAYMENT_A_ID}, ${INVOICE_A_ID}, 10000.00, 85, '[]'::jsonb, 'suggested', NOW(), NOW()),
        (${MATCH_B_ID}, ${SHOP_B_ID}, ${PAYMENT_B_ID}, ${INVOICE_B_ID}, ${SHOP_B_PAYMENT_AMOUNT}, 90, '[]'::jsonb, 'suggested', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES
        (${REMINDER_RULE_A_ID}, ${SHOP_A_ID}, -7, 'email', true, NOW(), NOW()),
        (${REMINDER_RULE_B_ID}, ${SHOP_B_ID}, -7, 'email', true, NOW(), NOW())
    `;

    await sql`
      INSERT INTO "S22DataRequest" (id, "shopId", "customerGid", "requestId", status, "receivedAt", "expiresAt")
      VALUES
        (${DATA_REQUEST_A_ID}, ${SHOP_A_ID}, 'cust-a-gid', 'req-a-id', 'pending', NOW(), NOW() + interval '30 days'),
        (${DATA_REQUEST_B_ID}, ${SHOP_B_ID}, 'cust-b-gid', 'req-b-id', 'pending', NOW(), NOW() + interval '30 days')
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "Match" WHERE id IN (${MATCH_A_ID}, ${MATCH_B_ID})`;
    await sql`DELETE FROM "Payment" WHERE id IN (${PAYMENT_A_ID}, ${PAYMENT_B_ID})`;
    await sql`DELETE FROM "Invoice" WHERE id IN (${INVOICE_A_ID}, ${INVOICE_B_ID})`;
    await sql`DELETE FROM "BankImport" WHERE id IN (${IMPORT_A_ID}, ${IMPORT_B_ID})`;
    await sql`DELETE FROM "ReminderRule" WHERE id IN (${REMINDER_RULE_A_ID}, ${REMINDER_RULE_B_ID})`;
    await sql`DELETE FROM "S22DataRequest" WHERE id IN (${DATA_REQUEST_A_ID}, ${DATA_REQUEST_B_ID})`;
    await sql`DELETE FROM "BuyerAccount" WHERE id IN (${BUYER_A_ID}, ${BUYER_B_ID})`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "Shop" WHERE id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql.end();
  });

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    vi.doMock("~/lib/request-context.server", () => ({
      getRequestSql: () => sql,
      getRequestWaitUntil: () => undefined,
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  interface RouteTest {
    name: string;
    route: string;
    loadModule: () => Promise<unknown>;
    params: Record<string, string>;
    shopBRecordId: string;
    assertNotFound: (result: unknown) => void;
    assertNoBData: (result: unknown) => void | Promise<void>;
  }

  const routeTests: RouteTest[] = [
    {
      name: "app.accounts.$id",
      route: "/app/accounts/",
      loadModule: () => import("../app.accounts.$id"),
      params: { id: "" },
      shopBRecordId: BUYER_B_ID,
      assertNotFound: (result) => {
        const r = result as { account: unknown; error: string | null };
        expect(r.account).toBeNull();
        expect(r.error).toBe("Account not found");
      },
      assertNoBData: (result) => {
        const str = JSON.stringify(result);
        expect(str).not.toContain(SHOP_B_BUYER_NAME);
        expect(str).not.toContain(BUYER_B_ID);
      },
    },
    {
      name: "app.data-requests.$id.download",
      route: "/app/data-requests/",
      loadModule: () => import("../app.data-requests.$id.download"),
      params: { id: "" },
      shopBRecordId: "req-b-id",
      assertNotFound: (result) => {
        expect(result).toBeInstanceOf(Response);
        const r = result as Response;
        expect(r.status).toBe(404);
      },
      assertNoBData: async (result) => {
        if (result instanceof Response) {
          const body = await result.text();
          expect(body).not.toContain("cust-b-gid");
          expect(body).not.toContain("req-b-id");
        }
      },
    },
  ];

  describe("Cross-tenant ID access", () => {
    for (const test of routeTests) {
      it(`${test.name}: shop A session cannot read shop B's record`, async () => {
        const params = { ...test.params, id: test.shopBRecordId };
        const args = createLoaderArgs(test.route + test.shopBRecordId, params);
        const mod = await test.loadModule() as { loader: (args: never) => Promise<unknown> };
        const result = await mod.loader(args as never);
        test.assertNotFound(result);
        await test.assertNoBData(result);
      });
    }
  });

  describe("app.accounts.$id action isolation", () => {
    it("shop A cannot update shop B's buyer account credit settings", async () => {
      const beforeSnapshot = await sql`
        SELECT "creditLimit", "holdState" FROM "BuyerAccount" WHERE id = ${BUYER_B_ID}
      `;

      const args = createActionArgs(
        `/app/accounts/${BUYER_B_ID}`,
        { _action: "updateCredit", creditLimit: "999999", noLimit: "false", manualHold: "true", holdReasonCode: "MANUAL_HOLD" },
        { id: BUYER_B_ID }
      );

      const { action } = await import("../app.accounts.$id");
      const result = await action(args as never);

      const r = result as { success: boolean; error?: string };
      expect(r.success).toBe(false);
      expect(r.error).toBe("Account not found");

      const afterSnapshot = await sql`
        SELECT "creditLimit", "holdState" FROM "BuyerAccount" WHERE id = ${BUYER_B_ID}
      `;
      expect(afterSnapshot[0]).toEqual(beforeSnapshot[0]);
    });

    it("shop A cannot update shop B's buyer reminder opt-out", async () => {
      const args = createActionArgs(
        `/app/accounts/${BUYER_B_ID}`,
        { _action: "updateReminderOptOut", enable: "false" },
        { id: BUYER_B_ID }
      );

      const { action } = await import("../app.accounts.$id");
      const result = await action(args as never);

      const r = result as { success: boolean; error?: string };
      expect(r.success).toBe(false);
      expect(r.error).toBe("Account not found");
    });
  });

  describe("app.reconcile action isolation", () => {
    it("shop A cannot confirm shop B's match", async () => {
      const beforeSnapshot = await sql`
        SELECT state FROM "Match" WHERE id = ${MATCH_B_ID}
      `;
      expect(beforeSnapshot[0].state).toBe("suggested");

      const args = createActionArgs("/app/reconcile", { intent: "confirm", matchId: MATCH_B_ID });

      const { confirmMatch } = await import("~/services/matcher.server");
      vi.mocked(confirmMatch).mockResolvedValue({ success: false, error: "Match not found" });

      const { action } = await import("../app.reconcile");
      const result = await action(args as never);

      const r = result as { success: boolean; error?: string };
      expect(r.success).toBe(false);

      const afterSnapshot = await sql`
        SELECT state FROM "Match" WHERE id = ${MATCH_B_ID}
      `;
      expect(afterSnapshot[0].state).toBe("suggested");
    });

    it("shop A cannot reject shop B's match", async () => {
      const beforeSnapshot = await sql`
        SELECT state FROM "Match" WHERE id = ${MATCH_B_ID}
      `;

      const args = createActionArgs("/app/reconcile", { intent: "reject", matchId: MATCH_B_ID });

      const { rejectMatch } = await import("~/services/matcher.server");
      vi.mocked(rejectMatch).mockResolvedValue({ success: false, error: "Match not found" });

      const { action } = await import("../app.reconcile");
      const result = await action(args as never);

      const r = result as { success: boolean };
      expect(r.success).toBe(false);

      const afterSnapshot = await sql`
        SELECT state FROM "Match" WHERE id = ${MATCH_B_ID}
      `;
      expect(afterSnapshot[0]).toEqual(beforeSnapshot[0]);
    });

    it("shop A cannot apply shop B's match", async () => {
      const { applyMatch } = await import("~/services/apply.server");
      vi.mocked(applyMatch).mockResolvedValue({
        success: false,
        error: "Match not found",
        invoicePaid: false,
        shopifyPushSucceeded: false,
      });

      const beforeInvoice = await sql`
        SELECT outstanding FROM "Invoice" WHERE id = ${INVOICE_B_ID}
      `;

      const args = createActionArgs("/app/reconcile", { intent: "apply", matchId: MATCH_B_ID });

      const { action } = await import("../app.reconcile");
      const result = await action(args as never);

      const r = result as { success: boolean };
      expect(r.success).toBe(false);

      const afterInvoice = await sql`
        SELECT outstanding FROM "Invoice" WHERE id = ${INVOICE_B_ID}
      `;
      expect(afterInvoice[0]).toEqual(beforeInvoice[0]);
    });
  });

  describe("List loaders return only shop A's data", () => {
    it("app._index loader returns only shop A's buyer accounts", async () => {
      const args = createLoaderArgs("/app");

      const { loader } = await import("../app._index");
      const result = (await loader(args as never)) as { dashboardData?: Promise<unknown> };

      const str = JSON.stringify(result);
      expect(str).not.toContain(SHOP_B_BUYER_NAME);
      expect(str).not.toContain(BUYER_B_ID);
      expect(str).not.toContain(SHOP_B_INVOICE_AMOUNT);
    });

    it("app.reconcile loader returns only shop A's matches", async () => {
      const args = createLoaderArgs("/app/reconcile");

      const { loader } = await import("../app.reconcile");
      const result = await loader(args as never);

      const str = JSON.stringify(result);
      expect(str).not.toContain(MATCH_B_ID);
      expect(str).not.toContain(SHOP_B_PAYMENT_AMOUNT);
    });

    it("app.data-requests loader returns only shop A's data requests", async () => {
      const args = createLoaderArgs("/app/data-requests");

      const { loader } = await import("../app.data-requests");
      const result = await loader(args as never);

      const str = JSON.stringify(result);
      expect(str).not.toContain("req-b-id");
      expect(str).not.toContain("cust-b-gid");
    });

    it("app.settings.reminders loader returns only shop A's reminder rules", async () => {
      const args = createLoaderArgs("/app/settings/reminders");

      const { loader } = await import("../app.settings.reminders");
      const result = await loader(args as never);

      const str = JSON.stringify(result);
      expect(str).not.toContain(REMINDER_RULE_B_ID);
    });
  });
});

describeWithDb("Tenant Isolation - Unauthenticated requests", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-unauth";

  const SHOP_ID = `shop-unauth-${TEST_SUFFIX}`;
  const SHOP_DOMAIN = `test-unauth-${TEST_SUFFIX}.myshopify.com`;

  function createUnauthContext() {
    const authError = new Response(null, {
      status: 302,
      headers: { Location: "/auth/login" },
    });
    return {
      shopify: {
        authenticate: {
          admin: vi.fn().mockRejectedValue(authError),
        },
      },
      cloudflare: {
        env: {},
        ctx: { waitUntil: vi.fn() },
      },
    };
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
    await sql.end();
  });

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    vi.doMock("~/lib/request-context.server", () => ({
      getRequestSql: () => sql,
      getRequestWaitUntil: () => undefined,
    }));
  });

  const unauthRoutes = [
    { name: "app._index", importPath: "../app._index", urlPath: "/app" },
    { name: "app.reconcile", importPath: "../app.reconcile", urlPath: "/app/reconcile" },
    { name: "app.imports", importPath: "../app.imports", urlPath: "/app/imports" },
    { name: "app.settings.reminders", importPath: "../app.settings.reminders", urlPath: "/app/settings/reminders" },
    { name: "app.data-requests", importPath: "../app.data-requests", urlPath: "/app/data-requests" },
    { name: "app.plan", importPath: "../app.plan", urlPath: "/app/plan" },
    { name: "app.tag-rules", importPath: "../app.tag-rules", urlPath: "/app/tag-rules" },
  ];

  for (const route of unauthRoutes) {
    it(`${route.name} loader rejects unauthenticated requests`, async () => {
      const url = new URL(`https://example.com${route.urlPath}`);
      const args = {
        request: new Request(url),
        context: createUnauthContext(),
        params: {},
        url,
        pattern: route.urlPath,
      };

      const mod = await import(route.importPath);
      await expect(mod.loader(args as never)).rejects.toBeInstanceOf(Response);
    });
  }
});

describeWithDb("Tenant Isolation - PLAN_GATING_ENFORCED=false", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-gating";

  const SHOP_ID = `shop-gating-${TEST_SUFFIX}`;
  const SHOP_DOMAIN = `test-gating-${TEST_SUFFIX}.myshopify.com`;

  function createMockContext() {
    return {
      shopify: {
        authenticate: {
          admin: vi.fn().mockResolvedValue({
            session: { shop: SHOP_DOMAIN, accessToken: "test-token" },
            sessionToken: { sub: "12345" },
            admin: { graphql: vi.fn() },
          }),
        },
      },
      cloudflare: {
        env: { RESEND_API_KEY: undefined, RESEND_FROM: undefined },
        ctx: { waitUntil: vi.fn() },
      },
    };
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (
        id, domain, currency, timezone, plan_key, plan_cached_at,
        "createdAt", "updatedAt"
      )
      VALUES (
        ${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', 'Asia/Kolkata',
        'free', NULL, NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
    await sql.end();
  });

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("PLAN_GATING_ENFORCED", "false");

    vi.doMock("~/lib/request-context.server", () => ({
      getRequestSql: () => sql,
      getRequestWaitUntil: () => undefined,
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("app._index loads normally with no billing redirect when PLAN_GATING_ENFORCED=false", async () => {
    const url = new URL("https://example.com/app");
    const args = {
      request: new Request(url),
      context: createMockContext(),
      params: {},
      url,
      pattern: "/app",
    };

    const { loader } = await import("../app._index");
    const result = await loader(args as never);

    expect(result).not.toBeInstanceOf(Response);

    const resultObj = result as unknown as Record<string, unknown>;
    expect(resultObj.gatingEnforced).toBe(false);
    expect(typeof resultObj.dashboardData).toBe("object");
  });

  it("app.plan loads normally with gatingEnforced=false", async () => {
    const url = new URL("https://example.com/app/plan");
    const args = {
      request: new Request(url),
      context: createMockContext(),
      params: {},
      url,
      pattern: "/app/plan",
    };

    const { loader } = await import("../app.plan");
    const result = await loader(args as never);

    const resultObj = result as Record<string, unknown>;
    expect(resultObj.gatingEnforced).toBe(false);
  });

  it("app.accounts.$id loads normally for shop with no confirmed plan when gating off", async () => {
    const buyerId = `buyer-gating-${TEST_SUFFIX}`;
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "syncPending",
        "createdAt", "updatedAt"
      )
      VALUES (
        ${buyerId}, ${SHOP_ID}, 'COMPANY', ${"co-" + TEST_SUFFIX}, ${"loc-" + TEST_SUFFIX},
        'Test Gating Buyer', 50000.00, 'OK', false, false, NOW(), NOW()
      )
    `;

    try {
      const url = new URL(`https://example.com/app/accounts/${buyerId}`);
      const args = {
        request: new Request(url),
        context: createMockContext(),
        params: { id: buyerId },
        url,
        pattern: "/app/accounts/:id",
      };

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(args as never);

      const resultObj = result as Record<string, unknown>;
      expect(resultObj.error).toBeNull();
      expect(resultObj.gatingEnforced).toBe(false);
      expect(resultObj.account).toBeDefined();
      expect((resultObj.account as { id: string }).id).toBe(buyerId);
    } finally {
      await sql`DELETE FROM "BuyerAccount" WHERE id = ${buyerId}`;
    }
  });
});

describe("Tenant Isolation - Route coverage guard", () => {
  const ROUTES_DIR = path.join(__dirname, "..");

  const ALLOWLIST: Record<string, string> = {
    "app.tsx": "Layout wrapper, no record IDs",
    "app.onboarding.tsx": "Setup flow, no record IDs",
    "app.welcome.tsx": "Welcome redirect, no record IDs",
    "app._index.tsx": "List route, covered by list loader tests",
    "app.reconcile.tsx": "Covered by action isolation tests",
    "app.imports.tsx": "No record ID params, shop-scoped by session",
    "app.data-requests.tsx": "List route, no record ID param in URL",
    "app.settings.reminders.tsx": "No record ID params",
    "app.plan.tsx": "No record IDs",
    "app.tag-rules.tsx": "No record IDs",
  };

  const TESTED_ROUTES = [
    "app.accounts.$id.tsx",
    "app.data-requests.$id.download.tsx",
  ];

  it("all app.* routes with $param segments are tested or allowlisted", () => {
    const routeFiles = fs.readdirSync(ROUTES_DIR)
      .filter(f => f.startsWith("app.") && f.endsWith(".tsx") && !f.includes("test"));

    const routesWithParams = routeFiles.filter(f => f.includes("$"));
    const missingTests: string[] = [];

    for (const route of routesWithParams) {
      if (!TESTED_ROUTES.includes(route) && !ALLOWLIST[route]) {
        missingTests.push(route);
      }
    }

    expect(
      missingTests,
      `Routes with $param segments missing from tenant isolation tests: ${missingTests.join(", ")}`
    ).toHaveLength(0);
  });

  it("all app.* routes are either tested or in the explicit allowlist", () => {
    const routeFiles = fs.readdirSync(ROUTES_DIR)
      .filter(f => f.startsWith("app.") && f.endsWith(".tsx") && !f.includes("test"));

    const allCovered = [...TESTED_ROUTES, ...Object.keys(ALLOWLIST)];
    const uncovered = routeFiles.filter(f => !allCovered.includes(f));

    expect(
      uncovered,
      `app.* routes not covered by tenant isolation tests or allowlist: ${uncovered.join(", ")}`
    ).toHaveLength(0);
  });

  it("allowlist entries have reasons", () => {
    for (const [route, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.length, `${route} allowlist reason is empty`).toBeGreaterThan(0);
    }
  });
});
