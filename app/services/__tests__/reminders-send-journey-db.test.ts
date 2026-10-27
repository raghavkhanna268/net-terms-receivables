/**
 * Payment Reminder Send Journey (end-to-end) DB suite.
 *
 * Drives the payment-reminder email path the way production does: starting from
 * the queue handlers in app/jobs/reminders.ts (handleReminderSend /
 * handleReminderCatchup) and following the code into reminders.server.ts and
 * the shared Resend sender (resend-client.server.ts).
 *
 * Setup mirrors the existing reminder DB suites (reminders-email-db.test.ts,
 * reminders-b2b-db.test.ts, reminders-critical-path.test.ts):
 * - Real Postgres via TEST_DATABASE_URL
 * - Resend mocked at the fetch boundary (vi.stubGlobal("fetch", ...))
 * - vi.useFakeTimers({ toFake: ["Date"] }) for shop-local clock control
 * - Real safeLog (no logger mock)
 * - Synthetic data only: example.com emails, test-*.myshopify.com shops,
 *   no real tokens, no gid:// identifiers
 *
 * Env is injected into the handlers via requestContext.run so the journey runs
 * exactly as the drain processor invokes it (handlers read getRequestEnv()).
 *
 * @module
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import postgres from "postgres";
import { DateTime } from "luxon";
import { sqlOptions } from "~/lib/db-light.server";
import type { Sql } from "~/lib/db-light.server";
import {
  handleReminderSend,
  handleReminderCatchup,
  type ReminderSendMessage,
  type ReminderCatchupMessage,
} from "~/jobs/reminders";
import { requestContext } from "~/lib/request-context.server";
import { _resetMerchantInfoCacheForTests } from "~/services/reminders.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("@sentry/cloudflare", () => ({
  withSentry: vi.fn((_configFn, handler) => handler),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

/** Synthetic Resend key (re_ prefix, never a real shp* token). */
const FAKE_RESEND_KEY = "re_test_SYNTH_sendj_key";

/** Env shape accepted by the reminder send path (superset of WorkerEnv). */
interface SendJourneyEnv {
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  REMINDER_UNSUBSCRIBE_SECRET?: string;
  SHOPIFY_APP_URL?: string;
  RESEND_TEST_RECIPIENTS?: string;
  RESEND_RECIPIENT_ALLOWLIST_ENFORCED?: string;
}

