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
 * Matcher/apply services run REAL against the database - only Shopify GraphQL
 * and external services are mocked.
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

vi.mock("~/lib/recompute-enqueue.server", () => ({
  enqueueCreditStatusRecompute: vi.fn().mockResolvedValue(true),
}));

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

  const SHOP_A_BUYER_NAME = "Shop A Buyer LLC";
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
    shopDomain = SHOP_A_DOMAIN
  ) {
    const url = new URL(`https://example.com${urlPath}`);
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
        "reminderOptOutAt", "reminderOptOutSource",
        "createdAt", "updatedAt"
      )
      VALUES
        (${BUYER_A_ID}, ${SHOP_A_ID}, 'COMPANY', ${"co-a-" + TEST_SUFFIX}, ${"loc-a-" + TEST_SUFFIX}, ${SHOP_A_BUYER_NAME}, 50000.00, 'OK', false, false, NULL, NULL, NOW(), NOW()),
        (${BUYER_B_ID}, ${SHOP_B_ID}, 'COMPANY', ${"co-b-" + TEST_SUFFIX}, ${"loc-b-" + TEST_SUFFIX}, ${SHOP_B_BUYER_NAME}, 75000.00, 'OK', false, false, NOW(), 'merchant'::"ReminderOptOutSource", NOW(), NOW())
    `;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", name, "orderId",
        total, outstanding, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES
        (${INVOICE_A_ID}, ${SHOP_A_ID}, ${BUYER_A_ID}, 'INV-A-001', ${"order-a-" + TEST_SUFFIX}, 10000.00, 10000.00, NOW(), NOW() + interval '30 days', NOW(), NOW()),
        (${INVOICE_B_ID}, ${SHOP_B_ID}, ${BUYER_B_ID}, 'INV-B-001', ${"order-b-" + TEST_SUFFIX}, ${SHOP_B_INVOICE_AMOUNT}, ${SHOP_B_INVOICE_AMOUNT}, NOW(), NOW() + interval '30 days', NOW(), NOW())
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
      INSERT INTO s22_data_requests (id, shop_id, customer_gid, request_id, status, received_at, expires_at, export_data)
      VALUES
        (${DATA_REQUEST_A_ID}, ${SHOP_A_ID}, 'cust-a-1', 'req-a-id', 'completed', NOW(), NOW() + interval '30 days', '{"customerId": "cust-a-1"}'::jsonb),
        (${DATA_REQUEST_B_ID}, ${SHOP_B_ID}, 'cust-b-1', 'req-b-id', 'completed', NOW(), NOW() + interval '30 days', '{"customerId": "cust-b-1"}'::jsonb)
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "Match" WHERE id IN (${MATCH_A_ID}, ${MATCH_B_ID})`;
    await sql`DELETE FROM "Payment" WHERE id IN (${PAYMENT_A_ID}, ${PAYMENT_B_ID})`;
    await sql`DELETE FROM "Invoice" WHERE id IN (${INVOICE_A_ID}, ${INVOICE_B_ID})`;
    await sql`DELETE FROM "BankImport" WHERE id IN (${IMPORT_A_ID}, ${IMPORT_B_ID})`;
    await sql`DELETE FROM "ReminderRule" WHERE id IN (${REMINDER_RULE_A_ID}, ${REMINDER_RULE_B_ID})`;
    await sql`DELETE FROM s22_data_requests WHERE id IN (${DATA_REQUEST_A_ID}, ${DATA_REQUEST_B_ID})`;
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

  describe("app.accounts.$id loader isolation", () => {
    it("shop A session cannot read shop B's buyer account (negative)", async () => {
      const args = createLoaderArgs(`/app/accounts/${BUYER_B_ID}`, { id: BUYER_B_ID });
      const { loader } = await import("../app.accounts.$id");
      const result = (await loader(args as never)) as { account: unknown; error: string | null };
      expect(result.account).toBeNull();
      expect(result.error).toBe("Account not found");
      const str = JSON.stringify(result);
      expect(str).not.toContain(SHOP_B_BUYER_NAME);
    });

    it("shop A session CAN read shop A's buyer account (positive control)", async () => {
      const args = createLoaderArgs(`/app/accounts/${BUYER_A_ID}`, { id: BUYER_A_ID });
      const { loader } = await import("../app.accounts.$id");
      const result = (await loader(args as never)) as { account: { id: string; name: string } | null; error: string | null };
      expect(result.error).toBeNull();
      expect(result.account).not.toBeNull();
      expect(result.account!.id).toBe(BUYER_A_ID);
      expect(result.account!.name).toBe(SHOP_A_BUYER_NAME);
    });
  });

  describe("app.accounts.$id action isolation", () => {
    it("shop A cannot update shop B's buyer account credit settings (negative)", async () => {
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

    it("shop A CAN update shop A's buyer account credit settings (positive control)", async () => {
      const args = createActionArgs(
        `/app/accounts/${BUYER_A_ID}`,
        { _action: "updateCredit", creditLimit: "60000", noLimit: "false", manualHold: "false" },
        { id: BUYER_A_ID }
      );

      const { action } = await import("../app.accounts.$id");
      const result = await action(args as never);

      const r = result as { success: boolean; error?: string };
      expect(r.success).toBe(true);

      const afterSnapshot = await sql`
        SELECT "creditLimit" FROM "BuyerAccount" WHERE id = ${BUYER_A_ID}
      `;
      expect(parseFloat(afterSnapshot[0].creditLimit)).toBe(60000);

      await sql`UPDATE "BuyerAccount" SET "creditLimit" = 50000.00 WHERE id = ${BUYER_A_ID}`;
    });

    it("shop A cannot update shop B's buyer reminder opt-out (negative)", async () => {
      const beforeSnapshot = await sql`
        SELECT "reminderOptOutAt", "reminderOptOutSource" FROM "BuyerAccount" WHERE id = ${BUYER_B_ID}
      `;

      const args = createActionArgs(
        `/app/accounts/${BUYER_B_ID}`,
        { _action: "updateReminderOptOut", enable: "true" },
        { id: BUYER_B_ID }
      );

      const { action } = await import("../app.accounts.$id");
      const result = await action(args as never);

      const r = result as { success: boolean; error?: string };
      expect(r.success).toBe(false);
      expect(r.error).toBe("Account not found");

      const afterSnapshot = await sql`
        SELECT "reminderOptOutAt", "reminderOptOutSource" FROM "BuyerAccount" WHERE id = ${BUYER_B_ID}
      `;
      expect(afterSnapshot[0].reminderOptOutAt).toEqual(beforeSnapshot[0].reminderOptOutAt);
      expect(afterSnapshot[0].reminderOptOutSource).toBe(beforeSnapshot[0].reminderOptOutSource);
    });

    it("shop A CAN update shop A's buyer reminder opt-out (positive control)", async () => {
      await sql`UPDATE "BuyerAccount" SET "reminderOptOutAt" = NOW(), "reminderOptOutSource" = 'merchant'::"ReminderOptOutSource" WHERE id = ${BUYER_A_ID}`;

      const args = createActionArgs(
        `/app/accounts/${BUYER_A_ID}`,
        { _action: "updateReminderOptOut", enable: "true" },
        { id: BUYER_A_ID }
      );

      const { action } = await import("../app.accounts.$id");
      const result = await action(args as never);

      const r = result as { success: boolean };
      expect(r.success).toBe(true);

      const afterSnapshot = await sql`
        SELECT "reminderOptOutAt", "reminderOptOutSource" FROM "BuyerAccount" WHERE id = ${BUYER_A_ID}
      `;
      expect(afterSnapshot[0].reminderOptOutAt).toBeNull();
      expect(afterSnapshot[0].reminderOptOutSource).toBeNull();
    });
  });

  describe("app.data-requests.$id.download loader isolation", () => {
    it("shop A session cannot download shop B's data request (negative)", async () => {
      const args = createLoaderArgs(`/app/data-requests/req-b-id/download`, { id: "req-b-id" });
      const mod = await import("../app.data-requests.$id.download");
      const result = await mod.loader(args as never);
      expect(result).toBeInstanceOf(Response);
      const r = result as Response;
      expect(r.status).toBe(404);
    });

    it("shop A session CAN download shop A's data request (positive control)", async () => {
      const args = createLoaderArgs(`/app/data-requests/req-a-id/download`, { id: "req-a-id" });
      const mod = await import("../app.data-requests.$id.download");
      const result = await mod.loader(args as never);
      expect(result).toBeInstanceOf(Response);
      const r = result as Response;
      expect(r.status).toBe(200);
    });
  });

  describe("app.reconcile action isolation - REAL confirmMatch/rejectMatch/applyMatch", () => {
    beforeEach(async () => {
      await sql`UPDATE "Match" SET state = 'suggested' WHERE id IN (${MATCH_A_ID}, ${MATCH_B_ID})`;
    });

    it("shop A cannot confirm shop B's match (negative)", async () => {
      const beforeSnapshot = await sql`SELECT state FROM "Match" WHERE id = ${MATCH_B_ID}`;
      expect(beforeSnapshot[0].state).toBe("suggested");

      const args = createActionArgs("/app/reconcile", { intent: "confirm", matchId: MATCH_B_ID });
      const { action } = await import("../app.reconcile");
      const result = (await action(args as never)) as { success: boolean; error?: string };

      expect(result.success).toBe(false);

      const afterSnapshot = await sql`SELECT state FROM "Match" WHERE id = ${MATCH_B_ID}`;
      expect(afterSnapshot[0].state).toBe("suggested");
    });

    it("shop A CAN confirm shop A's match (positive control)", async () => {
      const args = createActionArgs("/app/reconcile", { intent: "confirm", matchId: MATCH_A_ID });
      const { action } = await import("../app.reconcile");
      const result = (await action(args as never)) as { success: boolean };

      expect(result.success).toBe(true);

      const afterSnapshot = await sql`SELECT state FROM "Match" WHERE id = ${MATCH_A_ID}`;
      expect(afterSnapshot[0].state).toBe("confirmed");

      await sql`UPDATE "Match" SET state = 'suggested' WHERE id = ${MATCH_A_ID}`;
    });

    it("shop A cannot reject shop B's match (negative)", async () => {
      const beforeSnapshot = await sql`SELECT state FROM "Match" WHERE id = ${MATCH_B_ID}`;

      const args = createActionArgs("/app/reconcile", { intent: "reject", matchId: MATCH_B_ID });
      const { action } = await import("../app.reconcile");
      const result = (await action(args as never)) as { success: boolean };

      expect(result.success).toBe(false);

      const afterSnapshot = await sql`SELECT state FROM "Match" WHERE id = ${MATCH_B_ID}`;
      expect(afterSnapshot[0]).toEqual(beforeSnapshot[0]);
    });

    it("shop A CAN reject shop A's match (positive control)", async () => {
      const args = createActionArgs("/app/reconcile", { intent: "reject", matchId: MATCH_A_ID });
      const { action } = await import("../app.reconcile");
      const result = (await action(args as never)) as { success: boolean };

      expect(result.success).toBe(true);

      const afterSnapshot = await sql`SELECT state FROM "Match" WHERE id = ${MATCH_A_ID}`;
      expect(afterSnapshot[0].state).toBe("rejected");

      await sql`UPDATE "Match" SET state = 'suggested' WHERE id = ${MATCH_A_ID}`;
    });

    it("shop A cannot apply shop B's match (negative)", async () => {
      await sql`UPDATE "Match" SET state = 'confirmed' WHERE id = ${MATCH_B_ID}`;

      const beforeInvoice = await sql`SELECT outstanding FROM "Invoice" WHERE id = ${INVOICE_B_ID}`;
      const beforeMatch = await sql`SELECT state FROM "Match" WHERE id = ${MATCH_B_ID}`;
      expect(beforeMatch[0].state).toBe("confirmed");

      const args = createActionArgs("/app/reconcile", { intent: "apply", matchId: MATCH_B_ID });
      const { action } = await import("../app.reconcile");
      const result = (await action(args as never)) as { success: boolean };

      expect(result.success).toBe(false);

      const afterInvoice = await sql`SELECT outstanding FROM "Invoice" WHERE id = ${INVOICE_B_ID}`;
      expect(afterInvoice[0]).toEqual(beforeInvoice[0]);

      const afterMatch = await sql`SELECT state FROM "Match" WHERE id = ${MATCH_B_ID}`;
      expect(afterMatch[0].state).toBe("confirmed");

      await sql`UPDATE "Match" SET state = 'suggested' WHERE id = ${MATCH_B_ID}`;
    });

    it("shop A cannot unmatch shop B's match (negative)", async () => {
      await sql`UPDATE "Match" SET state = 'confirmed' WHERE id = ${MATCH_B_ID}`;

      const beforeMatch = await sql`SELECT state FROM "Match" WHERE id = ${MATCH_B_ID}`;
      expect(beforeMatch[0].state).toBe("confirmed");

      const args = createActionArgs("/app/reconcile", { intent: "unmatch", matchId: MATCH_B_ID });
      const { action } = await import("../app.reconcile");
      const result = (await action(args as never)) as { success: boolean };

      expect(result.success).toBe(false);

      const afterMatch = await sql`SELECT state FROM "Match" WHERE id = ${MATCH_B_ID}`;
      expect(afterMatch[0].state).toBe("confirmed");

      await sql`UPDATE "Match" SET state = 'suggested' WHERE id = ${MATCH_B_ID}`;
    });
  });

  describe("app.reconcile loader ?payment param isolation", () => {
    it("shop A cannot load shop B's payment via ?payment param (negative)", async () => {
      const url = new URL(`https://example.com/app/reconcile?payment=${PAYMENT_B_ID}`);
      const args = {
        request: new Request(url),
        context: createMockContext(SHOP_A_DOMAIN),
        params: {},
        url,
        pattern: "/app/reconcile",
      } as unknown;

      const { loader } = await import("../app.reconcile");
      const result = (await loader(args as never)) as { selectedPayment: unknown };

      expect(result.selectedPayment).toBeNull();
    });

    it("shop A CAN load shop A's payment via ?payment param (positive control)", async () => {
      const url = new URL(`https://example.com/app/reconcile?payment=${PAYMENT_A_ID}`);
      const args = {
        request: new Request(url),
        context: createMockContext(SHOP_A_DOMAIN),
        params: {},
        url,
        pattern: "/app/reconcile",
      } as unknown;

      const { loader } = await import("../app.reconcile");
      const result = (await loader(args as never)) as { selectedPayment: { payment: { id: string } } | null };

      expect(result.selectedPayment).not.toBeNull();
      expect(result.selectedPayment!.payment.id).toBe(PAYMENT_A_ID);
    });
  });

  describe("app.settings.reminders action ruleId isolation", () => {
    it("shop A cannot update shop B's reminder rule via update_rule (negative)", async () => {
      const beforeSnapshot = await sql`SELECT "offsetDays", enabled FROM "ReminderRule" WHERE id = ${REMINDER_RULE_B_ID}`;

      const args = createActionArgs("/app/settings/reminders", {
        intent: "update_rule",
        ruleId: REMINDER_RULE_B_ID,
        offsetDays: "14",
        enabled: "false",
      });

      const { action } = await import("../app.settings.reminders");
      const result = (await action(args as never)) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Rule not found");

      const afterSnapshot = await sql`SELECT "offsetDays", enabled FROM "ReminderRule" WHERE id = ${REMINDER_RULE_B_ID}`;
      expect(afterSnapshot[0]).toEqual(beforeSnapshot[0]);
    });

    it("shop A CAN update shop A's reminder rule via update_rule (positive control)", async () => {
      const args = createActionArgs("/app/settings/reminders", {
        intent: "update_rule",
        ruleId: REMINDER_RULE_A_ID,
        offsetDays: "-7",
        enabled: "false",
      });

      const { action } = await import("../app.settings.reminders");
      const result = (await action(args as never)) as { success: boolean };

      expect(result.success).toBe(true);

      const afterSnapshot = await sql`SELECT enabled FROM "ReminderRule" WHERE id = ${REMINDER_RULE_A_ID}`;
      expect(afterSnapshot[0].enabled).toBe(false);

      await sql`UPDATE "ReminderRule" SET enabled = true WHERE id = ${REMINDER_RULE_A_ID}`;
    });

    it("shop A cannot delete shop B's reminder rule via delete_rule (negative)", async () => {
      const beforeCount = await sql`SELECT COUNT(*)::int AS count FROM "ReminderRule" WHERE id = ${REMINDER_RULE_B_ID}`;
      expect(beforeCount[0].count).toBe(1);

      const args = createActionArgs("/app/settings/reminders", {
        intent: "delete_rule",
        ruleId: REMINDER_RULE_B_ID,
      });

      const { action } = await import("../app.settings.reminders");
      const result = (await action(args as never)) as { success: boolean; error?: string };

      expect(result.success).toBe(false);

      const afterCount = await sql`SELECT COUNT(*)::int AS count FROM "ReminderRule" WHERE id = ${REMINDER_RULE_B_ID}`;
      expect(afterCount[0].count).toBe(1);
    });
  });

  describe("app._index loader ?buyer param isolation (with deferred dashboardData)", () => {
    it("shop A cannot view shop B's buyer invoices via ?buyer param (negative)", async () => {
      expect.hasAssertions();
      const url = new URL(`https://example.com/app?buyer=${BUYER_B_ID}`);
      const args = {
        request: new Request(url),
        context: createMockContext(SHOP_A_DOMAIN),
        params: {},
        url,
        pattern: "/app",
      } as unknown;

      const { loader } = await import("../app._index");
      const result = (await loader(args as never)) as unknown as {
        dashboardData: Promise<{ selectedBuyerInvoices: unknown; buyerLedger: { rows: Array<{ id: string }> } | null }> | null;
      };

      expect(result.dashboardData).toBeTruthy();
      const resolved = await result.dashboardData!;
      expect(resolved.selectedBuyerInvoices).toBeNull();
      const str = JSON.stringify(resolved);
      expect(str).not.toContain(BUYER_B_ID);
    });

    it("shop A CAN view shop A's buyer invoices via ?buyer param (positive control)", async () => {
      expect.hasAssertions();
      const url = new URL(`https://example.com/app?buyer=${BUYER_A_ID}`);
      const args = {
        request: new Request(url),
        context: createMockContext(SHOP_A_DOMAIN),
        params: {},
        url,
        pattern: "/app",
      } as unknown;

      const { loader } = await import("../app._index");
      const result = (await loader(args as never)) as unknown as {
        dashboardData: Promise<{ selectedBuyerInvoices: { buyerName: string } | null }> | null;
      };

      expect(result.dashboardData).toBeTruthy();
      const resolved = await result.dashboardData!;
      expect(resolved.selectedBuyerInvoices).not.toBeNull();
      expect(resolved.selectedBuyerInvoices!.buyerName).toBe(SHOP_A_BUYER_NAME);
    });
  });

  describe("List loaders return only shop A's data", () => {
    it("app._index loader returns shop A's buyers, not shop B's (dashboardData awaited)", async () => {
      expect.hasAssertions();
      const args = createLoaderArgs("/app");

      const { loader } = await import("../app._index");
      const result = (await loader(args as never)) as unknown as {
        dashboardData: Promise<{ buyerLedger: { rows: Array<{ name: string; id: string }> } | null }> | null;
      };

      expect(result.dashboardData).toBeTruthy();
      const resolved = await result.dashboardData!;
      const str = JSON.stringify(resolved);

      expect(str).toContain(BUYER_A_ID);
      expect(str).not.toContain(SHOP_B_BUYER_NAME);
      expect(str).not.toContain(BUYER_B_ID);
      expect(str).not.toContain(SHOP_B_INVOICE_AMOUNT);
    });

    it("app.reconcile loader returns shop A's matches, not shop B's", async () => {
      const args = createLoaderArgs("/app/reconcile");

      const { loader } = await import("../app.reconcile");
      const result = await loader(args as never);

      const str = JSON.stringify(result);
      expect(str).toContain(MATCH_A_ID);
      expect(str).not.toContain(MATCH_B_ID);
      expect(str).not.toContain(SHOP_B_PAYMENT_AMOUNT);
    });

    it("app.data-requests loader returns shop A's data requests, not shop B's", async () => {
      const args = createLoaderArgs("/app/data-requests");

      const { loader } = await import("../app.data-requests");
      const result = await loader(args as never);

      const str = JSON.stringify(result);
      expect(str).toContain(DATA_REQUEST_A_ID);
      expect(str).toContain("req-a-id");
      expect(str).not.toContain("req-b-id");
      expect(str).not.toContain("cust-b-1");
    });

    it("app.settings.reminders loader returns shop A's rules, not shop B's", async () => {
      const args = createLoaderArgs("/app/settings/reminders");

      const { loader } = await import("../app.settings.reminders");
      const result = await loader(args as never);

      const str = JSON.stringify(result);
      expect(str).toContain(REMINDER_RULE_A_ID);
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
    const url = new URL("https://example.com/app?skipOnboarding=true");
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
    "app._index.tsx": "List route, covered by ?buyer param test",
    "app.reconcile.tsx": "Covered by action isolation tests and ?payment param test",
    "app.imports.tsx": "No record ID params in action (uses JSON body), shop-scoped by session",
    "app.data-requests.tsx": "List route, no record ID param in URL or form",
    "app.settings.reminders.tsx": "Covered by ruleId action isolation tests (update_rule, delete_rule)",
    "app.plan.tsx": "No record IDs",
    "app.tag-rules.tsx": "No record ID params (create_tag_rule only, no update/delete with ID)",
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

  it("routes with formData.get(...Id) or searchParams.get patterns are covered", () => {
    const routeFiles = fs.readdirSync(ROUTES_DIR)
      .filter(f => f.startsWith("app.") && f.endsWith(".tsx") && !f.includes("test"));

    const routesWithIdParams: string[] = [];

    for (const routeFile of routeFiles) {
      const content = fs.readFileSync(path.join(ROUTES_DIR, routeFile), "utf-8");

      const hasFormDataId = /formData\.get\(["'](\w*[Ii]d)["']\)/.test(content);
      const hasSearchParamsId = /searchParams\.get\(["'](payment|buyer|match|invoice|rule|import)["']\)/.test(content);

      if (hasFormDataId || hasSearchParamsId) {
        routesWithIdParams.push(routeFile);
      }
    }

    const allCovered = [...TESTED_ROUTES, ...Object.keys(ALLOWLIST)];
    const uncoveredIdRoutes = routesWithIdParams.filter(r => !allCovered.includes(r));

    expect(
      uncoveredIdRoutes,
      `Routes with ID params in formData/searchParams not covered: ${uncoveredIdRoutes.join(", ")}`
    ).toHaveLength(0);
  });
});
