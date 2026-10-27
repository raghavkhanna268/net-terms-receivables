/**
 * Cross-shop (tenant) isolation test suite.
 *
 * Tests that authenticated shop A CANNOT read, write, or infer data belonging to shop B.
 * Uses the real route loaders and actions with mocked auth (Shopify session returns shop A).
 *
 * For every admin and public route:
 * 1. Call it with B's internal IDs in route params, form fields, and query strings
 * 2. Assert no B data leaks in response (deep scan for marker strings and row IDs)
 * 3. Assert no writes to B's rows (stable hash before/after)
 * 4. Assert correct status (404, 403, or route-specific no-op)
 *
 * Uses the repo's describeWithDb / TEST_DATABASE_URL pattern.
 * All data is FICTIONAL - no real customer or bank data.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from "vitest";
import postgres from "postgres";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { sqlOptions } from "../../app/lib/db-light.server.js";
import { assertNoQueueLeftovers } from "../helpers/queue-leftovers.js";
import { buildGid } from "../helpers/gid.js";
import { generateUnsubscribeToken } from "../../app/services/reminder-unsubscribe-token.server.js";

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

vi.mock("../../app/services/matcher.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/matcher.server")>();
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

vi.mock("../../app/lib/recompute-enqueue.server", () => ({
  enqueueCreditStatusRecompute: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../app/services/credit-status-recompute.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    enqueueRecomputeForInvoice: vi.fn().mockResolvedValue(undefined),
  };
});

type RouteExpectation = {
  status: 404 | 403 | "noop";
  reason: string;
  hasLoader?: boolean;
  hasAction?: boolean;
  loaderParams?: Record<string, string>;
  actionParams?: Record<string, string>;
  actionFormData?: Record<string, string>;
  queryParams?: Record<string, string>;
};

const ROUTE_EXCLUSIONS: Record<string, string> = {
  "app.tsx": "Layout wrapper, no record IDs, no loader/action that access data",
  "app.onboarding.tsx": "Setup flow, no record IDs, shop-scoped by session only",
  "app.welcome.tsx": "Welcome redirect, no record IDs",
  "api.web-vitals.tsx": "Performance metrics endpoint, no tenant data",
  "auth.$.tsx": "Auth redirect, no tenant data",
  "jobs.drain.tsx": "Internal job processor, not accessible via HTTP params",
  "privacy.tsx": "Static privacy policy page, no tenant data",
  "webhooks.app.scopes_update.tsx": "Shopify webhook, authenticated by Shopify HMAC, not admin session",
  "webhooks.app.subscriptions_update.tsx": "Shopify webhook, authenticated by Shopify HMAC, not admin session",
  "webhooks.app.uninstalled.tsx": "Shopify webhook, authenticated by Shopify HMAC, not admin session",
  "webhooks.bulk_operations.finish.tsx": "Shopify webhook, authenticated by Shopify HMAC, not admin session",
  "webhooks.companies.tsx": "Shopify webhook, authenticated by Shopify HMAC, not admin session",
  "webhooks.company_locations.tsx": "Shopify webhook, authenticated by Shopify HMAC, not admin session",
  "webhooks.compliance.tsx": "Shopify webhook, authenticated by Shopify HMAC, not admin session",
  "webhooks.customers.tsx": "Shopify webhook, authenticated by Shopify HMAC, not admin session",
  "webhooks.draft_orders.tsx": "Shopify webhook, authenticated by Shopify HMAC, not admin session",
  "webhooks.orders.tsx": "Shopify webhook, authenticated by Shopify HMAC, not admin session",
  "webhooks.shop.update.tsx": "Shopify webhook, authenticated by Shopify HMAC, not admin session",
};

describeWithDb("Cross-shop (tenant) isolation suite", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-iso";

  const SHOP_A_ID = `shop-a-${TEST_SUFFIX}`;
  const SHOP_A_DOMAIN = `test-iso-a-${TEST_SUFFIX}.myshopify.com`;

  const SHOP_B_ID = `shop-b-${TEST_SUFFIX}`;
  const SHOP_B_DOMAIN = `test-iso-b-${TEST_SUFFIX}.myshopify.com`;

  const ISO_B_MARKER = `ISO_B_MARKER_${TEST_SUFFIX}`;

  const BUYER_A_ID = `buyer-a-${TEST_SUFFIX}`;
  const BUYER_B_ID = `buyer-b-${TEST_SUFFIX}`;
  const BUYER_B_OPTOUT_ID = `buyer-b-optout-${TEST_SUFFIX}`;

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

  const TAG_RULE_A_ID = `tag-a-${TEST_SUFFIX}`;
  const TAG_RULE_B_ID = `tag-b-${TEST_SUFFIX}`;

  const UNSUBSCRIBE_SECRET = "test-unsubscribe-secret-for-isolation-tests";

  const SHOP_A_BUYER_NAME = "Shop A Buyer LLC";
  const SHOP_B_BUYER_NAME = `${ISO_B_MARKER}_BUYER_NAME`;
  const SHOP_B_BUYER_OPTOUT_NAME = `${ISO_B_MARKER}_OPTOUT_BUYER`;
  const SHOP_B_INVOICE_AMOUNT = "99999.99";
  const SHOP_B_PAYMENT_AMOUNT = "88888.88";
  const SHOP_B_PAYMENT_NARRATION = `${ISO_B_MARKER}_NARRATION`;
  const SHOP_B_TAG_RULE_TAG = `${ISO_B_MARKER}_TAG`;
  const SHOP_B_IMPORT_FILENAME = `${ISO_B_MARKER}_import.csv`;

  const B_MARKERS = [
    ISO_B_MARKER,
    SHOP_B_ID,
    BUYER_B_ID,
    BUYER_B_OPTOUT_ID,
    INVOICE_B_ID,
    PAYMENT_B_ID,
    MATCH_B_ID,
    IMPORT_B_ID,
    DATA_REQUEST_B_ID,
    REMINDER_RULE_B_ID,
    TAG_RULE_B_ID,
    SHOP_B_BUYER_NAME,
    SHOP_B_BUYER_OPTOUT_NAME,
    SHOP_B_INVOICE_AMOUNT,
    SHOP_B_PAYMENT_AMOUNT,
    SHOP_B_PAYMENT_NARRATION,
    SHOP_B_TAG_RULE_TAG,
    SHOP_B_IMPORT_FILENAME,
    "cust-b-1",
    "req-b-id",
  ];

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
        env: {
          RESEND_API_KEY: undefined,
          RESEND_FROM: undefined,
          REMINDER_UNSUBSCRIBE_SECRET: UNSUBSCRIBE_SECRET,
          REMINDER_UNSUBSCRIBE_SECRET_PREVIOUS: undefined,
        },
        ctx: { waitUntil: vi.fn() },
      },
    };
  }

  function createPublicContext() {
    return {
      cloudflare: {
        env: {
          REMINDER_UNSUBSCRIBE_SECRET: UNSUBSCRIBE_SECRET,
          REMINDER_UNSUBSCRIBE_SECRET_PREVIOUS: undefined,
        },
        ctx: { waitUntil: vi.fn() },
      },
    };
  }

  function createLoaderArgs(
    urlPath: string,
    params: Record<string, string> = {},
    shopDomain = SHOP_A_DOMAIN,
    queryParams: Record<string, string> = {}
  ) {
    const url = new URL(`https://example.com${urlPath}`);
    for (const [key, value] of Object.entries(queryParams)) {
      url.searchParams.set(key, value);
    }
    return {
      request: new Request(url),
      context: createMockContext(shopDomain),
      params,
      url,
      pattern: urlPath.replace(/\/[^/]+$/, "/:id"),
    } as unknown;
  }

  function createActionArgs(
    urlPath: string,
    formData: Record<string, string>,
    params: Record<string, string> = {},
    shopDomain = SHOP_A_DOMAIN
  ) {
    const url = new URL(`https://example.com${urlPath}`);
    const body = new FormData();
    for (const [key, value] of Object.entries(formData)) {
      body.append(key, value);
    }
    return {
      request: new Request(url, { method: "POST", body }),
      context: createMockContext(shopDomain),
      params,
      url,
      pattern: urlPath.replace(/\/[^/]+$/, "/:id"),
    } as unknown;
  }

  function createPublicLoaderArgs(urlPath: string, queryParams: Record<string, string> = {}) {
    const url = new URL(`https://example.com${urlPath}`);
    for (const [key, value] of Object.entries(queryParams)) {
      url.searchParams.set(key, value);
    }
    return {
      request: new Request(url),
      context: createPublicContext(),
      params: {},
      url,
      pattern: urlPath,
    } as unknown;
  }

  function createPublicActionArgs(urlPath: string, formData: Record<string, string>, queryParams: Record<string, string> = {}) {
    const url = new URL(`https://example.com${urlPath}`);
    for (const [key, value] of Object.entries(queryParams)) {
      url.searchParams.set(key, value);
    }
    const body = new FormData();
    for (const [key, value] of Object.entries(formData)) {
      body.append(key, value);
    }
    return {
      request: new Request(url, { method: "POST", body }),
      context: createPublicContext(),
      params: {},
      url,
      pattern: urlPath,
    } as unknown;
  }

  function containsAnyMarker(data: unknown): { found: boolean; marker?: string } {
    const str = typeof data === "string" ? data : JSON.stringify(data);
    for (const marker of B_MARKERS) {
      if (str.includes(marker)) {
        return { found: true, marker };
      }
    }
    return { found: false };
  }

  async function hashBRows(): Promise<string> {
    const tables = [
      { name: "Shop", id: SHOP_B_ID },
      { name: "BuyerAccount", id: BUYER_B_ID },
      { name: "BuyerAccount", id: BUYER_B_OPTOUT_ID },
      { name: "Invoice", id: INVOICE_B_ID },
      { name: "Payment", id: PAYMENT_B_ID },
      { name: "Match", id: MATCH_B_ID },
      { name: "BankImport", id: IMPORT_B_ID },
      { name: "ReminderRule", id: REMINDER_RULE_B_ID },
      { name: "s22_data_requests", id: DATA_REQUEST_B_ID },
      { name: "AccountSource", id: TAG_RULE_B_ID },
    ];

    const hashes: string[] = [];
    for (const table of tables) {
      const rows = await sql.unsafe(
        `SELECT * FROM "${table.name}" WHERE id = $1 ORDER BY id`,
        [table.id]
      );
      const rowStr = JSON.stringify(rows);
      hashes.push(crypto.createHash("sha256").update(rowStr).digest("hex"));
    }
    return crypto.createHash("sha256").update(hashes.join(":")).digest("hex");
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, "createdAt", "updatedAt")
      VALUES
        (${SHOP_A_ID}, ${SHOP_A_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW()),
        (${SHOP_B_ID}, ${SHOP_B_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
    `;

    const companyAGid = buildGid("Company", `co-a-${TEST_SUFFIX}`);
    const companyLocAGid = buildGid("CompanyLocation", `loc-a-${TEST_SUFFIX}`);
    const companyBGid = buildGid("Company", `co-b-${TEST_SUFFIX}`);
    const companyLocBGid = buildGid("CompanyLocation", `loc-b-${TEST_SUFFIX}`);
    const companyBOptoutGid = buildGid("Company", `co-b-optout-${TEST_SUFFIX}`);
    const companyLocBOptoutGid = buildGid("CompanyLocation", `loc-b-optout-${TEST_SUFFIX}`);

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "syncPending",
        "reminderOptOutAt", "reminderOptOutSource",
        "createdAt", "updatedAt"
      )
      VALUES
        (${BUYER_A_ID}, ${SHOP_A_ID}, 'COMPANY', ${companyAGid}, ${companyLocAGid}, ${SHOP_A_BUYER_NAME}, 50000.00, 'OK', false, false, NULL, NULL, NOW(), NOW()),
        (${BUYER_B_ID}, ${SHOP_B_ID}, 'COMPANY', ${companyBGid}, ${companyLocBGid}, ${SHOP_B_BUYER_NAME}, 75000.00, 'OK', false, false, NOW(), 'merchant'::"ReminderOptOutSource", NOW(), NOW()),
        (${BUYER_B_OPTOUT_ID}, ${SHOP_B_ID}, 'COMPANY', ${companyBOptoutGid}, ${companyLocBOptoutGid}, ${SHOP_B_BUYER_OPTOUT_NAME}, 60000.00, 'OK', false, false, NULL, NULL, NOW(), NOW())
    `;

    const orderAGid = buildGid("Order", `order-a-${TEST_SUFFIX}`);
    const orderBGid = buildGid("Order", `order-b-${TEST_SUFFIX}`);

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", name, "orderId",
        total, outstanding, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES
        (${INVOICE_A_ID}, ${SHOP_A_ID}, ${BUYER_A_ID}, 'INV-A-001', ${orderAGid}, 10000.00, 10000.00, NOW(), NOW() + interval '30 days', NOW(), NOW()),
        (${INVOICE_B_ID}, ${SHOP_B_ID}, ${BUYER_B_ID}, 'INV-B-001', ${orderBGid}, ${SHOP_B_INVOICE_AMOUNT}, ${SHOP_B_INVOICE_AMOUNT}, NOW(), NOW() + interval '30 days', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
      VALUES
        (${IMPORT_A_ID}, ${SHOP_A_ID}, 'hdfc', 'shop-a-import.csv', 5, NOW()),
        (${IMPORT_B_ID}, ${SHOP_B_ID}, 'hdfc', ${SHOP_B_IMPORT_FILENAME}, 10, NOW())
    `;

    await sql`
      INSERT INTO "Payment" (
        id, "shopId", "importId", amount, utr, status, rail, narration, "valueDate", "createdAt", "updatedAt"
      )
      VALUES
        (${PAYMENT_A_ID}, ${SHOP_A_ID}, ${IMPORT_A_ID}, 10000.00, ${"UTR-A-" + TEST_SUFFIX}, 'unmatched', 'NEFT', 'Payment A narration', NOW(), NOW(), NOW()),
        (${PAYMENT_B_ID}, ${SHOP_B_ID}, ${IMPORT_B_ID}, ${SHOP_B_PAYMENT_AMOUNT}, ${"UTR-B-" + TEST_SUFFIX}, 'unmatched', 'NEFT', ${SHOP_B_PAYMENT_NARRATION}, NOW(), NOW(), NOW())
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

    const customerAGid = buildGid("Customer", `cust-a-1`);
    const customerBGid = buildGid("Customer", `cust-b-1`);

    await sql`
      INSERT INTO s22_data_requests (id, shop_id, customer_gid, request_id, status, received_at, expires_at, export_data)
      VALUES
        (${DATA_REQUEST_A_ID}, ${SHOP_A_ID}, ${customerAGid}, 'req-a-id', 'completed', NOW(), NOW() + interval '30 days', ${sql.json({ customerId: "cust-a-1" })}),
        (${DATA_REQUEST_B_ID}, ${SHOP_B_ID}, ${customerBGid}, 'req-b-id', 'completed', NOW(), NOW() + interval '30 days', ${sql.json({ customerId: "cust-b-1", marker: ISO_B_MARKER })})
    `;

    await sql`
      INSERT INTO "AccountSource" (id, "shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")
      VALUES
        (${TAG_RULE_A_ID}, ${SHOP_A_ID}, 'net30-a', 30, NOW(), NOW()),
        (${TAG_RULE_B_ID}, ${SHOP_B_ID}, ${SHOP_B_TAG_RULE_TAG}, 45, NOW(), NOW())
    `;

    await sql`
      INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
      VALUES
        (${SHOP_A_ID}, true, NOW(), NOW()),
        (${SHOP_B_ID}, true, NOW(), NOW())
    `;

    // Seed-sanity checks: verify expected row counts for every seeded table for both shops
    const [shopA] = await sql`SELECT COUNT(*)::int as count FROM "Shop" WHERE id = ${SHOP_A_ID}`;
    const [shopB] = await sql`SELECT COUNT(*)::int as count FROM "Shop" WHERE id = ${SHOP_B_ID}`;
    if (shopA.count !== 1) throw new Error(`Seed sanity: Shop A expected 1 row, got ${shopA.count}`);
    if (shopB.count !== 1) throw new Error(`Seed sanity: Shop B expected 1 row, got ${shopB.count}`);

    const [buyerA] = await sql`SELECT COUNT(*)::int as count FROM "BuyerAccount" WHERE "shopId" = ${SHOP_A_ID}`;
    const [buyerB] = await sql`SELECT COUNT(*)::int as count FROM "BuyerAccount" WHERE "shopId" = ${SHOP_B_ID}`;
    if (buyerA.count !== 1) throw new Error(`Seed sanity: BuyerAccount A expected 1 row, got ${buyerA.count}`);
    if (buyerB.count !== 2) throw new Error(`Seed sanity: BuyerAccount B expected 2 rows, got ${buyerB.count}`);

    const [invoiceA] = await sql`SELECT COUNT(*)::int as count FROM "Invoice" WHERE "shopId" = ${SHOP_A_ID}`;
    const [invoiceB] = await sql`SELECT COUNT(*)::int as count FROM "Invoice" WHERE "shopId" = ${SHOP_B_ID}`;
    if (invoiceA.count !== 1) throw new Error(`Seed sanity: Invoice A expected 1 row, got ${invoiceA.count}`);
    if (invoiceB.count !== 1) throw new Error(`Seed sanity: Invoice B expected 1 row, got ${invoiceB.count}`);

    const [importA] = await sql`SELECT COUNT(*)::int as count FROM "BankImport" WHERE "shopId" = ${SHOP_A_ID}`;
    const [importB] = await sql`SELECT COUNT(*)::int as count FROM "BankImport" WHERE "shopId" = ${SHOP_B_ID}`;
    if (importA.count !== 1) throw new Error(`Seed sanity: BankImport A expected 1 row, got ${importA.count}`);
    if (importB.count !== 1) throw new Error(`Seed sanity: BankImport B expected 1 row, got ${importB.count}`);

    const [paymentA] = await sql`SELECT COUNT(*)::int as count FROM "Payment" WHERE "shopId" = ${SHOP_A_ID}`;
    const [paymentB] = await sql`SELECT COUNT(*)::int as count FROM "Payment" WHERE "shopId" = ${SHOP_B_ID}`;
    if (paymentA.count !== 1) throw new Error(`Seed sanity: Payment A expected 1 row, got ${paymentA.count}`);
    if (paymentB.count !== 1) throw new Error(`Seed sanity: Payment B expected 1 row, got ${paymentB.count}`);

    const [matchA] = await sql`SELECT COUNT(*)::int as count FROM "Match" WHERE "shopId" = ${SHOP_A_ID}`;
    const [matchB] = await sql`SELECT COUNT(*)::int as count FROM "Match" WHERE "shopId" = ${SHOP_B_ID}`;
    if (matchA.count !== 1) throw new Error(`Seed sanity: Match A expected 1 row, got ${matchA.count}`);
    if (matchB.count !== 1) throw new Error(`Seed sanity: Match B expected 1 row, got ${matchB.count}`);

    const [ruleA] = await sql`SELECT COUNT(*)::int as count FROM "ReminderRule" WHERE "shopId" = ${SHOP_A_ID}`;
    const [ruleB] = await sql`SELECT COUNT(*)::int as count FROM "ReminderRule" WHERE "shopId" = ${SHOP_B_ID}`;
    if (ruleA.count !== 1) throw new Error(`Seed sanity: ReminderRule A expected 1 row, got ${ruleA.count}`);
    if (ruleB.count !== 1) throw new Error(`Seed sanity: ReminderRule B expected 1 row, got ${ruleB.count}`);

    const [dataReqA] = await sql`SELECT COUNT(*)::int as count FROM s22_data_requests WHERE shop_id = ${SHOP_A_ID}`;
    const [dataReqB] = await sql`SELECT COUNT(*)::int as count FROM s22_data_requests WHERE shop_id = ${SHOP_B_ID}`;
    if (dataReqA.count !== 1) throw new Error(`Seed sanity: s22_data_requests A expected 1 row, got ${dataReqA.count}`);
    if (dataReqB.count !== 1) throw new Error(`Seed sanity: s22_data_requests B expected 1 row, got ${dataReqB.count}`);

    const [tagA] = await sql`SELECT COUNT(*)::int as count FROM "AccountSource" WHERE "shopId" = ${SHOP_A_ID}`;
    const [tagB] = await sql`SELECT COUNT(*)::int as count FROM "AccountSource" WHERE "shopId" = ${SHOP_B_ID}`;
    if (tagA.count !== 1) throw new Error(`Seed sanity: AccountSource A expected 1 row, got ${tagA.count}`);
    if (tagB.count !== 1) throw new Error(`Seed sanity: AccountSource B expected 1 row, got ${tagB.count}`);

    const [settingsA] = await sql`SELECT COUNT(*)::int as count FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_A_ID}`;
    const [settingsB] = await sql`SELECT COUNT(*)::int as count FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_B_ID}`;
    if (settingsA.count !== 1) throw new Error(`Seed sanity: s18_shop_reminder_settings A expected 1 row, got ${settingsA.count}`);
    if (settingsB.count !== 1) throw new Error(`Seed sanity: s18_shop_reminder_settings B expected 1 row, got ${settingsB.count}`);
  });

  afterAll(async () => {
    await sql`DELETE FROM "Match" WHERE id IN (${MATCH_A_ID}, ${MATCH_B_ID})`;
    await sql`DELETE FROM "Payment" WHERE id IN (${PAYMENT_A_ID}, ${PAYMENT_B_ID})`;
    await sql`DELETE FROM "Invoice" WHERE id IN (${INVOICE_A_ID}, ${INVOICE_B_ID})`;
    await sql`DELETE FROM "BankImport" WHERE id IN (${IMPORT_A_ID}, ${IMPORT_B_ID})`;
    await sql`DELETE FROM "ReminderRule" WHERE id IN (${REMINDER_RULE_A_ID}, ${REMINDER_RULE_B_ID})`;
    await sql`DELETE FROM s22_data_requests WHERE id IN (${DATA_REQUEST_A_ID}, ${DATA_REQUEST_B_ID})`;
    await sql`DELETE FROM "AccountSource" WHERE id IN (${TAG_RULE_A_ID}, ${TAG_RULE_B_ID})`;
    await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "BuyerAccount" WHERE id IN (${BUYER_A_ID}, ${BUYER_B_ID}, ${BUYER_B_OPTOUT_ID})`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "Shop" WHERE id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;

    await assertNoQueueLeftovers(sql, [SHOP_A_DOMAIN, SHOP_B_DOMAIN], "tenant-isolation-db.test.ts");
    await sql.end();
  });

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    vi.doMock("~/lib/request-context.server", () => ({
      getRequestSql: () => sql,
      getRequestWaitUntil: () => undefined,
    }));

    await sql`UPDATE "Match" SET state = 'suggested' WHERE id IN (${MATCH_A_ID}, ${MATCH_B_ID})`;
    await sql`UPDATE "BuyerAccount" SET "reminderOptOutAt" = NULL, "reminderOptOutSource" = NULL WHERE id = ${BUYER_B_OPTOUT_ID}`;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("app.accounts.$id - buyer account isolation", () => {
    it("shop A loader cannot read shop B's buyer account (negative)", async () => {
      expect.hasAssertions();
      const hashBefore = await hashBRows();
      const args = createLoaderArgs(`/app/accounts/${BUYER_B_ID}`, { id: BUYER_B_ID });
      const { loader } = await import("../../app/routes/app.accounts.$id.js");
      const result = (await loader(args as never)) as { account: unknown; error: string | null };

      expect(result.account).toBeNull();
      expect(result.error).toBe("Account not found");

      const { found, marker } = containsAnyMarker(result);
      expect(found, `Response contains B marker: ${marker}`).toBe(false);

      const hashAfter = await hashBRows();
      expect(hashAfter).toBe(hashBefore);
    });

    it("shop A loader CAN read shop A's buyer account (positive control)", async () => {
      expect.hasAssertions();
      const args = createLoaderArgs(`/app/accounts/${BUYER_A_ID}`, { id: BUYER_A_ID });
      const { loader } = await import("../../app/routes/app.accounts.$id.js");
      const result = (await loader(args as never)) as { account: { id: string; name: string } | null; error: string | null };

      expect(result.error).toBeNull();
      expect(result.account).not.toBeNull();
      expect(result.account!.id).toBe(BUYER_A_ID);
      expect(result.account!.name).toBe(SHOP_A_BUYER_NAME);
    });

    it("shop A action cannot update shop B's buyer credit settings (negative)", async () => {
      expect.hasAssertions();
      const hashBefore = await hashBRows();
      const args = createActionArgs(
        `/app/accounts/${BUYER_B_ID}`,
        { _action: "updateCredit", creditLimit: "999999", noLimit: "false", manualHold: "true", holdReasonCode: "MANUAL_HOLD" },
        { id: BUYER_B_ID }
      );

      const { action } = await import("../../app/routes/app.accounts.$id.js");
      const result = await action(args as never);

      const r = result as { success: boolean; error?: string };
      expect(r.success).toBe(false);
      expect(r.error).toBe("Account not found");

      const hashAfter = await hashBRows();
      expect(hashAfter).toBe(hashBefore);
    });

    it("shop A action CAN update shop A's buyer credit settings (positive control)", async () => {
      expect.hasAssertions();
      const args = createActionArgs(
        `/app/accounts/${BUYER_A_ID}`,
        { _action: "updateCredit", creditLimit: "60000", noLimit: "false", manualHold: "false" },
        { id: BUYER_A_ID }
      );

      const { action } = await import("../../app/routes/app.accounts.$id.js");
      const result = await action(args as never);

      const r = result as { success: boolean; error?: string };
      expect(r.success).toBe(true);

      const afterSnapshot = await sql`SELECT "creditLimit" FROM "BuyerAccount" WHERE id = ${BUYER_A_ID}`;
      expect(parseFloat(afterSnapshot[0].creditLimit)).toBe(60000);

      await sql`UPDATE "BuyerAccount" SET "creditLimit" = 50000.00 WHERE id = ${BUYER_A_ID}`;
    });

    it("shop A action cannot update B's non-opted-out buyer reminder opt-out (negative)", async () => {
      expect.hasAssertions();
      const beforeB = await sql`SELECT "reminderOptOutAt" FROM "BuyerAccount" WHERE id = ${BUYER_B_OPTOUT_ID}`;
      expect(beforeB[0].reminderOptOutAt).toBeNull();

      const hashBefore = await hashBRows();
      const args = createActionArgs(
        `/app/accounts/${BUYER_B_OPTOUT_ID}`,
        { _action: "updateReminderOptOut", enable: "false" },
        { id: BUYER_B_OPTOUT_ID }
      );

      const { action } = await import("../../app/routes/app.accounts.$id.js");
      const result = await action(args as never);

      const r = result as { success: boolean; error?: string };
      expect(r.success).toBe(false);
      expect(r.error).toBe("Account not found");

      const afterB = await sql`SELECT "reminderOptOutAt" FROM "BuyerAccount" WHERE id = ${BUYER_B_OPTOUT_ID}`;
      expect(afterB[0].reminderOptOutAt).toBeNull();

      const hashAfter = await hashBRows();
      expect(hashAfter).toBe(hashBefore);
    });
  });

  describe("app.data-requests.$id.download - data request download isolation", () => {
    it("shop A cannot download shop B's data request export (negative)", async () => {
      expect.hasAssertions();
      const hashBefore = await hashBRows();
      const args = createLoaderArgs(`/app/data-requests/req-b-id/download`, { id: "req-b-id" });
      const mod = await import("../../app/routes/app.data-requests.$id.download.js");
      const result = await mod.loader(args as never);

      expect(result).toBeInstanceOf(Response);
      const r = result as Response;
      expect(r.status).toBe(404);

      const hashAfter = await hashBRows();
      expect(hashAfter).toBe(hashBefore);
    });

    it("shop A CAN download shop A's data request export (positive control)", async () => {
      expect.hasAssertions();
      const args = createLoaderArgs(`/app/data-requests/req-a-id/download`, { id: "req-a-id" });
      const mod = await import("../../app/routes/app.data-requests.$id.download.js");
      const result = await mod.loader(args as never);

      expect(result).toBeInstanceOf(Response);
      const r = result as Response;
      expect(r.status).toBe(200);

      const body = await r.text();
      expect(body.length).toBeGreaterThan(0);
      expect(body).toContain("cust-a-1");
    });
  });

  describe("app.reconcile - match operations isolation", () => {
    it("shop A cannot confirm shop B's match (negative)", async () => {
      expect.hasAssertions();
      const hashBefore = await hashBRows();
      const args = createActionArgs("/app/reconcile", { intent: "confirm", matchId: MATCH_B_ID });
      const { action } = await import("../../app/routes/app.reconcile.js");
      const result = (await action(args as never)) as { success: boolean };

      expect(result.success).toBe(false);

      const hashAfter = await hashBRows();
      expect(hashAfter).toBe(hashBefore);
    });

    it("shop A CAN confirm shop A's match (positive control)", async () => {
      expect.hasAssertions();
      const args = createActionArgs("/app/reconcile", { intent: "confirm", matchId: MATCH_A_ID });
      const { action } = await import("../../app/routes/app.reconcile.js");
      const result = (await action(args as never)) as { success: boolean };

      expect(result.success).toBe(true);

      const afterSnapshot = await sql`SELECT state FROM "Match" WHERE id = ${MATCH_A_ID}`;
      expect(afterSnapshot[0].state).toBe("confirmed");

      await sql`UPDATE "Match" SET state = 'suggested' WHERE id = ${MATCH_A_ID}`;
    });

    it("shop A cannot reject shop B's match (negative)", async () => {
      expect.hasAssertions();
      const hashBefore = await hashBRows();
      const args = createActionArgs("/app/reconcile", { intent: "reject", matchId: MATCH_B_ID });
      const { action } = await import("../../app/routes/app.reconcile.js");
      const result = (await action(args as never)) as { success: boolean };

      expect(result.success).toBe(false);

      const hashAfter = await hashBRows();
      expect(hashAfter).toBe(hashBefore);
    });

    it("shop A cannot apply shop B's match (negative)", async () => {
      expect.hasAssertions();
      await sql`UPDATE "Match" SET state = 'confirmed' WHERE id = ${MATCH_B_ID}`;
      const hashBefore = await hashBRows();

      const args = createActionArgs("/app/reconcile", { intent: "apply", matchId: MATCH_B_ID });
      const { action } = await import("../../app/routes/app.reconcile.js");
      const result = (await action(args as never)) as { success: boolean };

      expect(result.success).toBe(false);

      const hashAfter = await hashBRows();
      expect(hashAfter).toBe(hashBefore);

      await sql`UPDATE "Match" SET state = 'suggested' WHERE id = ${MATCH_B_ID}`;
    });

    it("shop A cannot unmatch shop B's match (negative)", async () => {
      expect.hasAssertions();
      await sql`UPDATE "Match" SET state = 'confirmed' WHERE id = ${MATCH_B_ID}`;
      const hashBefore = await hashBRows();

      const args = createActionArgs("/app/reconcile", { intent: "unmatch", matchId: MATCH_B_ID });
      const { action } = await import("../../app/routes/app.reconcile.js");
      const result = (await action(args as never)) as { success: boolean };

      expect(result.success).toBe(false);

      const hashAfter = await hashBRows();
      expect(hashAfter).toBe(hashBefore);

      await sql`UPDATE "Match" SET state = 'suggested' WHERE id = ${MATCH_B_ID}`;
    });

    it("shop A loader cannot access shop B's payment via ?payment param (negative)", async () => {
      expect.hasAssertions();
      const hashBefore = await hashBRows();
      const url = new URL(`https://example.com/app/reconcile?payment=${PAYMENT_B_ID}`);
      const args = {
        request: new Request(url),
        context: createMockContext(SHOP_A_DOMAIN),
        params: {},
        url,
        pattern: "/app/reconcile",
      } as unknown;

      const { loader } = await import("../../app/routes/app.reconcile.js");
      const result = (await loader(args as never)) as { selectedPayment: unknown };

      expect(result.selectedPayment).toBeNull();

      const { found, marker } = containsAnyMarker(result);
      expect(found, `Response contains B marker: ${marker}`).toBe(false);

      const hashAfter = await hashBRows();
      expect(hashAfter).toBe(hashBefore);
    });

    it("shop A loader CAN access shop A's payment via ?payment param (positive control)", async () => {
      expect.hasAssertions();
      const url = new URL(`https://example.com/app/reconcile?payment=${PAYMENT_A_ID}`);
      const args = {
        request: new Request(url),
        context: createMockContext(SHOP_A_DOMAIN),
        params: {},
        url,
        pattern: "/app/reconcile",
      } as unknown;

      const { loader } = await import("../../app/routes/app.reconcile.js");
      const result = (await loader(args as never)) as { selectedPayment: { payment: { id: string } } | null };

      expect(result.selectedPayment).not.toBeNull();
      expect(result.selectedPayment!.payment.id).toBe(PAYMENT_A_ID);
    });

    it("shop A reconcile loader returns A's matches, not B's (positive control)", async () => {
      expect.hasAssertions();
      const args = createLoaderArgs("/app/reconcile");

      const { loader } = await import("../../app/routes/app.reconcile.js");
      const result = await loader(args as never);

      const str = JSON.stringify(result);
      expect(str).toContain(MATCH_A_ID);
      expect(str).not.toContain(MATCH_B_ID);
      expect(str).not.toContain(SHOP_B_PAYMENT_AMOUNT);
    });
  });

  describe("app.settings.reminders - reminder rule isolation", () => {
    it("shop A cannot update shop B's reminder rule (negative)", async () => {
      expect.hasAssertions();
      const hashBefore = await hashBRows();
      const args = createActionArgs("/app/settings/reminders", {
        intent: "update_rule",
        ruleId: REMINDER_RULE_B_ID,
        offsetDays: "14",
        enabled: "false",
      });

      const { action } = await import("../../app/routes/app.settings.reminders.js");
      const result = (await action(args as never)) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Rule not found");

      const hashAfter = await hashBRows();
      expect(hashAfter).toBe(hashBefore);
    });

    it("shop A CAN update shop A's reminder rule (positive control)", async () => {
      expect.hasAssertions();
      const args = createActionArgs("/app/settings/reminders", {
        intent: "update_rule",
        ruleId: REMINDER_RULE_A_ID,
        offsetDays: "-7",
        enabled: "false",
      });

      const { action } = await import("../../app/routes/app.settings.reminders.js");
      const result = (await action(args as never)) as { success: boolean };

      expect(result.success).toBe(true);

      const afterSnapshot = await sql`SELECT enabled FROM "ReminderRule" WHERE id = ${REMINDER_RULE_A_ID}`;
      expect(afterSnapshot[0].enabled).toBe(false);

      await sql`UPDATE "ReminderRule" SET enabled = true WHERE id = ${REMINDER_RULE_A_ID}`;
    });

    it("shop A cannot delete shop B's reminder rule (negative)", async () => {
      expect.hasAssertions();
      const hashBefore = await hashBRows();
      const args = createActionArgs("/app/settings/reminders", {
        intent: "delete_rule",
        ruleId: REMINDER_RULE_B_ID,
      });

      const { action } = await import("../../app/routes/app.settings.reminders.js");
      const result = (await action(args as never)) as { success: boolean };

      expect(result.success).toBe(false);

      const hashAfter = await hashBRows();
      expect(hashAfter).toBe(hashBefore);
    });
  });

  describe("app._index - dashboard isolation", () => {
    it("shop A loader cannot access shop B's buyer via ?buyer param (negative)", async () => {
      expect.hasAssertions();
      const hashBefore = await hashBRows();
      const url = new URL(`https://example.com/app?skipOnboarding=true&buyer=${BUYER_B_ID}`);
      const args = {
        request: new Request(url),
        context: createMockContext(SHOP_A_DOMAIN),
        params: {},
        url,
        pattern: "/app",
      } as unknown;

      const { loader } = await import("../../app/routes/app._index.js");
      const rawResult = await loader(args as never);
      const result = extractLoaderResult<{
        dashboardData: Promise<{
          selectedBuyerInvoices: { rows: unknown[]; totalCount: number; buyerName: string } | null;
        }> | null;
      }>(rawResult);

      expect(result.dashboardData).toBeTruthy();
      const resolved = await result.dashboardData!;
      if (resolved.selectedBuyerInvoices === null) {
        expect(resolved.selectedBuyerInvoices).toBeNull();
      } else {
        expect(resolved.selectedBuyerInvoices.rows).toHaveLength(0);
        expect(resolved.selectedBuyerInvoices.buyerName).toBe("Unknown Buyer");
      }
      const { found, marker } = containsAnyMarker(resolved);
      expect(found, `Response contains B marker: ${marker}`).toBe(false);

      const hashAfter = await hashBRows();
      expect(hashAfter).toBe(hashBefore);
    });

    it("shop A loader CAN access shop A's buyer via ?buyer param (positive control)", async () => {
      expect.hasAssertions();
      const url = new URL(`https://example.com/app?skipOnboarding=true&buyer=${BUYER_A_ID}`);
      const args = {
        request: new Request(url),
        context: createMockContext(SHOP_A_DOMAIN),
        params: {},
        url,
        pattern: "/app",
      } as unknown;

      const { loader } = await import("../../app/routes/app._index.js");
      const rawResult = await loader(args as never);
      const result = extractLoaderResult<{
        dashboardData: Promise<{ selectedBuyerInvoices: { buyerName: string } | null }> | null;
      }>(rawResult);

      expect(result.dashboardData).toBeTruthy();
      const resolved = await result.dashboardData!;
      expect(resolved.selectedBuyerInvoices).not.toBeNull();
      expect(resolved.selectedBuyerInvoices!.buyerName).toBe(SHOP_A_BUYER_NAME);
    });

    it("shop A dashboard data contains A's data, not B's (positive control)", async () => {
      expect.hasAssertions();
      const url = new URL("https://example.com/app?skipOnboarding=true");
      const args = {
        request: new Request(url),
        context: createMockContext(SHOP_A_DOMAIN),
        params: {},
        url,
        pattern: "/app",
      } as unknown;

      const { loader } = await import("../../app/routes/app._index.js");
      const rawResult = await loader(args as never);
      const result = extractLoaderResult<{
        dashboardData: Promise<{ buyerLedger: { rows: Array<{ name: string; id: string }> } | null }> | null;
      }>(rawResult);

      expect(result.dashboardData).toBeTruthy();
      const resolved = await result.dashboardData!;
      const str = JSON.stringify(resolved);

      expect(str).toContain(BUYER_A_ID);
      expect(str).not.toContain(SHOP_B_BUYER_NAME);
      expect(str).not.toContain(BUYER_B_ID);
      expect(str).not.toContain(SHOP_B_INVOICE_AMOUNT);

      const { found, marker } = containsAnyMarker(resolved);
      expect(found, `Dashboard contains B marker: ${marker}`).toBe(false);
    });
  });

  describe("app.data-requests - data request list isolation", () => {
    it("shop A data requests list does not contain shop B's requests (negative)", async () => {
      expect.hasAssertions();
      const args = createLoaderArgs("/app/data-requests");
      const { loader } = await import("../../app/routes/app.data-requests.js");
      const result = (await loader(args as never)) as { dataRequests: Array<{ id: string; requestId: string }> };

      expect(result.dataRequests).toBeDefined();

      const { found, marker } = containsAnyMarker(result);
      expect(found, `Response contains B marker: ${marker}`).toBe(false);

      const bRequestIds = result.dataRequests.filter(dr => dr.id === DATA_REQUEST_B_ID || dr.requestId === "req-b-id");
      expect(bRequestIds).toHaveLength(0);
    });

    it("shop A data requests list contains A's requests (positive control)", async () => {
      expect.hasAssertions();

      // Verify the shop the loader will resolve has the expected domain
      const [shopByDomain] = await sql`SELECT id, domain FROM "Shop" WHERE domain = ${SHOP_A_DOMAIN}`;
      expect(shopByDomain, `Shop with domain ${SHOP_A_DOMAIN} not found`).toBeDefined();
      expect(shopByDomain.id).toBe(SHOP_A_ID);

      const args = createLoaderArgs("/app/data-requests");
      const { loader } = await import("../../app/routes/app.data-requests.js");
      const result = (await loader(args as never)) as { dataRequests: Array<{ id: string; requestId: string }>; error: string | null };

      expect(result.error, `Loader returned error: ${result.error}`).toBeNull();

      const aRequests = result.dataRequests.filter(dr => dr.id === DATA_REQUEST_A_ID || dr.requestId === "req-a-id");
      expect(aRequests.length).toBeGreaterThan(0);
    });
  });

  describe("app.imports - bank import isolation", () => {
    it("shop A imports loader is shop-scoped, no B data (negative)", async () => {
      expect.hasAssertions();
      const hashBefore = await hashBRows();
      const { loader } = await import("../../app/routes/app.imports.js");
      const args = createLoaderArgs("/app/imports");
      const result = await loader(args as never);

      expect(result).toBeDefined();

      const { found, marker } = containsAnyMarker(result);
      expect(found, `Response contains B marker: ${marker}`).toBe(false);

      const hashAfter = await hashBRows();
      expect(hashAfter).toBe(hashBefore);
    });
  });

  describe("app.tag-rules - tag rule isolation", () => {
    it("shop A tag rules list does not contain shop B's rules (negative)", async () => {
      expect.hasAssertions();
      const args = createLoaderArgs("/app/tag-rules");
      const { loader } = await import("../../app/routes/app.tag-rules.js");
      const result = (await loader(args as never)) as { tagRules: Array<{ id: string; tag: string }> };

      expect(result.tagRules).toBeDefined();

      const { found, marker } = containsAnyMarker(result);
      expect(found, `Response contains B marker: ${marker}`).toBe(false);

      const bRules = result.tagRules.filter(r => r.id === TAG_RULE_B_ID || r.tag === SHOP_B_TAG_RULE_TAG);
      expect(bRules).toHaveLength(0);
    });

    it("shop A tag rules list contains A's rules (positive control)", async () => {
      expect.hasAssertions();
      const args = createLoaderArgs("/app/tag-rules");
      const { loader } = await import("../../app/routes/app.tag-rules.js");
      const result = (await loader(args as never)) as { tagRules: Array<{ id: string; tag: string }> };

      const aRules = result.tagRules.filter(r => r.id === TAG_RULE_A_ID || r.tag === "net30-a");
      expect(aRules.length).toBeGreaterThan(0);
    });
  });

  describe("app.plan - plan page isolation", () => {
    it("shop A plan page is shop-scoped (negative)", async () => {
      expect.hasAssertions();
      const args = createLoaderArgs("/app/plan");
      const { loader } = await import("../../app/routes/app.plan.js");
      const result = await loader(args as never);

      expect(result).toBeDefined();

      const { found, marker } = containsAnyMarker(result);
      expect(found, `Response contains B marker: ${marker}`).toBe(false);
    });
  });

  describe("unsubscribe - public route isolation", () => {
    it("cross-shop: A's token with B's non-opted-out buyerAccountId cannot opt out B's buyer", async () => {
      expect.hasAssertions();
      const beforeB = await sql`SELECT "reminderOptOutAt" FROM "BuyerAccount" WHERE id = ${BUYER_B_OPTOUT_ID}`;
      expect(beforeB[0].reminderOptOutAt).toBeNull();

      const crossShopToken = generateUnsubscribeToken(SHOP_A_ID, BUYER_B_OPTOUT_ID, UNSUBSCRIBE_SECRET);
      expect(crossShopToken).not.toBeNull();

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      const hashBefore = await hashBRows();

      const args = createPublicActionArgs(
        "/unsubscribe",
        { "List-Unsubscribe": "One-Click" },
        { token: crossShopToken! }
      );
      const { action } = await import("../../app/routes/unsubscribe.js");
      const result = (await action(args as never)) as { success: boolean };

      expect(result.success).toBe(true);

      const afterB = await sql`SELECT "reminderOptOutAt" FROM "BuyerAccount" WHERE id = ${BUYER_B_OPTOUT_ID}`;
      expect(afterB[0].reminderOptOutAt).toBeNull();

      const hashAfter = await hashBRows();
      expect(hashAfter).toBe(hashBefore);
    });

    it("valid B token for B's own buyer leaves A's buyer unchanged", async () => {
      expect.hasAssertions();
      const tokenForBuyerB = generateUnsubscribeToken(SHOP_B_ID, BUYER_B_ID, UNSUBSCRIBE_SECRET);
      expect(tokenForBuyerB).not.toBeNull();

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      const hashBefore = await hashBRows();
      const beforeA = await sql`SELECT "reminderOptOutAt" FROM "BuyerAccount" WHERE id = ${BUYER_A_ID}`;
      const wasOptedOutA = beforeA[0].reminderOptOutAt !== null;

      const args = createPublicActionArgs(
        "/unsubscribe",
        { "List-Unsubscribe": "One-Click" },
        { token: tokenForBuyerB! }
      );
      const { action } = await import("../../app/routes/unsubscribe.js");
      const result = (await action(args as never)) as { success: boolean; alreadyOptedOut: boolean };

      expect(result.success).toBe(true);

      const afterA = await sql`SELECT "reminderOptOutAt" FROM "BuyerAccount" WHERE id = ${BUYER_A_ID}`;
      const isOptedOutAfterA = afterA[0].reminderOptOutAt !== null;
      expect(isOptedOutAfterA).toBe(wasOptedOutA);

      const hashAfter = await hashBRows();
      expect(hashAfter).toBe(hashBefore);
    });

    it("unsubscribe loader does not leak B's data with invalid token", async () => {
      expect.hasAssertions();
      const args = createPublicLoaderArgs("/unsubscribe", { token: "invalid-token" });
      const { loader } = await import("../../app/routes/unsubscribe.js");
      const result = await loader(args as never);

      expect((result as { valid: boolean }).valid).toBe(false);

      const { found, marker } = containsAnyMarker(result);
      expect(found, `Response contains B marker: ${marker}`).toBe(false);
    });
  });

  describe("Route manifest guard", () => {
    const ROUTES_DIR = path.join(__dirname, "../../app/routes");

    const TESTED_ROUTES: Record<string, RouteExpectation> = {
      "app.accounts.$id.tsx": { status: 404, reason: "Account not found for other shop", hasLoader: true, hasAction: true },
      "app.data-requests.$id.download.tsx": { status: 404, reason: "Data request not found for other shop", hasLoader: true },
      "app.reconcile.tsx": { status: "noop", reason: "Action returns success:false, loader returns null selectedPayment", hasLoader: true, hasAction: true },
      "app.settings.reminders.tsx": { status: "noop", reason: "Rule not found for other shop", hasLoader: true, hasAction: true },
      "app._index.tsx": { status: "noop", reason: "Dashboard is shop-scoped, ?buyer param returns Unknown Buyer", hasLoader: true },
      "app.data-requests.tsx": { status: "noop", reason: "List route, shop-scoped by session", hasLoader: true },
      "app.imports.tsx": { status: "noop", reason: "Import route, shop-scoped by session, no cross-tenant ID params", hasLoader: true, hasAction: true },
      "app.tag-rules.tsx": { status: "noop", reason: "Tag rules list, shop-scoped by session", hasLoader: true, hasAction: true },
      "app.plan.tsx": { status: "noop", reason: "Plan page, shop-scoped by session", hasLoader: true },
      "unsubscribe.tsx": { status: "noop", reason: "Public route with signed token, cross-shop token fails gracefully", hasLoader: true, hasAction: true },
    };

    it("all route files are either tested or in the explicit exclusions list", () => {
      expect.hasAssertions();
      const routeFiles = fs.readdirSync(ROUTES_DIR)
        .filter(f => f.endsWith(".tsx") && !f.includes("test") && !f.startsWith("_"));

      const allCovered = [...Object.keys(TESTED_ROUTES), ...Object.keys(ROUTE_EXCLUSIONS)];
      const uncovered = routeFiles.filter(f => !allCovered.includes(f));

      expect(
        uncovered,
        `Route files not covered by tenant isolation tests or exclusions: ${uncovered.join(", ")}`
      ).toHaveLength(0);
    });

    it("all route exclusions have documented reasons", () => {
      expect.hasAssertions();
      for (const [route, reason] of Object.entries(ROUTE_EXCLUSIONS)) {
        expect(reason.length, `${route} exclusion reason is empty`).toBeGreaterThan(0);
      }
    });

    it("tested routes map has expected status for each route", () => {
      expect.hasAssertions();
      for (const [route, expectation] of Object.entries(TESTED_ROUTES)) {
        expect(expectation.status, `${route} missing status`).toBeDefined();
        expect(expectation.reason, `${route} missing reason`).toBeDefined();
        expect(expectation.reason.length, `${route} reason is empty`).toBeGreaterThan(0);
      }
    });

    it("routes with $param segments are tested", () => {
      expect.hasAssertions();
      const routeFiles = fs.readdirSync(ROUTES_DIR)
        .filter(f => f.endsWith(".tsx") && !f.includes("test") && f.includes("$"));

      const tested = Object.keys(TESTED_ROUTES);
      const excluded = Object.keys(ROUTE_EXCLUSIONS);
      const missingTests: string[] = [];

      for (const route of routeFiles) {
        if (!tested.includes(route) && !excluded.includes(route)) {
          missingTests.push(route);
        }
      }

      expect(
        missingTests,
        `Routes with $param segments missing from tests: ${missingTests.join(", ")}`
      ).toHaveLength(0);
    });

    it("routes with formData.get(...Id) patterns are covered", () => {
      expect.hasAssertions();
      const routeFiles = fs.readdirSync(ROUTES_DIR)
        .filter(f => f.endsWith(".tsx") && !f.includes("test"));

      const routesWithIdParams: string[] = [];

      for (const routeFile of routeFiles) {
        const content = fs.readFileSync(path.join(ROUTES_DIR, routeFile), "utf-8");
        const hasFormDataId = /formData\.get\(["'](\w*[Ii]d)["']\)/.test(content);
        const hasSearchParamsId = /searchParams\.get\(["'](payment|buyer|match|invoice|rule|import)["']\)/.test(content);

        if (hasFormDataId || hasSearchParamsId) {
          routesWithIdParams.push(routeFile);
        }
      }

      const allCovered = [...Object.keys(TESTED_ROUTES), ...Object.keys(ROUTE_EXCLUSIONS)];
      const uncoveredIdRoutes = routesWithIdParams.filter(r => !allCovered.includes(r));

      expect(
        uncoveredIdRoutes,
        `Routes with ID params in formData/searchParams not covered: ${uncoveredIdRoutes.join(", ")}`
      ).toHaveLength(0);
    });
  });
});
