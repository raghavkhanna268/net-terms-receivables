/**
 * DB-backed integration tests for merchant form validation.
 * Uses the CI pgmq Postgres service (Sequential DB group via describeWithDb).
 *
 * Tests verify:
 * 1. Net terms days: valid values save; 0, negative, non-integer, huge are rejected with DB unchanged
 * 2. Credit limit input: validation for various formats (credit-limit cases check validation and
 *    the parsed payload via updateCreditStatus mock, not actual DB persistence)
 * 3. Reminder settings: enable/disable persist; offset bounds validation
 * 4. Onboarding 'configured' state matches what was saved
 * 5. Buyer account per-buyer overrides are shop-scoped; foreign account id gives error
 * 6. Actions reject GET, require session, with no DB write
 *
 * Mocks:
 * - authenticate.admin (Shopify session)
 * - getRequestSql (request-context for DB connection)
 * - gating.server (isAccountActive, isGatingEnforced, getUsageStats)
 * - aging-queries.server (getBuyerInvoices)
 * - credit-status.server (getCreditStatusDisplay, getCompanyTotals, updateCreditStatus)
 * - reminder-optout.server (getBuyerOptOutStatus, setBuyerOptOut, clearBuyerOptOut)
 * - plan-url (getAppHandle, buildPlanSelectionUrl)
 * - reconcile-handlers.server (enqueueReconcileStage)
 * - reminder-status.server (getReminderStatusCounts, getDelayedReminders, getShopSentTodayCount)
 * - @shopify/shopify-app-react-router/server (boundary.headers)
 * - Section 4 additionally mocks: initial-sync.server, shop-currency-recovery.server,
 *   shop-currency.server, email-sender-config.server
 *
 * Never mocks the code under test or log.server.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

vi.mock("~/services/gating.server", () => ({
  isAccountActive: vi.fn().mockReturnValue(true),
  isGatingEnforced: vi.fn().mockReturnValue(false),
  getUsageStats: vi.fn().mockResolvedValue({
    companies: { current: 0, limit: 25 },
    importsThisMonth: { current: 0, limit: -1 },
  }),
}));

vi.mock("~/lib/aging-queries.server", () => ({
  getBuyerInvoices: vi.fn().mockResolvedValue({ rows: [], totalCount: 0 }),
}));

vi.mock("~/services/credit-status.server", () => ({
  getCreditStatusDisplay: vi.fn().mockResolvedValue({
    creditLimitAmount: 100000,
    creditLimitPaise: 10000000n,
    exposurePaise: 0n,
    draftExposurePaise: 0n,
    availableCreditPaise: 10000000n,
    currency: "INR",
    holdState: "OK",
    manualHold: false,
    holdReasonCode: null,
    holdNote: null,
    isOnHold: false,
    holdReasonDisplay: null,
    isOverLimit: false,
    isOverdue: false,
    utilizationPercent: 0,
    syncPending: false,
    syncErrorCode: null,
    metafieldSyncedAt: null,
  }),
  getCompanyTotals: vi.fn().mockResolvedValue(null),
  updateCreditStatus: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("~/services/reminder-optout.server", () => ({
  getBuyerOptOutStatus: vi.fn().mockResolvedValue(null),
  setBuyerOptOut: vi.fn(),
  clearBuyerOptOut: vi.fn().mockResolvedValue(false),
}));

vi.mock("~/lib/plan-url", () => ({
  getAppHandle: vi.fn().mockReturnValue("net-terms-receivables-1"),
  buildPlanSelectionUrl: vi.fn().mockReturnValue("https://admin.shopify.com/plans"),
}));

vi.mock("~/services/drain/reconcile-handlers.server", () => ({
  enqueueReconcileStage: vi.fn().mockResolvedValue(true),
}));

vi.mock("~/services/reminder-status.server", () => ({
  getReminderStatusCounts: vi.fn().mockResolvedValue({
    sent: 0,
    delayed: 0,
    skippedDailyLimit: 0,
    skippedOptedOut: 0,
  }),
  getDelayedReminders: vi.fn().mockResolvedValue([]),
  getShopSentTodayCount: vi.fn().mockResolvedValue(0),
}));

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { headers: vi.fn(() => ({})) },
}));

interface ActionResultData {
  success: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  message?: string;
}

function extractActionData(result: unknown): ActionResultData {
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    (result as { type: string }).type === "DataWithResponseInit" &&
    "data" in result
  ) {
    return (result as { data: ActionResultData }).data;
  }
  return result as ActionResultData;
}

function extractStatus(result: unknown): number | undefined {
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    (result as { type: string }).type === "DataWithResponseInit" &&
    "init" in result
  ) {
    const init = (result as { init: { status?: number } | null }).init;
    return init?.status;
  }
  return undefined;
}

describeWithDb("Merchant form validation (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-form-val";

  const SHOP_A_ID = `shop-a-${TEST_SUFFIX}`;
  const SHOP_A_DOMAIN = `test-shop-a-${TEST_SUFFIX}.myshopify.com`;
  const SHOP_B_ID = `shop-b-${TEST_SUFFIX}`;
  const SHOP_B_DOMAIN = `test-shop-b-${TEST_SUFFIX}.myshopify.com`;
  const SHOP_TAG_ID = `shop-tag-${TEST_SUFFIX}`;
  const SHOP_TAG_DOMAIN = `test-shop-tag-${TEST_SUFFIX}.myshopify.com`;

  const ACCOUNT_A_ID = `acc-a-${TEST_SUFFIX}`;
  const ACCOUNT_B_ID = `acc-b-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, "createdAt", "updatedAt")
      VALUES 
        (${SHOP_A_ID}, ${SHOP_A_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW()),
        (${SHOP_B_ID}, ${SHOP_B_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW()),
        (${SHOP_TAG_ID}, ${SHOP_TAG_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "syncPending",
        "createdAt", "updatedAt"
      )
      VALUES 
        (${ACCOUNT_A_ID}, ${SHOP_A_ID}, 'COMPANY', ${"co-a-" + TEST_SUFFIX}, ${"loc-a-" + TEST_SUFFIX},
         'Test Account A', 100000.00, 'OK', false, false, NOW(), NOW()),
        (${ACCOUNT_B_ID}, ${SHOP_B_ID}, 'COMPANY', ${"co-b-" + TEST_SUFFIX}, ${"loc-b-" + TEST_SUFFIX},
         'Test Account B', 200000.00, 'OK', false, false, NOW(), NOW())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "ReminderRule" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID}, ${SHOP_TAG_ID})`;
    await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id IN (${SHOP_A_ID}, ${SHOP_B_ID}, ${SHOP_TAG_ID})`;
    await sql`DELETE FROM "AccountSource" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID}, ${SHOP_TAG_ID})`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID}, ${SHOP_TAG_ID})`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID}, ${SHOP_TAG_ID})`;
    await sql`DELETE FROM "Shop" WHERE id IN (${SHOP_A_ID}, ${SHOP_B_ID}, ${SHOP_TAG_ID})`;
    await sql.end();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("1. Net terms days validation (tag rules)", () => {
    function createTagRulesActionArgs(shopDomain: string, formData: FormData) {
      return {
        request: new Request("https://example.com/app/tag-rules", {
          method: "POST",
          body: formData,
        }),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({ session: { shop: shopDomain } }),
            },
          },
        },
        params: {},
        url: new URL("https://example.com/app/tag-rules"),
        pattern: "/app/tag-rules",
      } as unknown;
    }

    async function getAccountSourceSnapshot(shopId: string) {
      return sql<{ id: string; tag: string; defaultTermsDays: number }[]>`
        SELECT id, tag, "defaultTermsDays" FROM "AccountSource"
        WHERE "shopId" = ${shopId}
        ORDER BY id
      `;
    }

    it("valid net terms days (30) saves to DB", async () => {
      const tag = `valid-tag-${Date.now()}`;
      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", tag);
      formData.append("defaultTermsDays", "30");

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();
      const { action } = await import("../app.tag-rules");
      const result = await action(createTagRulesActionArgs(SHOP_TAG_DOMAIN, formData) as never);

      const data = extractActionData(result);
      expect(data.success).toBe(true);

      const [saved] = await sql<{ tag: string; defaultTermsDays: number }[]>`
        SELECT tag, "defaultTermsDays" FROM "AccountSource"
        WHERE "shopId" = ${SHOP_TAG_ID} AND tag = ${tag}
      `;
      expect(saved).toBeDefined();
      expect(saved.defaultTermsDays).toBe(30);

      await sql`DELETE FROM "AccountSource" WHERE tag = ${tag} AND "shopId" = ${SHOP_TAG_ID}`;
    });

    it("net terms days = 0 is rejected with field error, DB unchanged", async () => {
      const snapshotBefore = await getAccountSourceSnapshot(SHOP_TAG_ID);

      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", "zero-terms");
      formData.append("defaultTermsDays", "0");

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();
      const { action } = await import("../app.tag-rules");
      const result = await action(createTagRulesActionArgs(SHOP_TAG_DOMAIN, formData) as never);

      const status = extractStatus(result);
      expect(status).toBe(400);

      const data = extractActionData(result);
      expect(data.success).toBe(false);
      expect(data.fieldErrors?.defaultTermsDays).toContain("at least 1");

      const snapshotAfter = await getAccountSourceSnapshot(SHOP_TAG_ID);
      expect(snapshotAfter).toEqual(snapshotBefore);
    });

    it("negative net terms days (-5) is rejected with field error, DB unchanged", async () => {
      const snapshotBefore = await getAccountSourceSnapshot(SHOP_TAG_ID);

      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", "negative-terms");
      formData.append("defaultTermsDays", "-5");

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();
      const { action } = await import("../app.tag-rules");
      const result = await action(createTagRulesActionArgs(SHOP_TAG_DOMAIN, formData) as never);

      const status = extractStatus(result);
      expect(status).toBe(400);

      const data = extractActionData(result);
      expect(data.success).toBe(false);
      expect(data.fieldErrors?.defaultTermsDays).toContain("at least 1");

      const snapshotAfter = await getAccountSourceSnapshot(SHOP_TAG_ID);
      expect(snapshotAfter).toEqual(snapshotBefore);
    });

    it("non-integer net terms days (30.5) is rejected with field error, DB unchanged", async () => {
      const snapshotBefore = await getAccountSourceSnapshot(SHOP_TAG_ID);

      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", "decimal-terms");
      formData.append("defaultTermsDays", "30.5");

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();
      const { action } = await import("../app.tag-rules");
      const result = await action(createTagRulesActionArgs(SHOP_TAG_DOMAIN, formData) as never);

      const status = extractStatus(result);
      expect(status).toBe(400);

      const data = extractActionData(result);
      expect(data.success).toBe(false);
      expect(data.fieldErrors?.defaultTermsDays).toContain("whole number");

      const snapshotAfter = await getAccountSourceSnapshot(SHOP_TAG_ID);
      expect(snapshotAfter).toEqual(snapshotBefore);
    });

    it("text net terms days ('abc') is rejected with field error, DB unchanged", async () => {
      const snapshotBefore = await getAccountSourceSnapshot(SHOP_TAG_ID);

      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", "text-terms");
      formData.append("defaultTermsDays", "abc");

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();
      const { action } = await import("../app.tag-rules");
      const result = await action(createTagRulesActionArgs(SHOP_TAG_DOMAIN, formData) as never);

      const status = extractStatus(result);
      expect(status).toBe(400);

      const data = extractActionData(result);
      expect(data.success).toBe(false);
      expect(data.fieldErrors?.defaultTermsDays).toBeDefined();

      const snapshotAfter = await getAccountSourceSnapshot(SHOP_TAG_ID);
      expect(snapshotAfter).toEqual(snapshotBefore);
    });

    it("huge net terms days (100000) is rejected with field error, DB unchanged", async () => {
      const snapshotBefore = await getAccountSourceSnapshot(SHOP_TAG_ID);

      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", "huge-terms");
      formData.append("defaultTermsDays", "100000");

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();
      const { action } = await import("../app.tag-rules");
      const result = await action(createTagRulesActionArgs(SHOP_TAG_DOMAIN, formData) as never);

      const status = extractStatus(result);
      expect(status).toBe(400);

      const data = extractActionData(result);
      expect(data.success).toBe(false);
      expect(data.fieldErrors?.defaultTermsDays).toContain("at most 365");

      const snapshotAfter = await getAccountSourceSnapshot(SHOP_TAG_ID);
      expect(snapshotAfter).toEqual(snapshotBefore);
    });

    it("boundary: net terms days = 1 (min) is accepted", async () => {
      const tag = `min-terms-${Date.now()}`;
      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", tag);
      formData.append("defaultTermsDays", "1");

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();
      const { action } = await import("../app.tag-rules");
      const result = await action(createTagRulesActionArgs(SHOP_TAG_DOMAIN, formData) as never);

      const data = extractActionData(result);
      expect(data.success).toBe(true);

      await sql`DELETE FROM "AccountSource" WHERE tag = ${tag} AND "shopId" = ${SHOP_TAG_ID}`;
    });

    it("boundary: net terms days = 365 (max) is accepted", async () => {
      const tag = `max-terms-${Date.now()}`;
      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", tag);
      formData.append("defaultTermsDays", "365");

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();
      const { action } = await import("../app.tag-rules");
      const result = await action(createTagRulesActionArgs(SHOP_TAG_DOMAIN, formData) as never);

      const data = extractActionData(result);
      expect(data.success).toBe(true);

      await sql`DELETE FROM "AccountSource" WHERE tag = ${tag} AND "shopId" = ${SHOP_TAG_ID}`;
    });
  });

  describe("2. Credit limit input validation (account detail)", () => {
    function createAccountActionArgs(shopDomain: string, accountId: string, formData: FormData) {
      return {
        request: new Request(`https://example.com/app/accounts/${accountId}`, {
          method: "POST",
          body: formData,
        }),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({ session: { shop: shopDomain } }),
            },
          },
          cloudflare: {
            env: {},
            ctx: { waitUntil: vi.fn() },
          },
        },
        params: { id: accountId },
      } as unknown;
    }

    it("valid credit limit '100000' (plain number) is accepted", async () => {
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();
      const creditStatusModule = await import("~/services/credit-status.server");
      const mockUpdate = vi.mocked(creditStatusModule.updateCreditStatus);
      mockUpdate.mockClear();
      mockUpdate.mockResolvedValue({ success: true });

      const formData = new FormData();
      formData.set("_action", "updateCredit");
      formData.set("creditLimit", "100000");

      const { action } = await import("../app.accounts.$id");
      const result = await action(createAccountActionArgs(SHOP_A_DOMAIN, ACCOUNT_A_ID, formData) as never);

      const data = extractActionData(result);
      expect(data.success).toBe(true);
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.anything(),
        ACCOUNT_A_ID,
        expect.objectContaining({ creditLimitAmount: 100000 })
      );
    });

    it("valid credit limit '100000.50' (with paise) is accepted", async () => {
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();
      const creditStatusModule = await import("~/services/credit-status.server");
      const mockUpdate = vi.mocked(creditStatusModule.updateCreditStatus);
      mockUpdate.mockClear();
      mockUpdate.mockResolvedValue({ success: true });

      const formData = new FormData();
      formData.set("_action", "updateCredit");
      formData.set("creditLimit", "100000.50");

      const { action } = await import("../app.accounts.$id");
      const result = await action(createAccountActionArgs(SHOP_A_DOMAIN, ACCOUNT_A_ID, formData) as never);

      const data = extractActionData(result);
      expect(data.success).toBe(true);
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.anything(),
        ACCOUNT_A_ID,
        expect.objectContaining({ creditLimitAmount: 100000.5 })
      );
    });

    it("Indian grouping '1,00,000' is rejected (commas not allowed)", async () => {
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();
      const creditStatusModule = await import("~/services/credit-status.server");
      const mockUpdate = vi.mocked(creditStatusModule.updateCreditStatus);
      mockUpdate.mockClear();

      const formData = new FormData();
      formData.set("_action", "updateCredit");
      formData.set("creditLimit", "1,00,000");

      const { action } = await import("../app.accounts.$id");
      const result = await action(createAccountActionArgs(SHOP_A_DOMAIN, ACCOUNT_A_ID, formData) as never);

      const data = extractActionData(result);
      expect(data.success).toBe(false);
      expect(data.error).toContain("Invalid credit limit format");
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("rupee symbol '₹1,00,000.50' is rejected", async () => {
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();
      const creditStatusModule = await import("~/services/credit-status.server");
      const mockUpdate = vi.mocked(creditStatusModule.updateCreditStatus);
      mockUpdate.mockClear();

      const formData = new FormData();
      formData.set("_action", "updateCredit");
      formData.set("creditLimit", "₹1,00,000.50");

      const { action } = await import("../app.accounts.$id");
      const result = await action(createAccountActionArgs(SHOP_A_DOMAIN, ACCOUNT_A_ID, formData) as never);

      const data = extractActionData(result);
      expect(data.success).toBe(false);
      expect(data.error).toContain("Invalid credit limit format");
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("paise rounding '100.555' (more than 2 decimal places) is rejected", async () => {
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();
      const creditStatusModule = await import("~/services/credit-status.server");
      const mockUpdate = vi.mocked(creditStatusModule.updateCreditStatus);
      mockUpdate.mockClear();

      const formData = new FormData();
      formData.set("_action", "updateCredit");
      formData.set("creditLimit", "100.555");

      const { action } = await import("../app.accounts.$id");
      const result = await action(createAccountActionArgs(SHOP_A_DOMAIN, ACCOUNT_A_ID, formData) as never);

      const data = extractActionData(result);
      expect(data.success).toBe(false);
      expect(data.error).toContain("Invalid credit limit format");
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("negative credit limit '-100' is rejected", async () => {
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();
      const creditStatusModule = await import("~/services/credit-status.server");
      const mockUpdate = vi.mocked(creditStatusModule.updateCreditStatus);
      mockUpdate.mockClear();

      const formData = new FormData();
      formData.set("_action", "updateCredit");
      formData.set("creditLimit", "-100");

      const { action } = await import("../app.accounts.$id");
      const result = await action(createAccountActionArgs(SHOP_A_DOMAIN, ACCOUNT_A_ID, formData) as never);

      const data = extractActionData(result);
      expect(data.success).toBe(false);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("empty credit limit (without noLimit) is rejected", async () => {
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();
      const creditStatusModule = await import("~/services/credit-status.server");
      const mockUpdate = vi.mocked(creditStatusModule.updateCreditStatus);
      mockUpdate.mockClear();

      const formData = new FormData();
      formData.set("_action", "updateCredit");
      formData.set("creditLimit", "");

      const { action } = await import("../app.accounts.$id");
      const result = await action(createAccountActionArgs(SHOP_A_DOMAIN, ACCOUNT_A_ID, formData) as never);

      const data = extractActionData(result);
      expect(data.success).toBe(false);
      expect(data.error).toContain("Credit limit cannot be empty");
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("text credit limit 'abc' is rejected", async () => {
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();
      const creditStatusModule = await import("~/services/credit-status.server");
      const mockUpdate = vi.mocked(creditStatusModule.updateCreditStatus);
      mockUpdate.mockClear();

      const formData = new FormData();
      formData.set("_action", "updateCredit");
      formData.set("creditLimit", "abc");

      const { action } = await import("../app.accounts.$id");
      const result = await action(createAccountActionArgs(SHOP_A_DOMAIN, ACCOUNT_A_ID, formData) as never);

      const data = extractActionData(result);
      expect(data.success).toBe(false);
      expect(data.error).toContain("Invalid credit limit format");
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("noLimit=true allows empty credit limit", async () => {
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();
      const creditStatusModule = await import("~/services/credit-status.server");
      const mockUpdate = vi.mocked(creditStatusModule.updateCreditStatus);
      mockUpdate.mockClear();
      mockUpdate.mockResolvedValue({ success: true });

      const formData = new FormData();
      formData.set("_action", "updateCredit");
      formData.set("creditLimit", "");
      formData.set("noLimit", "true");

      const { action } = await import("../app.accounts.$id");
      const result = await action(createAccountActionArgs(SHOP_A_DOMAIN, ACCOUNT_A_ID, formData) as never);

      const data = extractActionData(result);
      expect(data.success).toBe(true);
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.anything(),
        ACCOUNT_A_ID,
        expect.objectContaining({ creditLimitAmount: null, noLimit: true })
      );
    });
  });

  describe("3. Reminder settings validation", () => {
    function createRemindersActionArgs(shopDomain: string, formData: FormData) {
      return {
        request: new Request("https://example.com/app/settings/reminders", {
          method: "POST",
          body: formData,
        }),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({ session: { shop: shopDomain } }),
            },
          },
          cloudflare: {
            env: { RESEND_API_KEY: "re_test_123", RESEND_FROM: "noreply@example.com" },
          },
        },
        params: {},
        url: new URL("https://example.com/app/settings/reminders"),
        pattern: "/app/settings/reminders",
      } as unknown;
    }

    it("enable reminders persists to DB", async () => {
      await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_A_ID}`;
      await sql`
        INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
        VALUES (${SHOP_A_ID}, false, NOW(), NOW())
      `;

      const formData = new FormData();
      formData.append("intent", "toggle_enabled");
      formData.append("enabled", "true");

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();
      const { action } = await import("../app.settings.reminders");
      const result = await action(createRemindersActionArgs(SHOP_A_DOMAIN, formData) as never);

      const data = extractActionData(result);
      expect(data.success).toBe(true);
      expect(data.message).toBe("Reminders enabled");

      const [settings] = await sql<{ enabled: boolean }[]>`
        SELECT enabled FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_A_ID}
      `;
      expect(settings.enabled).toBe(true);
    });

    it("disable reminders persists to DB", async () => {
      await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_A_ID}`;
      await sql`
        INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
        VALUES (${SHOP_A_ID}, true, NOW(), NOW())
      `;

      const formData = new FormData();
      formData.append("intent", "toggle_enabled");
      formData.append("enabled", "false");

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();
      const { action } = await import("../app.settings.reminders");
      const result = await action(createRemindersActionArgs(SHOP_A_DOMAIN, formData) as never);

      const data = extractActionData(result);
      expect(data.success).toBe(true);
      expect(data.message).toBe("Reminders disabled");

      const [settings] = await sql<{ enabled: boolean }[]>`
        SELECT enabled FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_A_ID}
      `;
      expect(settings.enabled).toBe(false);
    });

    it("offset at OFFSET_MIN boundary (-30) is accepted", async () => {
      const ruleId = `rule-min-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
        VALUES (${ruleId}, ${SHOP_A_ID}, 0, 'email', true, NOW(), NOW())
        ON CONFLICT DO NOTHING
      `;

      const formData = new FormData();
      formData.append("intent", "update_rule");
      formData.append("ruleId", ruleId);
      formData.append("offsetDays", "-30");
      formData.append("enabled", "true");

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();
      const { action } = await import("../app.settings.reminders");
      const result = await action(createRemindersActionArgs(SHOP_A_DOMAIN, formData) as never);

      const data = extractActionData(result);
      expect(data.success).toBe(true);

      const [rule] = await sql<{ offsetDays: number }[]>`
        SELECT "offsetDays" FROM "ReminderRule" WHERE id = ${ruleId}
      `;
      expect(rule.offsetDays).toBe(-30);

      await sql`DELETE FROM "ReminderRule" WHERE id = ${ruleId}`;
    });

    it("offset at OFFSET_MAX boundary (90) is accepted", async () => {
      const ruleId = `rule-max-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
        VALUES (${ruleId}, ${SHOP_A_ID}, 0, 'email', true, NOW(), NOW())
        ON CONFLICT DO NOTHING
      `;

      const formData = new FormData();
      formData.append("intent", "update_rule");
      formData.append("ruleId", ruleId);
      formData.append("offsetDays", "90");
      formData.append("enabled", "true");

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();
      const { action } = await import("../app.settings.reminders");
      const result = await action(createRemindersActionArgs(SHOP_A_DOMAIN, formData) as never);

      const data = extractActionData(result);
      expect(data.success).toBe(true);

      const [rule] = await sql<{ offsetDays: number }[]>`
        SELECT "offsetDays" FROM "ReminderRule" WHERE id = ${ruleId}
      `;
      expect(rule.offsetDays).toBe(90);

      await sql`DELETE FROM "ReminderRule" WHERE id = ${ruleId}`;
    });

    it("offset just outside OFFSET_MIN (-31) is rejected, DB unchanged", async () => {
      const ruleId = `rule-oob-min-${TEST_SUFFIX}`;
      const originalOffset = 5;
      await sql`
        INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
        VALUES (${ruleId}, ${SHOP_A_ID}, ${originalOffset}, 'email', true, NOW(), NOW())
        ON CONFLICT DO NOTHING
      `;

      const formData = new FormData();
      formData.append("intent", "update_rule");
      formData.append("ruleId", ruleId);
      formData.append("offsetDays", "-31");
      formData.append("enabled", "true");

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();
      const { action } = await import("../app.settings.reminders");
      const result = await action(createRemindersActionArgs(SHOP_A_DOMAIN, formData) as never);

      const data = extractActionData(result);
      expect(data.success).toBe(false);
      expect(data.error).toContain("-30");
      expect(data.error).toContain("90");

      const [rule] = await sql<{ offsetDays: number }[]>`
        SELECT "offsetDays" FROM "ReminderRule" WHERE id = ${ruleId}
      `;
      expect(rule.offsetDays).toBe(originalOffset);

      await sql`DELETE FROM "ReminderRule" WHERE id = ${ruleId} AND "shopId" = ${SHOP_A_ID}`;
    });

    it("offset just outside OFFSET_MAX (91) is rejected, DB unchanged", async () => {
      const ruleId = `rule-oob-max-${TEST_SUFFIX}`;
      const originalOffset = 10;
      await sql`
        INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
        VALUES (${ruleId}, ${SHOP_A_ID}, ${originalOffset}, 'email', true, NOW(), NOW())
        ON CONFLICT DO NOTHING
      `;

      const formData = new FormData();
      formData.append("intent", "update_rule");
      formData.append("ruleId", ruleId);
      formData.append("offsetDays", "91");
      formData.append("enabled", "true");

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();
      const { action } = await import("../app.settings.reminders");
      const result = await action(createRemindersActionArgs(SHOP_A_DOMAIN, formData) as never);

      const data = extractActionData(result);
      expect(data.success).toBe(false);
      expect(data.error).toContain("-30");
      expect(data.error).toContain("90");

      const [rule] = await sql<{ offsetDays: number }[]>`
        SELECT "offsetDays" FROM "ReminderRule" WHERE id = ${ruleId}
      `;
      expect(rule.offsetDays).toBe(originalOffset);

      await sql`DELETE FROM "ReminderRule" WHERE id = ${ruleId} AND "shopId" = ${SHOP_A_ID}`;
    });
  });

  describe("4. Onboarding configured state matches saved reminders", () => {
    const mockAdmin = {
      graphql: vi.fn().mockImplementation(() =>
        Promise.resolve({
          json: () =>
            Promise.resolve({
              data: { validations: { edges: [] }, paymentCustomizations: { edges: [] }, metafieldDefinitions: { edges: [] } },
            }),
        })
      ),
    };

    function createOnboardingLoaderArgs(shopDomain: string) {
      return {
        request: new Request("https://example.com/app/onboarding"),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: shopDomain },
                admin: mockAdmin,
              }),
            },
          },
          cloudflare: { env: {} },
        },
        params: {},
      } as never;
    }

    interface OnboardingLoaderData {
      state?: {
        steps?: { id: string; status: string }[];
      };
      [key: string]: unknown;
    }

    function extractLoaderData(result: unknown): OnboardingLoaderData {
      if (
        typeof result === "object" &&
        result !== null &&
        "data" in result
      ) {
        return (result as { data: OnboardingLoaderData }).data;
      }
      return result as OnboardingLoaderData;
    }

    it("onboarding loader returns reminders step 'complete' when DB has enabled=true", async () => {
      await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_A_ID}`;
      await sql`
        INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
        VALUES (${SHOP_A_ID}, true, NOW(), NOW())
      `;

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.doMock("~/lib/initial-sync.server", () => ({
        getInitialSyncState: vi.fn().mockResolvedValue({ status: "done" }),
        getInitialSyncStateWithRecovery: vi.fn().mockResolvedValue({ status: "done" }),
        enqueueInitialSync: vi.fn(),
        canStartSync: vi.fn().mockReturnValue(false),
      }));

      vi.doMock("~/services/shop-currency-recovery.server", () => ({
        checkAndRecoverCurrency: vi.fn().mockResolvedValue({ currency: "INR", flipBlocked: false }),
      }));

      vi.doMock("~/lib/shop-currency.server", () => ({
        isShopCurrencySupported: vi.fn().mockReturnValue(true),
        NO_CURRENCY_SENTINEL: "__NO_CURRENCY__",
      }));

      vi.doMock("~/lib/email-sender-config.server", () => ({
        isEmailSendingConfigured: vi.fn().mockReturnValue(true),
      }));

      vi.resetModules();

      const { loader } = await import("../app.onboarding");
      const result = await loader(createOnboardingLoaderArgs(SHOP_A_DOMAIN));

      const data = extractLoaderData(result);
      expect(data).toBeDefined();
      expect(data.state?.steps).toBeDefined();
      const remindersStep = data.state?.steps?.find((s) => s.id === "reminders");
      expect(remindersStep?.status).toBe("complete");
    });

    it("onboarding loader returns reminders step 'pending' when DB has enabled=false", async () => {
      await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_A_ID}`;
      await sql`
        INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
        VALUES (${SHOP_A_ID}, false, NOW(), NOW())
      `;

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.doMock("~/lib/initial-sync.server", () => ({
        getInitialSyncState: vi.fn().mockResolvedValue({ status: "done" }),
        getInitialSyncStateWithRecovery: vi.fn().mockResolvedValue({ status: "done" }),
        enqueueInitialSync: vi.fn(),
        canStartSync: vi.fn().mockReturnValue(false),
      }));

      vi.doMock("~/services/shop-currency-recovery.server", () => ({
        checkAndRecoverCurrency: vi.fn().mockResolvedValue({ currency: "INR", flipBlocked: false }),
      }));

      vi.doMock("~/lib/shop-currency.server", () => ({
        isShopCurrencySupported: vi.fn().mockReturnValue(true),
        NO_CURRENCY_SENTINEL: "__NO_CURRENCY__",
      }));

      vi.doMock("~/lib/email-sender-config.server", () => ({
        isEmailSendingConfigured: vi.fn().mockReturnValue(true),
      }));

      vi.resetModules();

      const { loader } = await import("../app.onboarding");
      const result = await loader(createOnboardingLoaderArgs(SHOP_A_DOMAIN));

      const data = extractLoaderData(result);
      expect(data).toBeDefined();
      expect(data.state?.steps).toBeDefined();
      const remindersStep = data.state?.steps?.find((s) => s.id === "reminders");
      expect(remindersStep?.status).toBe("pending");
    });
  });

  describe("5. Buyer account overrides: shop isolation", () => {
    function createAccountActionArgs(shopDomain: string, accountId: string, formData: FormData) {
      return {
        request: new Request(`https://example.com/app/accounts/${accountId}`, {
          method: "POST",
          body: formData,
        }),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({ session: { shop: shopDomain } }),
            },
          },
          cloudflare: {
            env: {},
            ctx: { waitUntil: vi.fn() },
          },
        },
        params: { id: accountId },
      } as unknown;
    }

    async function getAccountSnapshot(accountId: string) {
      return sql<{ creditLimit: number; holdState: string }[]>`
        SELECT "creditLimit"::numeric as "creditLimit", "holdState" FROM "BuyerAccount"
        WHERE id = ${accountId}
      `;
    }

    it("foreign account id from shop B gives 'Account not found' error for shop A session", async () => {
      const snapshotBefore = await getAccountSnapshot(ACCOUNT_B_ID);

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();
      const creditStatusModule = await import("~/services/credit-status.server");
      const mockUpdate = vi.mocked(creditStatusModule.updateCreditStatus);
      mockUpdate.mockClear();

      const formData = new FormData();
      formData.set("_action", "updateCredit");
      formData.set("creditLimit", "999999");

      const { action } = await import("../app.accounts.$id");
      const result = await action(createAccountActionArgs(SHOP_A_DOMAIN, ACCOUNT_B_ID, formData) as never);

      const data = extractActionData(result);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Account not found");

      expect(mockUpdate).not.toHaveBeenCalled();

      const snapshotAfter = await getAccountSnapshot(ACCOUNT_B_ID);
      expect(snapshotAfter).toEqual(snapshotBefore);
    });

    it("same-shop account update succeeds", async () => {
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();
      const creditStatusModule = await import("~/services/credit-status.server");
      const mockUpdate = vi.mocked(creditStatusModule.updateCreditStatus);
      mockUpdate.mockClear();
      mockUpdate.mockResolvedValue({ success: true });

      const formData = new FormData();
      formData.set("_action", "updateCredit");
      formData.set("creditLimit", "50000");

      const { action } = await import("../app.accounts.$id");
      const result = await action(createAccountActionArgs(SHOP_A_DOMAIN, ACCOUNT_A_ID, formData) as never);

      const data = extractActionData(result);
      expect(data.success).toBe(true);
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.anything(),
        ACCOUNT_A_ID,
        expect.objectContaining({ creditLimitAmount: 50000 })
      );
    });

    it("hold toggle from shop A session on shop B's account is rejected, shop B unchanged", async () => {
      const snapshotBefore = await sql<{ holdState: string; manualHold: boolean }[]>`
        SELECT "holdState", "manualHold" FROM "BuyerAccount"
        WHERE id = ${ACCOUNT_B_ID}
      `;

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();
      const creditStatusModule = await import("~/services/credit-status.server");
      const mockUpdate = vi.mocked(creditStatusModule.updateCreditStatus);
      mockUpdate.mockClear();

      const formData = new FormData();
      formData.set("_action", "updateCredit");
      formData.set("holdOnly", "true");
      formData.set("manualHold", "true");
      formData.set("holdReasonCode", "MANUAL_HOLD");

      const { action } = await import("../app.accounts.$id");
      const result = await action(createAccountActionArgs(SHOP_A_DOMAIN, ACCOUNT_B_ID, formData) as never);

      const data = extractActionData(result);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Account not found");

      expect(mockUpdate).not.toHaveBeenCalled();

      const snapshotAfter = await sql<{ holdState: string; manualHold: boolean }[]>`
        SELECT "holdState", "manualHold" FROM "BuyerAccount"
        WHERE id = ${ACCOUNT_B_ID}
      `;
      expect(snapshotAfter).toEqual(snapshotBefore);
    });
  });

  describe("6. Session required and GET rejection", () => {
    it("tag rules action rejects GET request with no AccountSource written", async () => {
      const snapshotBefore = await sql<{ id: string }[]>`
        SELECT id FROM "AccountSource" WHERE "shopId" = ${SHOP_TAG_ID}
      `;

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();
      const { action } = await import("../app.tag-rules");

      const result = await action({
        request: new Request("https://example.com/app/tag-rules", {
          method: "GET",
        }),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({ session: { shop: SHOP_TAG_DOMAIN } }),
            },
          },
        },
        params: {},
        url: new URL("https://example.com/app/tag-rules"),
        pattern: "/app/tag-rules",
      } as never);

      const status = extractStatus(result);
      expect(status).toBe(400);

      const resultData = extractActionData(result);
      expect(resultData.success).toBe(false);
      expect(resultData.error).toBe("Invalid request body");

      const snapshotAfter = await sql<{ id: string }[]>`
        SELECT id FROM "AccountSource" WHERE "shopId" = ${SHOP_TAG_ID}
      `;
      expect(snapshotAfter).toEqual(snapshotBefore);
    });

    it("account action throws when session auth fails (simulating unauthenticated)", async () => {
      const formData = new FormData();
      formData.set("_action", "updateCredit");
      formData.set("creditLimit", "50000");

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();

      const { action } = await import("../app.accounts.$id");

      await expect(
        action({
          request: new Request(`https://example.com/app/accounts/${ACCOUNT_A_ID}`, {
            method: "POST",
            body: formData,
          }),
          context: {
            shopify: {
              authenticate: {
                admin: vi.fn().mockRejectedValue(new Error("Unauthorized")),
              },
            },
            cloudflare: { env: {}, ctx: { waitUntil: vi.fn() } },
          },
          params: { id: ACCOUNT_A_ID },
        } as never)
      ).rejects.toThrow("Unauthorized");
    });

    it("tag rules action throws when session auth fails", async () => {
      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", "test");
      formData.append("defaultTermsDays", "30");

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();

      const { action } = await import("../app.tag-rules");

      await expect(
        action({
          request: new Request("https://example.com/app/tag-rules", {
            method: "POST",
            body: formData,
          }),
          context: {
            shopify: {
              authenticate: {
                admin: vi.fn().mockRejectedValue(new Error("Unauthorized")),
              },
            },
          },
          params: {},
          url: new URL("https://example.com/app/tag-rules"),
          pattern: "/app/tag-rules",
        } as never)
      ).rejects.toThrow("Unauthorized");
    });

    it("reminders action throws when session auth fails", async () => {
      const formData = new FormData();
      formData.append("intent", "toggle_enabled");
      formData.append("enabled", "true");

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();

      const { action } = await import("../app.settings.reminders");

      await expect(
        action({
          request: new Request("https://example.com/app/settings/reminders", {
            method: "POST",
            body: formData,
          }),
          context: {
            shopify: {
              authenticate: {
                admin: vi.fn().mockRejectedValue(new Error("Unauthorized")),
              },
            },
            cloudflare: { env: {} },
          },
          params: {},
          url: new URL("https://example.com/app/settings/reminders"),
          pattern: "/app/settings/reminders",
        } as never)
      ).rejects.toThrow("Unauthorized");
    });

    it("account loader does not mutate DB (read-only)", async () => {
      const snapshotBefore = await sql<{ creditLimit: number }[]>`
        SELECT "creditLimit"::numeric as "creditLimit" FROM "BuyerAccount"
        WHERE id = ${ACCOUNT_A_ID}
      `;

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
        getRequestWaitUntil: () => undefined,
      }));

      vi.resetModules();
      const { loader } = await import("../app.accounts.$id");
      await loader({
        request: new Request(`https://example.com/app/accounts/${ACCOUNT_A_ID}`),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: SHOP_A_DOMAIN },
                sessionToken: null,
              }),
            },
          },
          cloudflare: { env: {}, ctx: { waitUntil: vi.fn() } },
        },
        params: { id: ACCOUNT_A_ID },
      } as never);

      const snapshotAfter = await sql<{ creditLimit: number }[]>`
        SELECT "creditLimit"::numeric as "creditLimit" FROM "BuyerAccount"
        WHERE id = ${ACCOUNT_A_ID}
      `;
      expect(snapshotAfter).toEqual(snapshotBefore);
    });
  });
});
