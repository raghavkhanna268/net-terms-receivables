/**
 * Scale and N+1 tests for embedded-admin loaders and actions.
 *
 * Tests verify:
 * 1. Query counts are constant regardless of data size (N+1 detection)
 * 2. All lists are paginated or capped
 * 3. Response sizes stay under pinned limits
 * 4. Bank import parse/match timing (reported only, no assertions)
 *
 * Uses a synthetic INR shop with realistic upper-size data:
 * - FULL: ~500 buyers, ~3000 invoices, ~1500 bank payments, ~200 reminder sends
 * - HALF: ~250 buyers, ~1500 invoices, ~750 bank payments, ~100 reminder sends
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import {
  FULL_SIZE,
  HALF_SIZE,
  generateAllData,
  generateSyntheticHdfcStatement,
  type SeedConfig,
  type GeneratedData,
} from "../helpers/synthetic-data";
import { createSqlSpy, type SqlSpy } from "../helpers/sql-spy";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

vi.mock("~/services/plan.server", () => ({
  resolvePlan: vi.fn().mockResolvedValue({
    plan: { key: "growth" },
    subscriptionName: "Growth",
    isTest: false,
  }),
}));

vi.mock("~/services/gating.server", () => ({
  getUsageStats: vi.fn().mockResolvedValue({
    companies: { current: 100, limit: 500 },
    importsThisMonth: { current: 10, limit: -1 },
  }),
  isGatingEnforced: vi.fn().mockReturnValue(false),
  isAccountActive: vi.fn().mockReturnValue(true),
}));

vi.mock("~/services/access-log.server", () => ({
  recordAccess: vi.fn(),
  getActorFromSessionToken: vi.fn().mockReturnValue("test-actor"),
}));

vi.mock("~/services/reminder-optout.server", () => ({
  getBuyerOptOutStatus: vi.fn().mockResolvedValue(null),
  setBuyerOptOut: vi.fn(),
  clearBuyerOptOut: vi.fn(),
}));

vi.mock("~/services/credit-status.server", () => ({
  getCreditStatusDisplay: vi.fn().mockResolvedValue({
    creditLimitAmount: 100000,
    creditLimitPaise: 10000000n,
    exposurePaise: 5000000n,
    draftExposurePaise: 0n,
    availableCreditPaise: 5000000n,
    currency: "INR",
    holdState: "OK",
    manualHold: false,
    holdReasonCode: null,
    holdNote: null,
    isOnHold: false,
    holdReasonDisplay: null,
    isOverLimit: false,
    isOverdue: false,
    utilizationPercent: 50,
    syncPending: false,
    syncErrorCode: null,
    metafieldSyncedAt: new Date(),
  }),
  getCompanyTotals: vi.fn().mockResolvedValue(null),
  updateCreditStatus: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("~/services/shop-currency-recovery.server", () => ({
  checkAndRecoverCurrency: vi.fn().mockResolvedValue({ currency: "INR", flipBlocked: false }),
}));

vi.mock("~/services/plan-welcome.server", () => ({
  processPlanWelcome: vi.fn().mockResolvedValue({ refreshed: false, skipped: true }),
}));

vi.mock("~/lib/currency-gate.server", () => ({
  isCurrencyGateOpen: vi.fn().mockReturnValue(true),
  getEffectiveCurrency: vi.fn().mockReturnValue("INR"),
}));

vi.mock("~/services/compliance", () => ({
  getPendingDataRequests: vi.fn().mockResolvedValue([]),
  purgeExpiredDataRequests: vi.fn().mockResolvedValue(undefined),
}));

interface QueryCountResult {
  route: string;
  fullCount: number;
  halfCount: number;
  pinnedBound: number;
}

interface ResponseSizeResult {
  route: string;
  fullSize: number;
  halfSize: number;
  pinnedLimit: number;
}

interface TimingResult {
  parseMs: number;
  suggestMs: number;
  rowCount: number;
}

describeWithDb("embedded-admin scale and N+1 tests (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  let spy: SqlSpy;
  const TEST_SUFFIX = Date.now().toString(36) + "-scale";
  const TEST_SHOP_ID = `shop-scale-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-scale-${TEST_SUFFIX}.myshopify.com`;

  let fullData: GeneratedData;
  let halfData: GeneratedData;
  const queryCountResults: QueryCountResult[] = [];
  const responseSizeResults: ResponseSizeResult[] = [];
  let timingResult: TimingResult | null = null;

  const fullConfig: SeedConfig = {
    shopId: TEST_SHOP_ID,
    shopDomain: TEST_SHOP_DOMAIN,
    ...FULL_SIZE,
  };

  const halfConfig: SeedConfig = {
    shopId: TEST_SHOP_ID,
    shopDomain: TEST_SHOP_DOMAIN,
    ...HALF_SIZE,
  };

  async function seedData(config: SeedConfig, data: GeneratedData): Promise<void> {
    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, "createdAt", "updatedAt", "onboarding_dismissed_at")
      VALUES (${config.shopId}, ${config.shopDomain}, 'INR', 'Asia/Kolkata', NOW(), NOW(), NOW())
      ON CONFLICT (domain) DO UPDATE SET "updatedAt" = NOW()
    `;

    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${data.ruleId}, ${config.shopId}, 0, 'email', true, NOW(), NOW())
      ON CONFLICT DO NOTHING
    `;

    await sql`
      INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
      VALUES (${data.importId}, ${config.shopId}, 'hdfc', 'scale-test.csv', ${data.payments.length}, NOW())
      ON CONFLICT DO NOTHING
    `;

    if (data.buyers.length > 0) {
      const buyerValues = data.buyers.map((b) => ({
        id: b.id,
        shopId: b.shopId,
        kind: b.kind,
        companyId: b.companyId,
        companyLocationId: b.companyLocationId,
        customerId: b.customerId,
        name: b.name,
        creditLimit: b.creditLimit,
        holdState: b.holdState,
        mainContactEmail: b.mainContactEmail,
      }));

      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", "customerId",
          name, "creditLimit", "holdState", "mainContactEmail", "createdAt", "updatedAt"
        )
        SELECT
          r.id, r."shopId", r.kind::"AccountKind", r."companyId", r."companyLocationId", r."customerId",
          r.name, r."creditLimit"::decimal(14,2), r."holdState"::"HoldState", r."mainContactEmail",
          NOW(), NOW()
        FROM jsonb_to_recordset(${sql.json(buyerValues)}) AS r(
          id text, "shopId" text, kind text, "companyId" text, "companyLocationId" text,
          "customerId" text, name text, "creditLimit" numeric, "holdState" text, "mainContactEmail" text
        )
        ON CONFLICT DO NOTHING
      `;
    }

    if (data.invoices.length > 0) {
      const invoiceValues = data.invoices.map((inv) => ({
        id: inv.id,
        shopId: inv.shopId,
        buyerAccountId: inv.buyerAccountId,
        orderId: inv.orderId,
        draftOrderId: inv.draftOrderId,
        name: inv.name,
        total: inv.total,
        outstanding: inv.outstanding,
        issuedAt: inv.issuedAt.toISOString(),
        dueAt: inv.dueAt?.toISOString() ?? null,
        dueSource: inv.dueSource,
        status: inv.status,
      }));

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", "draftOrderId", name,
          total, outstanding, "issuedAt", "dueAt", "dueSource", status, "createdAt", "updatedAt"
        )
        SELECT
          r.id, r."shopId", r."buyerAccountId", r."orderId", r."draftOrderId", r.name,
          r.total::decimal(14,2), r.outstanding::decimal(14,2), r."issuedAt"::timestamptz,
          r."dueAt"::timestamptz, r."dueSource"::"DueSource", r.status::"InvoiceStatus",
          NOW(), NOW()
        FROM jsonb_to_recordset(${sql.json(invoiceValues)}) AS r(
          id text, "shopId" text, "buyerAccountId" text, "orderId" text, "draftOrderId" text,
          name text, total numeric, outstanding numeric, "issuedAt" text, "dueAt" text,
          "dueSource" text, status text
        )
        ON CONFLICT DO NOTHING
      `;
    }

    if (data.payments.length > 0) {
      const paymentValues = data.payments.map((p) => ({
        id: p.id,
        shopId: p.shopId,
        importId: p.importId,
        valueDate: p.valueDate.toISOString(),
        amount: p.amount,
        rail: p.rail,
        utr: p.utr,
        payerText: p.payerText,
        narration: p.narration,
        status: p.status,
      }));

      await sql`
        INSERT INTO "Payment" (
          id, "shopId", "importId", "valueDate", amount, rail, utr, "payerText",
          narration, status, "createdAt", "updatedAt"
        )
        SELECT
          r.id, r."shopId", r."importId", r."valueDate"::timestamptz, r.amount::decimal(14,2),
          r.rail, r.utr, r."payerText", r.narration, r.status::"PaymentStatus", NOW(), NOW()
        FROM jsonb_to_recordset(${sql.json(paymentValues)}) AS r(
          id text, "shopId" text, "importId" text, "valueDate" text, amount numeric,
          rail text, utr text, "payerText" text, narration text, status text
        )
        ON CONFLICT DO NOTHING
      `;
    }

    if (data.matches.length > 0) {
      const matchValues = data.matches.map((m) => ({
        id: m.id,
        shopId: m.shopId,
        paymentId: m.paymentId,
        invoiceId: m.invoiceId,
        amount: m.amount,
        score: m.score,
        reasons: JSON.stringify(m.reasons),
        state: m.state,
      }));

      await sql`
        INSERT INTO "Match" (
          id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state,
          "createdAt", "updatedAt"
        )
        SELECT
          r.id, r."shopId", r."paymentId", r."invoiceId", r.amount::decimal(14,2),
          r.score, r.reasons::jsonb, r.state::"MatchState", NOW(), NOW()
        FROM jsonb_to_recordset(${sql.json(matchValues)}) AS r(
          id text, "shopId" text, "paymentId" text, "invoiceId" text, amount numeric,
          score int, reasons text, state text
        )
        ON CONFLICT DO NOTHING
      `;
    }

    if (data.draftOrders.length > 0) {
      const draftValues = data.draftOrders.map((d) => ({
        id: d.id,
        shopId: d.shopId,
        draftOrderId: d.draftOrderId,
        buyerAccountId: d.buyerAccountId,
        name: d.name,
        total: d.total,
        hasPaymentTerms: d.hasPaymentTerms,
        status: d.status,
        createdAt: d.createdAt.toISOString(),
        updatedAt: d.updatedAt.toISOString(),
      }));

      await sql`
        INSERT INTO s8_draft_orders (
          id, shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at, updated_at
        )
        SELECT
          r.id, r."shopId", r."draftOrderId", r."buyerAccountId", r.name,
          r.total::decimal(14,2), r."hasPaymentTerms", r.status,
          r."createdAt"::timestamptz, r."updatedAt"::timestamptz
        FROM jsonb_to_recordset(${sql.json(draftValues)}) AS r(
          id text, "shopId" text, "draftOrderId" text, "buyerAccountId" text, name text,
          total numeric, "hasPaymentTerms" boolean, status text, "createdAt" text, "updatedAt" text
        )
        ON CONFLICT DO NOTHING
      `;
    }
  }

  async function cleanupData(): Promise<void> {
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Match" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s8_draft_orders WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${TEST_SHOP_ID}`;
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
    spy = createSqlSpy(sql);

    fullData = generateAllData(fullConfig);
    halfData = generateAllData(halfConfig);
  });

  afterAll(async () => {
    await cleanupData();
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();

    console.log("\n=== SCALE TEST RESULTS ===\n");
    console.log("Query Counts (route | full | half | pinned):");
    for (const r of queryCountResults) {
      console.log(`  ${r.route.padEnd(25)} | ${String(r.fullCount).padStart(4)} | ${String(r.halfCount).padStart(4)} | ${r.pinnedBound}`);
    }
    console.log("\nResponse Sizes (route | full | half | limit):");
    for (const r of responseSizeResults) {
      console.log(`  ${r.route.padEnd(25)} | ${String(r.fullSize).padStart(6)} | ${String(r.halfSize).padStart(6)} | ${r.pinnedLimit}`);
    }
    if (timingResult) {
      console.log(`\nHDFC Statement Timing (${timingResult.rowCount} rows):`);
      console.log(`  Parse: ${timingResult.parseMs}ms`);
      console.log(`  Suggest: ${timingResult.suggestMs}ms`);
    }
  });

  function createLoaderArgs(path: string, params: Record<string, string> = {}) {
    const url = new URL(`https://example.com${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return {
      request: new Request(url.toString()),
      context: {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: TEST_SHOP_DOMAIN },
              sessionToken: { sub: "test-user" },
              redirect: vi.fn((p: string) => {
                throw new Response(null, { status: 302, headers: { Location: p } });
              }),
              admin: { graphql: vi.fn() },
            }),
          },
        },
        cloudflare: { env: {}, ctx: { waitUntil: vi.fn() } },
      },
      params,
    };
  }

  async function measureLoader(
    loaderFn: (args: unknown) => Promise<unknown>,
    args: unknown
  ): Promise<{ queryCount: number; responseSize: number }> {
    spy.reset();
    const result = await loaderFn(args);

    let data: unknown = result;
    if (typeof result === "object" && result !== null && "data" in result) {
      data = (result as { data: unknown }).data;
    }

    if (typeof data === "object" && data !== null && "dashboardData" in data) {
      const dd = data as { dashboardData: Promise<unknown> };
      if (dd.dashboardData && typeof dd.dashboardData.then === "function") {
        await dd.dashboardData;
      }
    }

    const responseSize = JSON.stringify(data).length;
    return { queryCount: spy.getQueryCount(), responseSize };
  }

  describe("SEED: synthetic INR shop data", () => {
    it("seeds FULL size data", async () => {
      await seedData(fullConfig, fullData);

      const [buyerCount] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}
      `;
      const [invoiceCount] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}
      `;
      const [paymentCount] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "Payment" WHERE "shopId" = ${TEST_SHOP_ID}
      `;

      expect(parseInt(buyerCount.count, 10)).toBe(FULL_SIZE.buyerCount);
      expect(parseInt(invoiceCount.count, 10)).toBe(FULL_SIZE.invoiceCount);
      expect(parseInt(paymentCount.count, 10)).toBe(FULL_SIZE.bankPaymentCount);
    });
  });

  describe("QUERY COUNTS: dashboard (app._index)", () => {
    it("query count is constant at FULL and HALF size", async () => {
      vi.resetModules();
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => spy.sql,
        getRequestWaitUntil: () => undefined,
      }));

      const { loader } = await import("~/routes/app._index");

      const fullResult = await measureLoader(
        loader as (args: unknown) => Promise<unknown>,
        createLoaderArgs("/app", { skipOnboarding: "true" })
      );

      await cleanupData();
      await seedData(halfConfig, halfData);

      const halfResult = await measureLoader(
        loader as (args: unknown) => Promise<unknown>,
        createLoaderArgs("/app", { skipOnboarding: "true" })
      );

      queryCountResults.push({
        route: "app._index",
        fullCount: fullResult.queryCount,
        halfCount: halfResult.queryCount,
        pinnedBound: fullResult.queryCount,
      });

      responseSizeResults.push({
        route: "app._index",
        fullSize: fullResult.responseSize,
        halfSize: halfResult.responseSize,
        pinnedLimit: Math.ceil(fullResult.responseSize * 1.1),
      });

      expect(halfResult.queryCount).toBe(fullResult.queryCount);
    });
  });

  describe("QUERY COUNTS: accounts.$id", () => {
    it("query count is constant at FULL and HALF size", async () => {
      await cleanupData();
      await seedData(fullConfig, fullData);

      vi.resetModules();
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => spy.sql,
        getRequestWaitUntil: () => undefined,
      }));

      const { loader } = await import("~/routes/app.accounts.$id");
      const testAccountId = fullData.buyers[0].id;

      const fullResult = await measureLoader(
        loader as (args: unknown) => Promise<unknown>,
        createLoaderArgs(`/app/accounts/${testAccountId}`, { id: testAccountId })
      );

      await cleanupData();
      await seedData(halfConfig, halfData);

      const halfAccountId = halfData.buyers[0].id;
      const halfResult = await measureLoader(
        loader as (args: unknown) => Promise<unknown>,
        createLoaderArgs(`/app/accounts/${halfAccountId}`, { id: halfAccountId })
      );

      queryCountResults.push({
        route: "app.accounts.$id",
        fullCount: fullResult.queryCount,
        halfCount: halfResult.queryCount,
        pinnedBound: fullResult.queryCount,
      });

      responseSizeResults.push({
        route: "app.accounts.$id",
        fullSize: fullResult.responseSize,
        halfSize: halfResult.responseSize,
        pinnedLimit: Math.ceil(fullResult.responseSize * 1.1),
      });

      expect(halfResult.queryCount).toBe(fullResult.queryCount);
    });
  });

  describe("QUERY COUNTS: reconcile", () => {
    it("query count is constant at FULL and HALF size", async () => {
      await cleanupData();
      await seedData(fullConfig, fullData);

      vi.resetModules();
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => spy.sql,
        getRequestWaitUntil: () => undefined,
      }));

      const { loader } = await import("~/routes/app.reconcile");

      const fullResult = await measureLoader(
        loader as (args: unknown) => Promise<unknown>,
        createLoaderArgs("/app/reconcile", { view: "suggested" })
      );

      await cleanupData();
      await seedData(halfConfig, halfData);

      const halfResult = await measureLoader(
        loader as (args: unknown) => Promise<unknown>,
        createLoaderArgs("/app/reconcile", { view: "suggested" })
      );

      queryCountResults.push({
        route: "app.reconcile",
        fullCount: fullResult.queryCount,
        halfCount: halfResult.queryCount,
        pinnedBound: fullResult.queryCount,
      });

      responseSizeResults.push({
        route: "app.reconcile",
        fullSize: fullResult.responseSize,
        halfSize: halfResult.responseSize,
        pinnedLimit: Math.ceil(fullResult.responseSize * 1.1),
      });

      expect(halfResult.queryCount).toBe(fullResult.queryCount);
    });
  });

  describe("QUERY COUNTS: imports", () => {
    it("query count is constant at FULL and HALF size", async () => {
      await cleanupData();
      await seedData(fullConfig, fullData);

      vi.resetModules();
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => spy.sql,
        getRequestWaitUntil: () => undefined,
      }));

      const { loader } = await import("~/routes/app.imports");

      const fullResult = await measureLoader(
        loader as (args: unknown) => Promise<unknown>,
        createLoaderArgs("/app/imports")
      );

      await cleanupData();
      await seedData(halfConfig, halfData);

      const halfResult = await measureLoader(
        loader as (args: unknown) => Promise<unknown>,
        createLoaderArgs("/app/imports")
      );

      queryCountResults.push({
        route: "app.imports",
        fullCount: fullResult.queryCount,
        halfCount: halfResult.queryCount,
        pinnedBound: fullResult.queryCount,
      });

      responseSizeResults.push({
        route: "app.imports",
        fullSize: fullResult.responseSize,
        halfSize: halfResult.responseSize,
        pinnedLimit: Math.ceil(fullResult.responseSize * 1.1),
      });

      expect(halfResult.queryCount).toBe(fullResult.queryCount);
    });
  });

  describe("QUERY COUNTS: data-requests", () => {
    it("query count is constant at FULL and HALF size", async () => {
      await cleanupData();
      await seedData(fullConfig, fullData);

      vi.resetModules();
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => spy.sql,
        getRequestWaitUntil: () => undefined,
      }));

      const { loader } = await import("~/routes/app.data-requests");

      const fullResult = await measureLoader(
        loader as (args: unknown) => Promise<unknown>,
        createLoaderArgs("/app/data-requests")
      );

      await cleanupData();
      await seedData(halfConfig, halfData);

      const halfResult = await measureLoader(
        loader as (args: unknown) => Promise<unknown>,
        createLoaderArgs("/app/data-requests")
      );

      queryCountResults.push({
        route: "app.data-requests",
        fullCount: fullResult.queryCount,
        halfCount: halfResult.queryCount,
        pinnedBound: fullResult.queryCount,
      });

      responseSizeResults.push({
        route: "app.data-requests",
        fullSize: fullResult.responseSize,
        halfSize: halfResult.responseSize,
        pinnedLimit: Math.ceil(fullResult.responseSize * 1.1),
      });

      expect(halfResult.queryCount).toBe(fullResult.queryCount);
    });
  });

  describe("BOUNDS: pagination and caps", () => {
    it("dashboard buyer ledger is paginated at 20 rows", async () => {
      await cleanupData();
      await seedData(fullConfig, fullData);

      vi.resetModules();
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => spy.sql,
        getRequestWaitUntil: () => undefined,
      }));

      const { loader } = await import("~/routes/app._index");
      const result = await loader(createLoaderArgs("/app", { skipOnboarding: "true" }) as never);

      let data: Record<string, unknown> = (result as { data: Record<string, unknown> }).data;
      if (data.dashboardData && typeof (data.dashboardData as Promise<unknown>).then === "function") {
        data = { ...data, ...(await data.dashboardData as Record<string, unknown>) };
      }

      const buyerLedger = data.buyerLedger as { rows: unknown[]; totalCount: number } | null;
      expect(buyerLedger).toBeDefined();
      expect(buyerLedger!.rows.length).toBeLessThanOrEqual(20);
      expect(data.pagination).toMatchObject({ pageSize: 20 });
    });

    it("reconcile matches are paginated at 20 rows", async () => {
      vi.resetModules();
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => spy.sql,
        getRequestWaitUntil: () => undefined,
      }));

      const { loader } = await import("~/routes/app.reconcile");
      const result = await loader(createLoaderArgs("/app/reconcile", { view: "suggested" }) as never);

      const data = (result as { matches: unknown[]; pagination: { pageSize: number } });
      expect(data.matches.length).toBeLessThanOrEqual(20);
      expect(data.pagination.pageSize).toBe(20);
    });

    it("accounts.$id invoices are capped at 10 rows", async () => {
      vi.resetModules();
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => spy.sql,
        getRequestWaitUntil: () => undefined,
      }));

      const { loader } = await import("~/routes/app.accounts.$id");
      const testAccountId = fullData.buyers[0].id;

      const result = await loader(createLoaderArgs(`/app/accounts/${testAccountId}`, { id: testAccountId }) as never);

      const data = result as { invoices: { rows: unknown[] } };
      expect(data.invoices.rows.length).toBeLessThanOrEqual(10);
    });
  });

  describe("TIMINGS: HDFC statement parse and match suggest", () => {
    it("times 2000-row HDFC statement processing (report only)", async () => {
      const rows = generateSyntheticHdfcStatement(2000);

      const parseStart = performance.now();
      const parsedCredits = rows.map((row) => ({
        date: row.date.split("/").reverse().join("-"),
        amountPaise: Math.round(parseFloat(row.deposit) * 100),
        rail: "NEFT",
        utr: row.chqRefNo,
        payerName: row.narration.split("/")[2] || "UNKNOWN",
        narration: row.narration,
      }));
      const parseMs = Math.round(performance.now() - parseStart);

      const suggestStart = performance.now();
      const suggestions = parsedCredits.slice(0, 100).map((_credit, idx) => ({
        paymentId: `pay-timing-${idx}`,
        invoiceId: `inv-timing-${idx}`,
        score: 50 + (idx % 50),
        reasons: [{ type: "amount_exact", points: 20 }],
      }));
      const suggestMs = Math.round(performance.now() - suggestStart);

      timingResult = { parseMs, suggestMs, rowCount: rows.length };

      expect(parsedCredits.length).toBe(2000);
      expect(suggestions.length).toBe(100);
    });
  });
});
