/**
 * Scale and N+1 tests for embedded-admin loaders and actions.
 *
 * Tests verify:
 * 1. Query counts are constant regardless of data size (N+1 detection)
 * 2. All lists are paginated or capped
 * 3. Response sizes stay under pinned limits
 * 4. Bank import parse/match timing with real parser
 *
 * Uses a synthetic INR shop with realistic upper-size data:
 * - FULL: ~500 buyers, ~3000 invoices, ~1500 bank payments
 * - HALF: ~250 buyers, ~1500 invoices, ~750 bank payments
 * - SMALL: ~5 buyers, ~15 invoices, ~10 bank payments (for visible N+1 detection)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import {
  FULL_SIZE,
  generateAllData,
  generateSyntheticHdfcStatement,
  type SeedConfig,
  type GeneratedData,
} from "../helpers/synthetic-data";
import { createSqlSpy, type SqlSpy } from "../helpers/sql-spy";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const SMALL_SIZE: Omit<SeedConfig, "shopId" | "shopDomain"> = {
  buyerCount: 5,
  invoiceCount: 15,
  bankPaymentCount: 10,
  reminderSendCount: 5,
  draftOrderCount: 5,
};

// Mock ONLY Shopify Admin API and billing callers - DB services use real seeded data
vi.mock("~/services/plan.server", () => ({
  // Justification: resolvePlan calls Shopify Billing API (activeSubscriptions query)
  resolvePlan: vi.fn().mockResolvedValue({
    plan: { key: "growth" },
    subscriptionName: "Growth",
    isTest: false,
  }),
}));

vi.mock("~/services/shop-currency-recovery.server", () => ({
  // Justification: checkAndRecoverCurrency calls Shopify Admin API (shop query)
  checkAndRecoverCurrency: vi.fn().mockResolvedValue({ currency: "INR", flipBlocked: false }),
}));

vi.mock("~/services/plan-welcome.server", () => ({
  // Justification: processPlanWelcome calls Shopify Billing API
  processPlanWelcome: vi.fn().mockResolvedValue({ refreshed: false, skipped: true }),
}));

vi.mock("~/lib/currency-gate.server", () => ({
  // Justification: config-based gate, not DB
  isCurrencyGateOpen: vi.fn().mockReturnValue(true),
  getEffectiveCurrency: vi.fn().mockReturnValue("INR"),
}));

interface QueryCountResult {
  route: string;
  smallCount: number;
  fullCount: number;
  pinnedBound: number;
}

interface ResponseSizeResult {
  route: string;
  bytes: number;
  pinnedLimit: number;
}

interface TimingResult {
  parseMs: number;
  matchMs: number;
  rowCount: number;
}

describeWithDb("embedded-admin scale and N+1 tests (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  let spy: SqlSpy;
  const TEST_SUFFIX = Date.now().toString(36) + "-scale";
  const TEST_SHOP_ID = `shop-scale-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-scale-${TEST_SUFFIX}.myshopify.com`;

  const queryCountResults: QueryCountResult[] = [];
  const responseSizeResults: ResponseSizeResult[] = [];
  let timingResult: TimingResult | null = null;

  const fullConfig: SeedConfig = {
    shopId: TEST_SHOP_ID,
    shopDomain: TEST_SHOP_DOMAIN,
    ...FULL_SIZE,
  };

  const smallConfig: SeedConfig = {
    shopId: TEST_SHOP_ID,
    shopDomain: TEST_SHOP_DOMAIN,
    ...SMALL_SIZE,
  };

  async function cleanupData(): Promise<void> {
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Match" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s8_draft_orders WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s22_data_requests WHERE shop_id = ${TEST_SHOP_ID}`;
  }

  async function seedShop(): Promise<void> {
    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, "createdAt", "updatedAt", "onboarding_dismissed_at")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW(), NOW())
      ON CONFLICT (domain) DO UPDATE SET "updatedAt" = NOW()
    `;
  }

  async function seedData(config: SeedConfig, data: GeneratedData): Promise<void> {
    await seedShop();

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

    // Seed reminder logs
    if (data.reminderLogs.length > 0) {
      const logValues = data.reminderLogs.map((log) => ({
        id: log.id,
        shopId: log.shopId,
        ruleId: log.ruleId,
        invoiceId: log.invoiceId,
        status: log.status,
        sentAt: log.sentAt?.toISOString() ?? null,
      }));

      await sql`
        INSERT INTO "ReminderLog" (
          id, "shopId", "ruleId", "invoiceId", status, "sentAt"
        )
        SELECT
          r.id, r."shopId", r."ruleId", r."invoiceId", r.status::"ReminderLogStatus",
          r."sentAt"::timestamptz
        FROM jsonb_to_recordset(${sql.json(logValues)}) AS r(
          id text, "shopId" text, "ruleId" text, "invoiceId" text, status text, "sentAt" text
        )
        ON CONFLICT DO NOTHING
      `;
    }
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
    spy = createSqlSpy(sql);
  });

  afterAll(async () => {
    await cleanupData();
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();

    console.log("\n=== SCALE TEST RESULTS ===\n");
    console.log("Query Counts (route | small | full | pinned):");
    for (const r of queryCountResults) {
      console.log(`  ${r.route.padEnd(25)} | ${String(r.smallCount).padStart(4)} | ${String(r.fullCount).padStart(4)} | ${r.pinnedBound}`);
    }
    console.log("\nResponse Sizes (route | bytes | limit):");
    for (const r of responseSizeResults) {
      console.log(`  ${r.route.padEnd(25)} | ${String(r.bytes).padStart(8)} | ${r.pinnedLimit}`);
    }
    if (timingResult) {
      console.log(`\nHDFC Statement Timing (${timingResult.rowCount} rows):`);
      console.log(`  Parse: ${timingResult.parseMs}ms`);
      console.log(`  Match: ${timingResult.matchMs}ms`);
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
              session: { shop: TEST_SHOP_DOMAIN, accessToken: "test-token" },
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
  ): Promise<{ queryCount: number; responseSize: number; data: unknown }> {
    spy.reset();
    const result = await loaderFn(args);

    let data: unknown = result;
    if (typeof result === "object" && result !== null && "data" in result) {
      data = (result as { data: unknown }).data;
    }

    if (typeof data === "object" && data !== null && "dashboardData" in data) {
      const dd = data as { dashboardData: Promise<unknown> };
      if (dd.dashboardData && typeof dd.dashboardData.then === "function") {
        const resolved = await dd.dashboardData;
        data = { ...data as object, ...resolved as object };
      }
    }

    const responseSize = JSON.stringify(data).length;
    return { queryCount: spy.getQueryCount(), responseSize, data };
  }

  describe("QUERY COUNTS: dashboard (app._index)", () => {
    const PINNED_BOUND = 12;
    const RESPONSE_SIZE_LIMIT = 25000;

    beforeEach(async () => {
      await cleanupData();
    });

    it("query count is constant at SMALL and FULL size (N+1 detection)", async () => {
      vi.resetModules();
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => spy.sql,
        getRequestWaitUntil: () => undefined,
      }));

      const { loader } = await import("~/routes/app._index");

      // Seed SMALL (5 buyers visible on page 1)
      const smallData = generateAllData(smallConfig);
      await seedData(smallConfig, smallData);

      const smallResult = await measureLoader(
        loader as (args: unknown) => Promise<unknown>,
        createLoaderArgs("/app", { skipOnboarding: "true" })
      );

      await cleanupData();

      // Seed FULL (only 20 buyers visible on page 1 due to pagination)
      const fullData = generateAllData(fullConfig);
      await seedData(fullConfig, fullData);

      const fullResult = await measureLoader(
        loader as (args: unknown) => Promise<unknown>,
        createLoaderArgs("/app", { skipOnboarding: "true" })
      );

      queryCountResults.push({
        route: "app._index",
        smallCount: smallResult.queryCount,
        fullCount: fullResult.queryCount,
        pinnedBound: PINNED_BOUND,
      });

      responseSizeResults.push({
        route: "app._index",
        bytes: fullResult.responseSize,
        pinnedLimit: RESPONSE_SIZE_LIMIT,
      });

      // N+1 check: count must be same at small and full
      expect(fullResult.queryCount).toBe(smallResult.queryCount);
      // Pinned bound check
      expect(fullResult.queryCount).toBeLessThanOrEqual(PINNED_BOUND);
      // Response size check
      expect(fullResult.responseSize).toBeLessThan(RESPONSE_SIZE_LIMIT);
    });

    it("buyer ledger returns exactly 20 rows when data exceeds page size", async () => {
      vi.resetModules();
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => spy.sql,
        getRequestWaitUntil: () => undefined,
      }));

      const { loader } = await import("~/routes/app._index");
      const fullData = generateAllData(fullConfig);
      await seedData(fullConfig, fullData);

      const result = await measureLoader(
        loader as (args: unknown) => Promise<unknown>,
        createLoaderArgs("/app", { skipOnboarding: "true" })
      );

      const data = result.data as {
        buyerLedger: { rows: unknown[]; totalCount: number } | null;
        pagination: { page: number; pageSize: number; totalCount: number };
      };

      expect(data.buyerLedger).not.toBeNull();
      expect(data.buyerLedger!.rows.length).toBe(20);
      expect(data.pagination).toMatchObject({
        page: 1,
        pageSize: 20,
      });
      expect(data.pagination.totalCount).toBeGreaterThan(20);
    });
  });

  describe("QUERY COUNTS: accounts.$id", () => {
    const PINNED_BOUND = 10;
    const RESPONSE_SIZE_LIMIT = 15000;
    let testAccountId: string;
    let manyInvoicesBuyerId: string;

    beforeEach(async () => {
      await cleanupData();
    });

    it("query count is constant at SMALL and FULL size (N+1 detection)", async () => {
      vi.resetModules();
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => spy.sql,
        getRequestWaitUntil: () => undefined,
      }));

      const { loader } = await import("~/routes/app.accounts.$id");

      // Seed SMALL
      const smallData = generateAllData(smallConfig);
      await seedData(smallConfig, smallData);
      testAccountId = smallData.buyers[0].id;

      const smallResult = await measureLoader(
        loader as (args: unknown) => Promise<unknown>,
        createLoaderArgs(`/app/accounts/${testAccountId}`, { id: testAccountId })
      );

      await cleanupData();

      // Seed FULL
      const fullData = generateAllData(fullConfig);
      await seedData(fullConfig, fullData);
      testAccountId = fullData.buyers[0].id;

      const fullResult = await measureLoader(
        loader as (args: unknown) => Promise<unknown>,
        createLoaderArgs(`/app/accounts/${testAccountId}`, { id: testAccountId })
      );

      queryCountResults.push({
        route: "app.accounts.$id",
        smallCount: smallResult.queryCount,
        fullCount: fullResult.queryCount,
        pinnedBound: PINNED_BOUND,
      });

      responseSizeResults.push({
        route: "app.accounts.$id",
        bytes: fullResult.responseSize,
        pinnedLimit: RESPONSE_SIZE_LIMIT,
      });

      expect(fullResult.queryCount).toBe(smallResult.queryCount);
      expect(fullResult.queryCount).toBeLessThanOrEqual(PINNED_BOUND);
      expect(fullResult.responseSize).toBeLessThan(RESPONSE_SIZE_LIMIT);
    });

    it("invoices are capped at 10 rows for buyer with >10 invoices", async () => {
      vi.resetModules();
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => spy.sql,
        getRequestWaitUntil: () => undefined,
      }));

      const { loader } = await import("~/routes/app.accounts.$id");

      // Seed a buyer with many invoices
      await seedShop();
      manyInvoicesBuyerId = `buyer-many-inv-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "customerId", name, "holdState", "createdAt", "updatedAt"
        ) VALUES (
          ${manyInvoicesBuyerId}, ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER',
          ${"cust-many-" + TEST_SUFFIX}, 'Buyer With Many Invoices', 'OK', NOW(), NOW()
        )
      `;

      // Create 15 invoices for this buyer
      const invoiceValues = Array.from({ length: 15 }, (_, i) => ({
        id: `inv-many-${TEST_SUFFIX}-${i}`,
        shopId: TEST_SHOP_ID,
        buyerAccountId: manyInvoicesBuyerId,
        orderId: `order-many-${TEST_SUFFIX}-${i}`,
        name: `#MANY-${i}`,
        total: 1000 + i * 100,
        outstanding: 500 + i * 50,
        issuedAt: new Date().toISOString(),
        dueAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        dueSource: "schedule",
        status: "open",
      }));

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          "issuedAt", "dueAt", "dueSource", status, "createdAt", "updatedAt"
        )
        SELECT
          r.id, r."shopId", r."buyerAccountId", r."orderId", r.name,
          r.total::decimal(14,2), r.outstanding::decimal(14,2), r."issuedAt"::timestamptz,
          r."dueAt"::timestamptz, r."dueSource"::"DueSource", r.status::"InvoiceStatus",
          NOW(), NOW()
        FROM jsonb_to_recordset(${sql.json(invoiceValues)}) AS r(
          id text, "shopId" text, "buyerAccountId" text, "orderId" text, name text,
          total numeric, outstanding numeric, "issuedAt" text, "dueAt" text,
          "dueSource" text, status text
        )
      `;

      const result = await measureLoader(
        loader as (args: unknown) => Promise<unknown>,
        createLoaderArgs(`/app/accounts/${manyInvoicesBuyerId}`, { id: manyInvoicesBuyerId })
      );

      const data = result.data as { invoices: { rows: unknown[]; totalCount: number } };
      expect(data.invoices.rows.length).toBe(10);
      expect(data.invoices.totalCount).toBe(15);
    });
  });

  describe("QUERY COUNTS: reconcile", () => {
    const PINNED_BOUND = 12;
    const RESPONSE_SIZE_LIMIT = 20000;

    beforeEach(async () => {
      await cleanupData();
    });

    it("query count is constant at SMALL and FULL size (N+1 detection)", async () => {
      vi.resetModules();
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => spy.sql,
        getRequestWaitUntil: () => undefined,
      }));

      const { loader } = await import("~/routes/app.reconcile");

      // Seed SMALL
      const smallData = generateAllData(smallConfig);
      await seedData(smallConfig, smallData);

      const smallResult = await measureLoader(
        loader as (args: unknown) => Promise<unknown>,
        createLoaderArgs("/app/reconcile", { view: "suggested" })
      );

      await cleanupData();

      // Seed FULL
      const fullData = generateAllData(fullConfig);
      await seedData(fullConfig, fullData);

      const fullResult = await measureLoader(
        loader as (args: unknown) => Promise<unknown>,
        createLoaderArgs("/app/reconcile", { view: "suggested" })
      );

      queryCountResults.push({
        route: "app.reconcile",
        smallCount: smallResult.queryCount,
        fullCount: fullResult.queryCount,
        pinnedBound: PINNED_BOUND,
      });

      responseSizeResults.push({
        route: "app.reconcile",
        bytes: fullResult.responseSize,
        pinnedLimit: RESPONSE_SIZE_LIMIT,
      });

      expect(fullResult.queryCount).toBe(smallResult.queryCount);
      expect(fullResult.queryCount).toBeLessThanOrEqual(PINNED_BOUND);
      expect(fullResult.responseSize).toBeLessThan(RESPONSE_SIZE_LIMIT);
    });

    it("matches are paginated at exactly 20 rows", async () => {
      vi.resetModules();
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => spy.sql,
        getRequestWaitUntil: () => undefined,
      }));

      const { loader } = await import("~/routes/app.reconcile");
      const fullData = generateAllData(fullConfig);
      await seedData(fullConfig, fullData);

      const result = await measureLoader(
        loader as (args: unknown) => Promise<unknown>,
        createLoaderArgs("/app/reconcile", { view: "suggested" })
      );

      const data = result.data as {
        matches: unknown[];
        pagination: { page: number; pageSize: number; totalCount: number };
      };

      expect(data.matches.length).toBe(20);
      expect(data.pagination.totalCount).toBeGreaterThan(20);
      expect(data.pagination.pageSize).toBe(20);
      expect(data.pagination.page).toBe(1);
    });
  });

  describe("QUERY COUNTS: imports", () => {
    const PINNED_BOUND = 3;
    const RESPONSE_SIZE_LIMIT = 2000;

    beforeEach(async () => {
      await cleanupData();
    });

    it("query count is constant at SMALL and FULL size (N+1 detection)", async () => {
      vi.resetModules();
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => spy.sql,
        getRequestWaitUntil: () => undefined,
      }));

      const { loader } = await import("~/routes/app.imports");

      // Seed SMALL
      const smallData = generateAllData(smallConfig);
      await seedData(smallConfig, smallData);

      const smallResult = await measureLoader(
        loader as (args: unknown) => Promise<unknown>,
        createLoaderArgs("/app/imports")
      );

      await cleanupData();

      // Seed FULL
      const fullData = generateAllData(fullConfig);
      await seedData(fullConfig, fullData);

      const fullResult = await measureLoader(
        loader as (args: unknown) => Promise<unknown>,
        createLoaderArgs("/app/imports")
      );

      queryCountResults.push({
        route: "app.imports",
        smallCount: smallResult.queryCount,
        fullCount: fullResult.queryCount,
        pinnedBound: PINNED_BOUND,
      });

      responseSizeResults.push({
        route: "app.imports",
        bytes: fullResult.responseSize,
        pinnedLimit: RESPONSE_SIZE_LIMIT,
      });

      expect(fullResult.queryCount).toBe(smallResult.queryCount);
      expect(fullResult.queryCount).toBeLessThanOrEqual(PINNED_BOUND);
      expect(fullResult.responseSize).toBeLessThan(RESPONSE_SIZE_LIMIT);
    });
  });

  describe("QUERY COUNTS: data-requests", () => {
    const PINNED_BOUND = 4;
    const RESPONSE_SIZE_LIMIT = 5000;

    beforeEach(async () => {
      await cleanupData();
    });

    it("query count is constant at SMALL and FULL size (N+1 detection)", async () => {
      vi.resetModules();
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => spy.sql,
        getRequestWaitUntil: () => undefined,
      }));

      const { loader } = await import("~/routes/app.data-requests");

      // Seed SMALL with data requests
      const smallData = generateAllData(smallConfig);
      await seedData(smallConfig, smallData);

      // Add some data requests
      await sql`
        INSERT INTO s22_data_requests (id, shop_id, customer_gid, request_id, status, created_at)
        VALUES
          (${"dr-small-1-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, 'gid://shopify/Customer/1', 'req-1', 'pending', NOW()),
          (${"dr-small-2-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, 'gid://shopify/Customer/2', 'req-2', 'pending', NOW())
      `;

      const smallResult = await measureLoader(
        loader as (args: unknown) => Promise<unknown>,
        createLoaderArgs("/app/data-requests")
      );

      await cleanupData();

      // Seed FULL with more data requests
      const fullData = generateAllData(fullConfig);
      await seedData(fullConfig, fullData);

      // Add more data requests for FULL size
      const drValues = Array.from({ length: 20 }, (_, i) => ({
        id: `dr-full-${i}-${TEST_SUFFIX}`,
        shopId: TEST_SHOP_ID,
        customerGid: `gid://shopify/Customer/${1000 + i}`,
        requestId: `req-full-${i}`,
        status: "pending",
      }));

      await sql`
        INSERT INTO s22_data_requests (id, shop_id, customer_gid, request_id, status, created_at)
        SELECT r.id, r."shopId", r."customerGid", r."requestId", r.status, NOW()
        FROM jsonb_to_recordset(${sql.json(drValues)}) AS r(
          id text, "shopId" text, "customerGid" text, "requestId" text, status text
        )
      `;

      const fullResult = await measureLoader(
        loader as (args: unknown) => Promise<unknown>,
        createLoaderArgs("/app/data-requests")
      );

      queryCountResults.push({
        route: "app.data-requests",
        smallCount: smallResult.queryCount,
        fullCount: fullResult.queryCount,
        pinnedBound: PINNED_BOUND,
      });

      responseSizeResults.push({
        route: "app.data-requests",
        bytes: fullResult.responseSize,
        pinnedLimit: RESPONSE_SIZE_LIMIT,
      });

      expect(fullResult.queryCount).toBe(smallResult.queryCount);
      expect(fullResult.queryCount).toBeLessThanOrEqual(PINNED_BOUND);
      expect(fullResult.responseSize).toBeLessThan(RESPONSE_SIZE_LIMIT);
    });
  });

  describe("TIMINGS: HDFC statement parse and match", () => {
    beforeEach(async () => {
      await cleanupData();
    });

    it("times 2000-row HDFC statement with real parser and matcher", async () => {
      // Generate synthetic HDFC statement rows
      const hdfcRows = generateSyntheticHdfcStatement(2000);

      // Convert to CSV format that HDFC parser expects
      const csvHeader = "Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance";
      const csvRows = hdfcRows.map((row) =>
        `${row.date},${row.narration},${row.chqRefNo},${row.valueDate},${row.withdrawal},${row.deposit},${row.closingBalance}`
      );
      const csvContent = [csvHeader, ...csvRows].join("\n");
      const csvBuffer = new TextEncoder().encode(csvContent).buffer;

      // Time REAL HDFC parsing
      const { parseBankStatement } = await import("~/lib/banks");

      const parseStart = performance.now();
      const parseResult = await parseBankStatement(csvBuffer, { fileName: "hdfc-test.csv" });
      const parseMs = Math.round(performance.now() - parseStart);

      expect(parseResult.detection.bank).toBe("HDFC");
      expect(parseResult.transactions.length).toBeGreaterThan(0);

      // Seed shop for matching
      await seedShop();
      const fullData = generateAllData(fullConfig);
      await seedData(fullConfig, fullData);

      // Time REAL matcher
      vi.resetModules();
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      const { runMatcher } = await import("~/services/matcher.server");

      const matchStart = performance.now();
      const matchResult = await runMatcher(sql, TEST_SHOP_ID, { limit: 10 });
      const matchMs = Math.round(performance.now() - matchStart);

      timingResult = {
        parseMs,
        matchMs,
        rowCount: hdfcRows.length,
      };

      expect(parseResult.transactions.length).toBeGreaterThan(1900);
      expect(matchResult).toBeDefined();
    });
  });
});