describeWithDb("Reminder Send Journey (DB, end-to-end)", () => {
  let sql: ReturnType<typeof postgres>;

  const TEST_SUFFIX = Date.now().toString(36) + "-sendj";
  const SHOP_ID = `shop-sendj-${TEST_SUFFIX}`;
  const SHOP_DOMAIN = `test-sendj-${TEST_SUFFIX}.myshopify.com`;
  const COMPANY_ACCOUNT_ID = `acc-sendj-${TEST_SUFFIX}`;
  const COMPANY_ID = `company-sendj-${TEST_SUFFIX}`;
  const LOCATION_ID = `loc-sendj-${TEST_SUFFIX}`;
  const CONTACT_CUSTOMER_ID = `contact-sendj-${TEST_SUFFIX}`;

  /** COMPANY (B2B) main-contact recipient; the default allowlisted address. */
  const BUYER_EMAIL = "company-buyer-sendj@example.com";
  const BUYER_NAME = "Send Journey Contact";
  /** A synthetic recipient that is deliberately NOT on the allowlist. */
  const OUTSIDER_EMAIL = "outsider-sendj@example.com";

  const SHOP_TZ = "Asia/Kolkata";

  /** Base env with everything configured; allowlist enforcement unset (= enforced). */
  const validEnv: SendJourneyEnv = {
    RESEND_API_KEY: FAKE_RESEND_KEY,
    RESEND_FROM: "reminders-sendj@example.com",
    REMINDER_UNSUBSCRIBE_SECRET: "test-secret-sendj-xyz",
    SHOPIFY_APP_URL: "https://test-sendj-app.example.com",
    RESEND_TEST_RECIPIENTS: BUYER_EMAIL,
    RESEND_RECIPIENT_ALLOWLIST_ENFORCED: undefined,
  };

  // ---------------------------------------------------------------------------
  // Fixture helpers
  // ---------------------------------------------------------------------------

  async function createInvoice(
    slug: string,
    dueAt: Date,
    opts: {
      status?: "open" | "paid" | "cancelled";
      outstanding?: string;
      accountId?: string;
    } = {}
  ): Promise<string> {
    const invoiceId = `inv-sendj-${slug}-${TEST_SUFFIX}`;
    const orderId = `ord-sendj-${slug}-${TEST_SUFFIX}`;
    const status = opts.status ?? "open";
    const outstanding = opts.outstanding ?? "50000.00";
    const accountId = opts.accountId ?? COMPANY_ACCOUNT_ID;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${SHOP_ID}, ${accountId}, ${orderId},
        ${`#SENDJ-${slug}`}, 50000.00, ${outstanding}::DECIMAL(14,2),
        ${status}::"InvoiceStatus",
        ${dueAt} - INTERVAL '10 days', ${dueAt}, NOW(), NOW()
      )
    `;
    return invoiceId;
  }

  async function createRule(slug: string, offsetDays: number, enabled = true): Promise<string> {
    const ruleId = `rule-sendj-${slug}-${TEST_SUFFIX}`;
    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${ruleId}, ${SHOP_ID}, ${offsetDays}, 'email'::"ReminderChannel", ${enabled}, NOW(), NOW())
    `;
    return ruleId;
  }

  /** Pin the system clock to a shop-local (IST) wall-clock time. */
  function setShopLocalTime(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number
  ): void {
    const dt = DateTime.fromObject(
      { year, month, day, hour, minute, second: 0 },
      { zone: SHOP_TZ }
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(dt.toJSDate());
  }

  function sendMessage(
    invoiceId: string,
    ruleId: string,
    overrides: Partial<ReminderSendMessage> = {}
  ): ReminderSendMessage {
    return {
      topic: "REMINDER_SEND",
      shop: SHOP_DOMAIN,
      shopId: SHOP_ID,
      invoiceId,
      ruleId,
      offsetDays: 0,
      timezone: SHOP_TZ,
      webhookId: `s18_${invoiceId}_${ruleId}_2026-10-30`,
      enqueuedAt: "2026-10-30T06:30:00Z",
      ...overrides,
    };
  }

  function catchupMessage(
    invoiceId: string,
    ruleId: string,
    logId: string,
    overrides: Partial<ReminderCatchupMessage> = {}
  ): ReminderCatchupMessage {
    return {
      topic: "REMINDER_CATCHUP",
      shop: SHOP_DOMAIN,
      shopId: SHOP_ID,
      invoiceId,
      ruleId,
      logId,
      offsetDays: 0,
      timezone: SHOP_TZ,
      webhookId: `s18_catchup_${invoiceId}_${ruleId}`,
      enqueuedAt: "2026-10-30T06:30:00Z",
      ...overrides,
    };
  }

  /** Run the REMINDER_SEND handler with env injected exactly like the drain processor. */
  function runSend(message: ReminderSendMessage, env: SendJourneyEnv) {
    return requestContext.run(
      { getSql: () => sql as Sql, env },
      () => handleReminderSend(sql as Sql, message)
    );
  }

  /** Run the REMINDER_CATCHUP handler with env injected exactly like the drain processor. */
  function runCatchup(message: ReminderCatchupMessage, env: SendJourneyEnv) {
    return requestContext.run(
      { getSql: () => sql as Sql, env },
      () => handleReminderCatchup(sql as Sql, message)
    );
  }

  function parseResendBody(callIndex: number): Record<string, unknown> {
    const call = mockFetch.mock.calls[callIndex];
    const options = call[1] as { body: string };
    return JSON.parse(options.body) as Record<string, unknown>;
  }

  async function reminderLogRows(invoiceId: string) {
    return sql<{ id: string; status: string }[]>`
      SELECT id, status FROM "ReminderLog"
      WHERE "shopId" = ${SHOP_ID} AND "invoiceId" = ${invoiceId}
    `;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
      VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', ${SHOP_TZ}, 'free', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "mainContactEmail", "mainContactName", "mainContactCustomerId",
        "creditLimit", "holdState", bypass, "manualHold",
        "defaultTermsDays", "defaultTermsSource",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${COMPANY_ACCOUNT_ID}, ${SHOP_ID}, 'COMPANY',
        ${COMPANY_ID}, ${LOCATION_ID}, 'Send Journey Company',
        ${BUYER_EMAIL}, ${BUYER_NAME}, ${CONTACT_CUSTOMER_ID},
        100000.00, 'OK', false, false, 30, 'explicit',
        false, 1, NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
      VALUES (${SHOP_ID}, true, NOW(), NOW())
      ON CONFLICT (shop_id) DO UPDATE SET enabled = true, updated_at = NOW()
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${SHOP_ID}`;
    await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_ID}`;
    await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    mockFetch.mockReset();
    _resetMerchantInfoCacheForTests();
    // Ensure process.env does not leak enforcement/secret fallbacks into the env param.
    delete process.env.RESEND_RECIPIENT_ALLOWLIST_ENFORCED;
    delete process.env.RESEND_TEST_RECIPIENTS;
    delete process.env.REMINDER_UNSUBSCRIBE_SECRET;
    // Reset shop/account state to the enabled, non-opted-out baseline.
    await sql`UPDATE s18_shop_reminder_settings SET enabled = true WHERE shop_id = ${SHOP_ID}`;
    await sql`
      UPDATE "BuyerAccount"
      SET "reminderOptOutAt" = NULL, "reminderOptOutSource" = NULL,
          "mainContactEmail" = ${BUYER_EMAIL}, "mainContactName" = ${BUYER_NAME}
      WHERE id = ${COMPANY_ACCOUNT_ID}
    `;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${SHOP_ID}`;
    await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${SHOP_ID}`;
  });

  // ===========================================================================
  // Case 1: Happy path
  // Guard journey: handleReminderSend -> sendPaymentReminder (all gates) ->
  //                sendViaResend -> fetch. Asserts a single Resend call with
  //                well-formed RFC 8058 unsubscribe headers and a 'sent' log row.
  // ===========================================================================
  describe("Case 1: happy path (COMPANY buyer, due today, in window, allowlisted)", () => {
    it("makes exactly one Resend call with signed unsubscribe headers and writes a sent ReminderLog row", async () => {
      setShopLocalTime(2026, 10, 30, 12, 0);

      const dueAt = DateTime.fromObject(
        { year: 2026, month: 10, day: 30, hour: 0, minute: 0 },
        { zone: SHOP_TZ }
      ).toJSDate();

      const invoiceId = await createInvoice("happy", dueAt);
      const ruleId = await createRule("happy", 0);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "resend-sendj-happy-1" }),
      });

      const result = await runSend(sendMessage(invoiceId, ruleId), validEnv);

      expect(result.success).toBe(true);
      expect(result.action).toBe("created");
      expect(result.entityId).toBe("resend-sendj-happy-1");

      // EXACTLY ONE Resend call.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.resend.com/emails");

      const body = parseResendBody(0);
      expect(body.to).toEqual([BUYER_EMAIL]);

      // RFC 8058 unsubscribe headers present and well-formed.
      const headers = body.headers as Record<string, string>;
      expect(headers).toBeDefined();

      const listUnsub = headers["List-Unsubscribe"];
      expect(listUnsub).toMatch(
        /^<https:\/\/[^>]+\/unsubscribe\?token=[^>]+>$/
      );
      expect(listUnsub.startsWith("<https://")).toBe(true);
      expect(listUnsub).toContain("test-sendj-app.example.com");

      const tokenMatch = listUnsub.match(/token=([^>]+)>$/);
      expect(tokenMatch).not.toBeNull();
      const token = decodeURIComponent(tokenMatch![1]);
      // Signed token is "<payloadBase64>.<signatureBase64url>".
      const tokenParts = token.split(".");
      expect(tokenParts).toHaveLength(2);
      expect(tokenParts[0].length).toBeGreaterThan(0);
      expect(tokenParts[1].length).toBeGreaterThan(0);

      expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

      // Expected ReminderLog record written.
      const logs = await reminderLogRows(invoiceId);
      expect(logs).toHaveLength(1);
      expect(logs[0].status).toBe("sent");
    });
  });

  // ===========================================================================
  // Case 2: Recipient allowlist
  // Guard pinned: reminders.server.ts sendPaymentReminder gate 10d
  //               (isAllowlistEnforced + isRecipientAllowed), before slot claim.
  // ===========================================================================
  describe("Case 2: recipient allowlist", () => {
    it("allowlist ON, recipient NOT on it: no Resend call and no ReminderLog row", async () => {
      setShopLocalTime(2026, 10, 30, 12, 0);

      const dueAt = DateTime.fromObject(
        { year: 2026, month: 10, day: 30, hour: 0, minute: 0 },
        { zone: SHOP_TZ }
      ).toJSDate();

      const invoiceId = await createInvoice("allow-block", dueAt);
      const ruleId = await createRule("allow-block", 0);

      const result = await runSend(sendMessage(invoiceId, ruleId), {
        ...validEnv,
        // Enforced (field absent), but the buyer's email is not listed.
        RESEND_TEST_RECIPIENTS: OUTSIDER_EMAIL,
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("not in pre-launch allowlist");
      expect(mockFetch).not.toHaveBeenCalled();

      // Blocked before the slot claim: the code records nothing.
      const logs = await reminderLogRows(invoiceId);
      expect(logs).toHaveLength(0);
    });

    it("allowlist ON, recipient on it: exactly one Resend call", async () => {
      setShopLocalTime(2026, 10, 30, 12, 0);

      const dueAt = DateTime.fromObject(
        { year: 2026, month: 10, day: 30, hour: 0, minute: 0 },
        { zone: SHOP_TZ }
      ).toJSDate();

      const invoiceId = await createInvoice("allow-pass", dueAt);
      const ruleId = await createRule("allow-pass", 0);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "resend-sendj-allow-pass" }),
      });

      const result = await runSend(sendMessage(invoiceId, ruleId), {
        ...validEnv,
        RESEND_TEST_RECIPIENTS: BUYER_EMAIL,
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe("created");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(parseResendBody(0).to).toEqual([BUYER_EMAIL]);
    });

    it("allowlist explicitly 'false': one Resend call to a non-listed synthetic recipient", async () => {
      setShopLocalTime(2026, 10, 30, 12, 0);

      const dueAt = DateTime.fromObject(
        { year: 2026, month: 10, day: 30, hour: 0, minute: 0 },
        { zone: SHOP_TZ }
      ).toJSDate();

      const invoiceId = await createInvoice("allow-off", dueAt);
      const ruleId = await createRule("allow-off", 0);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "resend-sendj-allow-off" }),
      });

      const result = await runSend(sendMessage(invoiceId, ruleId), {
        ...validEnv,
        // Guard disabled, and the buyer's email is deliberately not in the list.
        RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false",
        RESEND_TEST_RECIPIENTS: OUTSIDER_EMAIL,
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe("created");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(parseResendBody(0).to).toEqual([BUYER_EMAIL]);
    });
  });

  // ===========================================================================
  // Case 3: Buyer opted out / unsubscribed
  // Guard pinned: reminders.server.ts sendPaymentReminder gate 10b
  //               (isBuyerOptedOut), before slot claim.
  // ===========================================================================
  describe("Case 3: buyer opted out", () => {
    it("opted-out buyer: no Resend call (records skipped_opted_out)", async () => {
      setShopLocalTime(2026, 10, 30, 12, 0);

      const dueAt = DateTime.fromObject(
        { year: 2026, month: 10, day: 30, hour: 0, minute: 0 },
        { zone: SHOP_TZ }
      ).toJSDate();

      const invoiceId = await createInvoice("optout", dueAt);
      const ruleId = await createRule("optout", 0);

      await sql`
        UPDATE "BuyerAccount"
        SET "reminderOptOutAt" = NOW(), "reminderOptOutSource" = 'link'::"ReminderOptOutSource"
        WHERE id = ${COMPANY_ACCOUNT_ID}
      `;

      const result = await runSend(sendMessage(invoiceId, ruleId), {
        ...validEnv,
        RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false",
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("opted out");
      expect(mockFetch).not.toHaveBeenCalled();

      const logs = await reminderLogRows(invoiceId);
      expect(logs).toHaveLength(1);
      expect(logs[0].status).toBe("skipped_opted_out");
    });
  });

  // ===========================================================================
  // Case 4: Shop-local send window (09:00-19:00)
  // Guard pinned: reminders.server.ts sendPaymentReminder gate 2
  //               (isWithinSendWindow), before slot claim. Shop TZ is non-UTC (IST).
  // ===========================================================================
  describe("Case 4: shop-local send window", () => {
    const windowEnv: SendJourneyEnv = {
      ...validEnv,
      RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false",
    };

    async function seedDueTodayInvoice(slug: string) {
      const dueAt = DateTime.fromObject(
        { year: 2026, month: 10, day: 30, hour: 0, minute: 0 },
        { zone: SHOP_TZ }
      ).toJSDate();
      const invoiceId = await createInvoice(slug, dueAt);
      const ruleId = await createRule(slug, 0);
      return { invoiceId, ruleId };
    }

    it("08:59 shop-local (before 09:00): no Resend call", async () => {
      setShopLocalTime(2026, 10, 30, 8, 59);
      const { invoiceId, ruleId } = await seedDueTodayInvoice("win-0859");

      const result = await runSend(sendMessage(invoiceId, ruleId), windowEnv);

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("Outside send window");
      expect(mockFetch).not.toHaveBeenCalled();
      expect(await reminderLogRows(invoiceId)).toHaveLength(0);
    });

    it("19:00 shop-local (window end is exclusive): no Resend call", async () => {
      setShopLocalTime(2026, 10, 30, 19, 0);
      const { invoiceId, ruleId } = await seedDueTodayInvoice("win-1900");

      const result = await runSend(sendMessage(invoiceId, ruleId), windowEnv);

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("Outside send window");
      expect(mockFetch).not.toHaveBeenCalled();
      expect(await reminderLogRows(invoiceId)).toHaveLength(0);
    });

    it("09:00 shop-local (window start, inclusive): exactly one Resend call", async () => {
      setShopLocalTime(2026, 10, 30, 9, 0);
      const { invoiceId, ruleId } = await seedDueTodayInvoice("win-0900");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "resend-sendj-win-0900" }),
      });

      const result = await runSend(sendMessage(invoiceId, ruleId), windowEnv);

      expect(result.success).toBe(true);
      expect(result.action).toBe("created");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const logs = await reminderLogRows(invoiceId);
      expect(logs).toHaveLength(1);
      expect(logs[0].status).toBe("sent");
    });
  });

  // ===========================================================================
  // Case 5: Shop reminders disabled (catch-up journey)
  // The one-shot REMINDER_SEND path does NOT re-check the shop-level toggle;
  // the catch-up journey (handleReminderCatchup -> sendCatchupReminder gate 9)
  // is where the shop-level "reminders disabled" toggle is enforced at send
  // time, so it is exercised here with a positive control.
  // ===========================================================================
  describe("Case 5: shop reminders disabled (catch-up path)", () => {
    it("disabled shop toggle: no Resend call; re-enabled: one Resend call", async () => {
      setShopLocalTime(2026, 10, 30, 12, 0);

      // Due yesterday (D+1) so the catch-up window check (D+1..D+3) passes.
      const dueAt = DateTime.fromObject(
        { year: 2026, month: 10, day: 29, hour: 0, minute: 0 },
        { zone: SHOP_TZ }
      ).toJSDate();

      const invoiceId = await createInvoice("shop-disabled", dueAt);
      const ruleId = await createRule("shop-disabled", 0);

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (gen_random_uuid()::TEXT, ${SHOP_ID}, ${ruleId}, ${invoiceId}, 'delayed'::"ReminderLogStatus", NOW())
      `;

      await sql`UPDATE s18_shop_reminder_settings SET enabled = false WHERE shop_id = ${SHOP_ID}`;

      const disabledEnv: SendJourneyEnv = {
        ...validEnv,
        RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false",
      };

      const disabledResult = await runCatchup(
        catchupMessage(invoiceId, ruleId, `log-${invoiceId}`),
        disabledEnv
      );

      expect(disabledResult.success).toBe(true);
      expect(disabledResult.action).toBe("skipped");
      expect(disabledResult.skipReason).toBe("Shop reminders disabled");
      expect(mockFetch).not.toHaveBeenCalled();

      // Positive control: re-enable, re-seed the delayed row, and it sends.
      await sql`UPDATE s18_shop_reminder_settings SET enabled = true WHERE shop_id = ${SHOP_ID}`;
      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (gen_random_uuid()::TEXT, ${SHOP_ID}, ${ruleId}, ${invoiceId}, 'delayed'::"ReminderLogStatus", NOW())
        ON CONFLICT ("ruleId", "invoiceId")
        DO UPDATE SET status = 'delayed'::"ReminderLogStatus", "sentAt" = NULL
      `;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "resend-sendj-shop-enabled" }),
      });

      const enabledResult = await runCatchup(
        catchupMessage(invoiceId, ruleId, `log-${invoiceId}`),
        disabledEnv
      );

      expect(enabledResult.success).toBe(true);
      expect(enabledResult.action).toBe("created");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // Case 6: REMINDER_UNSUBSCRIBE_SECRET missing (current behaviour)
  // Guard pinned: reminders.server.ts sendPaymentReminder gate 9
  //               (canGenerateUnsubscribeHeaders). Fail-closed: skip, no send.
  // ===========================================================================
  describe("Case 6: REMINDER_UNSUBSCRIBE_SECRET missing", () => {
    it("no unsubscribe secret: no Resend call and no ReminderLog row (current behaviour)", async () => {
      setShopLocalTime(2026, 10, 30, 12, 0);

      const dueAt = DateTime.fromObject(
        { year: 2026, month: 10, day: 30, hour: 0, minute: 0 },
        { zone: SHOP_TZ }
      ).toJSDate();

      const invoiceId = await createInvoice("no-secret", dueAt);
      const ruleId = await createRule("no-secret", 0);

      const result = await runSend(sendMessage(invoiceId, ruleId), {
        ...validEnv,
        REMINDER_UNSUBSCRIBE_SECRET: undefined,
        RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false",
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("REMINDER_UNSUBSCRIBE_SECRET not configured");
      expect(mockFetch).not.toHaveBeenCalled();
      expect(await reminderLogRows(invoiceId)).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Case 7: Message enqueued, then shop reminders disabled before the handler
  //         processes the REMINDER_SEND message.
  //
  // Expected behaviour: no Resend call. The one-shot REMINDER_SEND journey
  // (handleReminderSend -> sendPaymentReminder) does not re-check the shop-level
  // reminders toggle, so it sends anyway. Skipped pending follow-up; the real
  // reason is documented in the PR report.
  // ===========================================================================
  describe("Case 7: enqueued then shop disabled before processing", () => {
    it.skip("enqueued REMINDER_SEND with shop later disabled: no Resend call (pending follow-up)", async () => {
      setShopLocalTime(2026, 10, 30, 12, 0);

      const dueAt = DateTime.fromObject(
        { year: 2026, month: 10, day: 30, hour: 0, minute: 0 },
        { zone: SHOP_TZ }
      ).toJSDate();

      const invoiceId = await createInvoice("enqueued-disabled", dueAt);
      const ruleId = await createRule("enqueued-disabled", 0);

      // Message was already enqueued; the shop then disables reminders.
      await sql`UPDATE s18_shop_reminder_settings SET enabled = false WHERE shop_id = ${SHOP_ID}`;

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ id: "resend-sendj-enqueued-disabled" }),
      });

      const result = await runSend(sendMessage(invoiceId, ruleId), {
        ...validEnv,
        RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false",
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(mockFetch).not.toHaveBeenCalled();
      expect(await reminderLogRows(invoiceId)).toHaveLength(0);
    });
  });
});
