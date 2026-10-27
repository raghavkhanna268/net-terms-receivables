/**
 * Email Content Suite.
 *
 * End-to-end content assertions for EVERY outgoing email the app sends. Each
 * email is produced through its REAL render + send function against the real
 * Postgres database, with the Resend boundary (global fetch) mocked to CAPTURE
 * the exact outgoing payload (from, reply_to, to, subject, html, text,
 * headers). Assertions run on the captured payload.
 *
 * This suite ADDS coverage beyond the existing email tests and does NOT
 * duplicate them:
 *   - #495 app/emails/__tests__/reminder-email-rendering.test.ts
 *       (pure renderPaymentReminderEmail: kinds, placeholder patterns, footer,
 *        XSS escaping of render props, allowlist helper units)
 *   - #503 app/services/__tests__/reminders-email-db.test.ts
 *       (selection at IST boundaries, exclusions, idempotency, #490 trigger,
 *        allowlist enforcement, log redaction)
 *
 * What THIS suite adds (gaps), asserted on the CAPTURED send payload:
 *   (1) INR money Indian-formatted + paise/Decimal unit correctness at the
 *       boundaries (1 paisa, 99 paise, lakh, crore, partial outstanding).
 *   (2) Due date rendered in IST and correct across a UTC day flip, frozen
 *       clock (vi.useFakeTimers / setSystemTime).
 *   (3) Working unsubscribe link: URL taken from the delivered email and
 *       round-tripped through the REAL /unsubscribe route action (token verify)
 *       to actually opt the recipient out; List-Unsubscribe /
 *       List-Unsubscribe-Post header checks.
 *   (4) from / reply_to / subject match RESEND_FROM config + subject templates,
 *       plus a whole-payload (html+text+subject) regex sweep for
 *       {{ }} undefined NaN null [object Object] == zero matches.
 *   (5) Tenant/buyer isolation across two buyers in one shop + a second shop.
 *   (6) HTML injection (shop + buyer names with tags/quotes) escaped in html,
 *       and handled sensibly in text + subject.
 *   (7) Plain-text part: asserted absent where the code sends none (reminders),
 *       and asserted present + parity where the code sends one (data request).
 *
 * =============================================================================
 * EMAIL INVENTORY (every outgoing email, template -> file:line)
 * =============================================================================
 *   A. Payment reminder (due-soon / due-today / overdue)
 *      - render: renderPaymentReminderEmail  app/emails/PaymentReminderEmail.tsx:32
 *      - send:   sendPaymentReminder  app/services/reminders.server.ts:950
 *          (render call :1205, sendViaResend :1242)
 *      - subject: `${getReminderLabel(offsetDays)} - Invoice ${invoiceName}`
 *      - money:  formatAmount(outstanding, currency) via Intl en-IN; Invoice
 *                outstanding/total is Decimal(14,2) in RUPEES (NOT paise), so
 *                Decimal 100000.00 == 10000000 paise == "₹1,00,000.00".
 *      - date:   formatDate(dueAt, shopTimezone) -> Luxon DATE_FULL in shop TZ.
 *      - headers: List-Unsubscribe + List-Unsubscribe-Post (RFC 8058); the
 *                 unsubscribe URL is delivered via the List-Unsubscribe header
 *                 (the html body has no in-body unsubscribe link).
 *      - text:   NO text part is sent (html only).
 *
 *   B. Payment reminder catch-up (same template/subject; D+1..D+3 window)
 *      - send:   sendCatchupReminder  app/services/reminders.server.ts:1343
 *          (render call :1712, sendViaResend :1754)
 *
 *   C. Customer data-request / compliance notice (to shop owner)
 *      - send:   sendDataRequestNotification  app/services/compliance/compliance.server.ts:952
 *          (direct fetch api.resend.com :1041)
 *      - subject: "Customer Data Request Ready for Download"
 *      - body:   notice + admin download link ONLY; NO customer PII, NO money,
 *                NO due date, NO unsubscribe header.
 *      - text:   HAS a text part (html + text).
 *
 * No other Resend/email send sites exist (verified: rg 'sendViaResend|api.resend.com'
 * over app/ returns only the 3 above; plan-welcome.server.ts builds a URL but
 * sends no email).
 *
 * =============================================================================
 * vitest project: this file matches the existing DB_TEST_PATTERNS glob
 * `app/services/__tests__/*-db.test.ts`, so it runs in the "Sequential DB"
 * project. No new DB_TEST_PATTERNS line is required (and none added).
 * =============================================================================
 *
 * Synthetic data only: example.com emails, test-*.myshopify.com shops, opaque
 * ids (no gid:// strings), no registrable domains, no real tokens.
 *
 * @module
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { DateTime } from "luxon";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

// Mock Sentry: reminders/compliance paths import safeLog which may report.
vi.mock("@sentry/cloudflare", () => ({
  withSentry: vi.fn((_configFn, handler) => handler),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

// Mock only shopifyGraphQLQueue so fetchMerchantInfo returns a deterministic
// merchant name + contact email (drives reply_to + footer store name). All
// other exports stay real.
vi.mock("~/services/shopify-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/shopify-client.server")>();
  return { ...actual, shopifyGraphQLQueue: vi.fn() };
});

import {
  sendPaymentReminder,
  sendCatchupReminder,
  getReminderLabel,
  _resetMerchantInfoCacheForTests,
} from "~/services/reminders.server";
import { shopifyGraphQLQueue } from "~/services/shopify-client.server";
import { verifyUnsubscribeToken } from "~/services/reminder-unsubscribe-token.server";
import { isBuyerOptedOut } from "~/services/reminder-optout.server";
import { requestContext } from "~/lib/request-context.server";
import { sendDataRequestNotification } from "~/services/compliance/compliance.server";
import { action as unsubscribeAction } from "~/routes/unsubscribe";

const mockGraphQL = vi.mocked(shopifyGraphQLQueue);

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// --- Synthetic configuration -------------------------------------------------
const RESEND_FROM_VALUE = "reminders@example.com";
const UNSUB_SECRET = "test-ec-unsubscribe-secret-0001";
const APP_URL = "https://app.example.com";
const APP_HANDLE = "test-ec-app-handle";

const reminderEnv = {
  RESEND_API_KEY: "re_test_SYNTH_ec_key",
  RESEND_FROM: RESEND_FROM_VALUE,
  REMINDER_UNSUBSCRIBE_SECRET: UNSUB_SECRET,
  SHOPIFY_APP_URL: APP_URL,
  RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false",
};

const MERCHANT_CONTACT_EMAIL = "merchant-a@example.com";
const MERCHANT_DISPLAY_NAME = "Test Shop One";

const FORBIDDEN_PATTERNS = ["{{", "}}", "undefined", "NaN", "null", "[object Object]"];

describeWithDb("Email Content Suite", () => {
  let sql: ReturnType<typeof postgres>;
  const SUFFIX = Date.now().toString(36) + "-emailcontent";

  const SHOP1_ID = `shop1-${SUFFIX}`;
  const SHOP1_DOMAIN = `test-ec1-${SUFFIX}.myshopify.com`;
  const SHOP2_ID = `shop2-${SUFFIX}`;
  const SHOP2_DOMAIN = `test-ec2-${SUFFIX}.myshopify.com`;

  // Buyer A (shop1), Buyer B (shop1), Buyer C (shop2), Injection buyer (shop1)
  const ACC_A = `accA-${SUFFIX}`;
  const CUST_A = `custA-${SUFFIX}`;
  const EMAIL_A = "buyer-a@example.com";
  const NAME_A = "Alice Buyer";

  const ACC_B = `accB-${SUFFIX}`;
  const CUST_B = `custB-${SUFFIX}`;
  const EMAIL_B = "buyer-b@example.com";
  const NAME_B = "Bob Buyer";

  const ACC_C = `accC-${SUFFIX}`;
  const CUST_C = `custC-${SUFFIX}`;
  const EMAIL_C = "buyer-c@example.com";
  const NAME_C = "Carol Buyer";

  const ACC_INJ = `accInj-${SUFFIX}`;
  const CUST_INJ = `custInj-${SUFFIX}`;
  const EMAIL_INJ = "buyer-inj@example.com";
  const NAME_INJ_DEFAULT = "Injection Buyer";

  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  // --- Helpers ---------------------------------------------------------------

  function istDate(y: number, m: number, d: number, h = 0, min = 0): Date {
    return DateTime.fromObject(
      { year: y, month: m, day: d, hour: h, minute: min, second: 0 },
      { zone: "Asia/Kolkata" }
    ).toJSDate();
  }

  function setISTTime(y: number, m: number, d: number, h: number, min: number) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(istDate(y, m, d, h, min));
  }

  async function seedShop(id: string, domain: string) {
    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
      VALUES (${id}, ${domain}, 'INR', 'Asia/Kolkata', 'free', NOW(), NOW())
    `;
    await sql`
      INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
      VALUES (${id}, true, NOW(), NOW())
      ON CONFLICT (shop_id) DO UPDATE SET enabled = true, updated_at = NOW()
    `;
  }

  async function seedBuyer(
    shopId: string,
    accountId: string,
    customerId: string,
    email: string,
    displayName: string
  ) {
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "customerId", name, "creditLimit", "holdState",
        bypass, "manualHold", "createdAt", "updatedAt"
      )
      VALUES (
        ${accountId}, ${shopId}, 'TAGGED_CUSTOMER', ${customerId},
        ${displayName}, 100000.00, 'OK', false, false, NOW(), NOW()
      )
    `;
    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
      VALUES (${shopId}, ${customerId}, ${email}, ${displayName}, NOW())
      ON CONFLICT (shop_id, customer_id)
      DO UPDATE SET email = ${email}, display_name = ${displayName}, updated_at = NOW()
    `;
  }

  async function createInvoice(opts: {
    shopId: string;
    accountId: string;
    suffix: string;
    name: string;
    total: string;
    outstanding: string;
    dueAt: Date;
    status?: "open" | "paid" | "cancelled";
  }): Promise<string> {
    const invoiceId = `inv-${opts.suffix}-${SUFFIX}`;
    const orderId = `ord-${opts.suffix}-${SUFFIX}`;
    const status = opts.status ?? "open";
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${opts.shopId}, ${opts.accountId}, ${orderId},
        ${opts.name}, ${opts.total}::DECIMAL(14,2), ${opts.outstanding}::DECIMAL(14,2),
        ${status}::"InvoiceStatus",
        ${opts.dueAt} - INTERVAL '10 days', ${opts.dueAt}, NOW(), NOW()
      )
    `;
    return invoiceId;
  }

  async function createRule(shopId: string, suffix: string, offsetDays: number): Promise<string> {
    const ruleId = `rule-${suffix}-${SUFFIX}`;
    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${ruleId}, ${shopId}, ${offsetDays}, 'email'::"ReminderChannel", true, NOW(), NOW())
    `;
    return ruleId;
  }

  /** Last captured Resend POST payload (parsed body + request headers). */
  function capturedResend(): { headers: Record<string, string>; body: Record<string, unknown> } {
    const calls = mockFetch.mock.calls.filter((c) =>
      String(c[0]).includes("api.resend.com/emails")
    );
    expect(calls.length).toBeGreaterThan(0);
    const opts = calls[calls.length - 1][1] as { headers: Record<string, string>; body: string };
    return { headers: opts.headers, body: JSON.parse(opts.body) as Record<string, unknown> };
  }

  function assertNoPlaceholders(parts: Array<string | undefined>) {
    const blob = parts.filter((p): p is string => typeof p === "string").join("\n");
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(blob, `payload must not contain forbidden token ${JSON.stringify(pattern)}`).not.toContain(
        pattern
      );
    }
  }

  function setMerchant(name: string | null, contactEmail: string | null) {
    mockGraphQL.mockResolvedValue({ success: true, retryable: false, data: { shop: { name, contactEmail } } });
  }

  // --- Lifecycle -------------------------------------------------------------

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
    await seedShop(SHOP1_ID, SHOP1_DOMAIN);
    await seedShop(SHOP2_ID, SHOP2_DOMAIN);
    await seedBuyer(SHOP1_ID, ACC_A, CUST_A, EMAIL_A, NAME_A);
    await seedBuyer(SHOP1_ID, ACC_B, CUST_B, EMAIL_B, NAME_B);
    await seedBuyer(SHOP1_ID, ACC_INJ, CUST_INJ, EMAIL_INJ, NAME_INJ_DEFAULT);
    await seedBuyer(SHOP2_ID, ACC_C, CUST_C, EMAIL_C, NAME_C);
  });

  afterAll(async () => {
    for (const shopId of [SHOP1_ID, SHOP2_ID]) {
      await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${shopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${shopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${shopId}`;
    }
    await sql`DELETE FROM s18_global_sends WHERE send_key = 'global'`;
    await sql.end();
  });

  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "resend-synthetic-id" }),
    });
    mockGraphQL.mockReset();
    setMerchant(MERCHANT_DISPLAY_NAME, MERCHANT_CONTACT_EMAIL);
    _resetMerchantInfoCacheForTests();

    vi.stubEnv("RESEND_API_KEY", reminderEnv.RESEND_API_KEY);
    vi.stubEnv("RESEND_FROM", RESEND_FROM_VALUE);
    vi.stubEnv("REMINDER_UNSUBSCRIBE_SECRET", UNSUB_SECRET);
    vi.stubEnv("SHOPIFY_APP_URL", APP_URL);
    vi.stubEnv("RESEND_RECIPIENT_ALLOWLIST_ENFORCED", "false");
    vi.stubEnv("RESEND_TEST_RECIPIENTS", "");
    vi.stubEnv("PLAN_GATING_ENFORCED", "");
    vi.stubEnv("APP_HANDLE", APP_HANDLE);

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Default frozen clock: 12:00 IST on 2 Nov 2026 (inside the 09:00-19:00 window).
    setISTTime(2026, 11, 2, 12, 0);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    for (const shopId of [SHOP1_ID, SHOP2_ID]) {
      await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${shopId}`;
    }
    // Reset buyer opt-out + injection buyer display name to seeded values.
    await sql`
      UPDATE "BuyerAccount" SET "reminderOptOutAt" = NULL, "reminderOptOutSource" = NULL
      WHERE "shopId" IN (${SHOP1_ID}, ${SHOP2_ID})
    `;
    await sql`
      UPDATE s8_tagged_customers SET display_name = ${NAME_INJ_DEFAULT}
      WHERE shop_id = ${SHOP1_ID} AND customer_id = ${CUST_INJ}
    `;
    await sql`
      UPDATE "BuyerAccount" SET name = ${NAME_INJ_DEFAULT}
      WHERE id = ${ACC_INJ}
    `;
  });

  // ===========================================================================
  // A. Payment reminder (sendPaymentReminder)
  // ===========================================================================
  describe("A. Payment reminder (sendPaymentReminder)", () => {
    // ----- (1) INR money formatting + paise/Decimal unit correctness ---------
    // Invoice.outstanding is Decimal(14,2) RUPEES; formatAmount uses Intl en-IN.
    const moneyCases: Array<{ label: string; outstanding: string; expected: string }> = [
      { label: "1 paisa", outstanding: "0.01", expected: "₹0.01" },
      { label: "99 paise", outstanding: "0.99", expected: "₹0.99" },
      { label: "one lakh (Decimal 100000.00 == 10000000 paise)", outstanding: "100000.00", expected: "₹1,00,000.00" },
      { label: "one crore", outstanding: "10000000.00", expected: "₹1,00,00,000.00" },
    ];

    it.each(moneyCases)(
      "(1) formats outstanding $label as $expected in the sent html",
      async ({ label, outstanding, expected }) => {
        const suffix = `money-${label.replace(/[^a-z0-9]+/gi, "")}`;
        const dueAt = istDate(2026, 11, 2);
        const invoiceId = await createInvoice({
          shopId: SHOP1_ID,
          accountId: ACC_A,
          suffix,
          name: `#A-${suffix}`,
          total: outstanding,
          outstanding,
          dueAt,
        });
        const ruleId = await createRule(SHOP1_ID, suffix, 0);

        const result = await sendPaymentReminder(sql, SHOP1_ID, invoiceId, ruleId, 0, "Asia/Kolkata", reminderEnv);
        expect(result.action).toBe("sent");

        const { body } = capturedResend();
        expect(body.html).toContain(expected);
      }
    );

    it("(1) uses the partial OUTSTANDING amount, not the invoice total", async () => {
      // total 50000.00 but outstanding 12345.67 (partial payment made).
      const dueAt = istDate(2026, 11, 2);
      const invoiceId = await createInvoice({
        shopId: SHOP1_ID,
        accountId: ACC_A,
        suffix: "partial",
        name: "#A-PARTIAL",
        total: "50000.00",
        outstanding: "12345.67",
        dueAt,
      });
      const ruleId = await createRule(SHOP1_ID, "partial", 0);

      const result = await sendPaymentReminder(sql, SHOP1_ID, invoiceId, ruleId, 0, "Asia/Kolkata", reminderEnv);
      expect(result.action).toBe("sent");

      const { body } = capturedResend();
      expect(body.html).toContain("₹12,345.67");
      expect(body.html).not.toContain("₹50,000.00");
    });

    // ----- (2) IST due date across a UTC day flip ----------------------------
    it("(2) renders dueAt 2026-11-01T19:00:00Z as the IST day (November 2, 2026), not the UTC day", async () => {
      // 2026-11-01T19:00:00Z == 2026-11-02T00:30 IST. offset 0 => reminder day is
      // the IST due date (Nov 2); frozen clock is 2 Nov 12:00 IST (set in beforeEach).
      const dueAt = new Date("2026-11-01T19:00:00Z");
      const invoiceId = await createInvoice({
        shopId: SHOP1_ID,
        accountId: ACC_A,
        suffix: "tzflip",
        name: "#A-TZ",
        total: "1000.00",
        outstanding: "1000.00",
        dueAt,
      });
      const ruleId = await createRule(SHOP1_ID, "tzflip", 0);

      const result = await sendPaymentReminder(sql, SHOP1_ID, invoiceId, ruleId, 0, "Asia/Kolkata", reminderEnv);
      expect(result.action).toBe("sent");

      const { body } = capturedResend();
      expect(body.html).toContain("November 2, 2026");
      expect(body.html).not.toContain("November 1, 2026");
    });

    // ----- (3) Working unsubscribe link round-trip + headers -----------------
    it("(3) unsubscribe URL from the delivered email round-trips through the real /unsubscribe action and opts the recipient out", async () => {
      const dueAt = istDate(2026, 11, 2);
      const invoiceId = await createInvoice({
        shopId: SHOP1_ID,
        accountId: ACC_A,
        suffix: "unsub",
        name: "#A-UNSUB",
        total: "2000.00",
        outstanding: "2000.00",
        dueAt,
      });
      const ruleId = await createRule(SHOP1_ID, "unsub", 0);

      const result = await sendPaymentReminder(sql, SHOP1_ID, invoiceId, ruleId, 0, "Asia/Kolkata", reminderEnv);
      expect(result.action).toBe("sent");

      const { body } = capturedResend();
      // Unsubscribe URL is delivered via the RFC 8058 List-Unsubscribe header
      // (carried in the Resend request body's `headers` field).
      const sentHeaders = body.headers as Record<string, string>;
      const listUnsub = sentHeaders["List-Unsubscribe"];
      expect(listUnsub).toMatch(/^<https:\/\/app\.example\.com\/unsubscribe\?token=.+>$/);
      const url = listUnsub.slice(1, -1);
      const token = new URL(url).searchParams.get("token")!;
      expect(token.length).toBeGreaterThan(0);

      // Token verifies to exactly this recipient's shop + buyer account.
      expect(verifyUnsubscribeToken(token, UNSUB_SECRET)).toEqual({
        shopId: SHOP1_ID,
        buyerAccountId: ACC_A,
      });

      // Not opted out before.
      expect(await isBuyerOptedOut(sql, SHOP1_ID, ACC_A)).toBe(false);

      // Drive the REAL route action (RFC 8058 one-click POST) under request context.
      const req = new Request(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      });
      const args = { request: req, context: {}, params: {} } as unknown as Parameters<
        typeof unsubscribeAction
      >[0];
      const res = (await requestContext.run({ getSql: () => sql }, () => unsubscribeAction(args))) as {
        success: boolean;
      };
      expect(res.success).toBe(true);

      // Recipient is now opted out.
      expect(await isBuyerOptedOut(sql, SHOP1_ID, ACC_A)).toBe(true);
    });

    it("(3) sets List-Unsubscribe and List-Unsubscribe-Post (RFC 8058) headers", async () => {
      const dueAt = istDate(2026, 11, 2);
      const invoiceId = await createInvoice({
        shopId: SHOP1_ID,
        accountId: ACC_A,
        suffix: "hdr",
        name: "#A-HDR",
        total: "2000.00",
        outstanding: "2000.00",
        dueAt,
      });
      const ruleId = await createRule(SHOP1_ID, "hdr", 0);

      await sendPaymentReminder(sql, SHOP1_ID, invoiceId, ruleId, 0, "Asia/Kolkata", reminderEnv);

      const { body } = capturedResend();
      const sentHeaders = body.headers as Record<string, string>;
      // RFC 2369 angle-bracket https URI + RFC 8058 one-click POST signal.
      expect(sentHeaders["List-Unsubscribe"]).toMatch(
        /^<https:\/\/app\.example\.com\/unsubscribe\?token=[^>]+>$/
      );
      expect(sentHeaders["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    });

    // ----- (4) from / reply_to / subject + placeholder sweep -----------------
    const subjectCases: Array<{ offset: number; dueIST: [number, number, number]; expectedLabel: string }> = [
      { offset: -3, dueIST: [2026, 11, 5], expectedLabel: "Payment due in 3 days" },
      { offset: 0, dueIST: [2026, 11, 2], expectedLabel: "Payment due today" },
      { offset: 7, dueIST: [2026, 10, 26], expectedLabel: "Payment 7 days overdue" },
    ];

    it.each(subjectCases)(
      "(4) from=RESEND_FROM, reply_to=merchant contact, subject uses the template for offset $offset ($expectedLabel)",
      async ({ offset, dueIST, expectedLabel }) => {
        const suffix = `subj-${offset}`;
        const name = `#A-SUBJ-${offset}`;
        const dueAt = istDate(dueIST[0], dueIST[1], dueIST[2]);
        const invoiceId = await createInvoice({
          shopId: SHOP1_ID,
          accountId: ACC_A,
          suffix,
          name,
          total: "3000.00",
          outstanding: "3000.00",
          dueAt,
        });
        const ruleId = await createRule(SHOP1_ID, suffix, offset);

        const result = await sendPaymentReminder(sql, SHOP1_ID, invoiceId, ruleId, offset, "Asia/Kolkata", reminderEnv);
        expect(result.action).toBe("sent");

        const { body } = capturedResend();
        expect(getReminderLabel(offset)).toBe(expectedLabel);
        expect(body.from).toBe(RESEND_FROM_VALUE);
        expect(body.reply_to).toBe(MERCHANT_CONTACT_EMAIL);
        expect(body.subject).toBe(`${expectedLabel} - Invoice ${name}`);
        expect(body.to).toEqual([EMAIL_A]);
      }
    );

    it("(4) whole-payload (html+text+subject) has zero {{ }} undefined NaN null [object Object]", async () => {
      const dueAt = istDate(2026, 11, 2);
      const invoiceId = await createInvoice({
        shopId: SHOP1_ID,
        accountId: ACC_A,
        suffix: "sweep",
        name: "#A-SWEEP",
        total: "4000.00",
        outstanding: "4000.00",
        dueAt,
      });
      const ruleId = await createRule(SHOP1_ID, "sweep", 0);

      await sendPaymentReminder(sql, SHOP1_ID, invoiceId, ruleId, 0, "Asia/Kolkata", reminderEnv);

      const { body } = capturedResend();
      assertNoPlaceholders([body.html as string, body.text as string | undefined, body.subject as string]);
    });

    // ----- (5) Tenant / buyer isolation --------------------------------------
    it("(5) buyer A's email contains only A's name/invoice/amount, none of buyer B's or the second shop's", async () => {
      const dueAt = istDate(2026, 11, 2);
      // A's invoice (the one we send).
      const invA = await createInvoice({
        shopId: SHOP1_ID,
        accountId: ACC_A,
        suffix: "isoA",
        name: "#A-ISO-001",
        total: "11111.11",
        outstanding: "11111.11",
        dueAt,
      });
      const ruleA = await createRule(SHOP1_ID, "isoA", 0);
      // B's invoice in the same shop (not sent) and C's invoice in shop2 (not sent).
      await createInvoice({
        shopId: SHOP1_ID,
        accountId: ACC_B,
        suffix: "isoB",
        name: "#B-ISO-999",
        total: "99999.99",
        outstanding: "99999.99",
        dueAt,
      });
      await createInvoice({
        shopId: SHOP2_ID,
        accountId: ACC_C,
        suffix: "isoC",
        name: "#C-ISO-777",
        total: "77777.77",
        outstanding: "77777.77",
        dueAt,
      });

      const result = await sendPaymentReminder(sql, SHOP1_ID, invA, ruleA, 0, "Asia/Kolkata", reminderEnv);
      expect(result.action).toBe("sent");

      const { body } = capturedResend();
      const html = body.html as string;
      // A present.
      expect(html).toContain(NAME_A);
      expect(html).toContain("#A-ISO-001");
      expect(html).toContain("₹11,111.11");
      expect(body.to).toEqual([EMAIL_A]);
      // B absent.
      expect(html).not.toContain(NAME_B);
      expect(html).not.toContain("#B-ISO-999");
      expect(html).not.toContain("₹99,999.99");
      expect(html).not.toContain(EMAIL_B);
      // Shop2 / Carol absent.
      expect(html).not.toContain(NAME_C);
      expect(html).not.toContain("#C-ISO-777");
      expect(html).not.toContain("₹77,777.77");
    });

    // ----- (6) HTML injection ------------------------------------------------
    it("(6) escapes a script/quote shop name and a tag buyer name in html; subject carries invoice name as plain text; no text part", async () => {
      const maliciousShop = `<script>alert(1)</script>&"'`;
      const maliciousBuyer = `<img src=x onerror="alert(1)">&"'`;
      const invoiceName = `#INJ-<b>001</b>`;

      setMerchant(maliciousShop, MERCHANT_CONTACT_EMAIL);
      await sql`
        UPDATE s8_tagged_customers SET display_name = ${maliciousBuyer}
        WHERE shop_id = ${SHOP1_ID} AND customer_id = ${CUST_INJ}
      `;

      const dueAt = istDate(2026, 11, 2);
      const invoiceId = await createInvoice({
        shopId: SHOP1_ID,
        accountId: ACC_INJ,
        suffix: "inj",
        name: invoiceName,
        total: "5000.00",
        outstanding: "5000.00",
        dueAt,
      });
      const ruleId = await createRule(SHOP1_ID, "inj", 0);

      const result = await sendPaymentReminder(sql, SHOP1_ID, invoiceId, ruleId, 0, "Asia/Kolkata", reminderEnv);
      expect(result.action).toBe("sent");

      const { body } = capturedResend();
      const html = body.html as string;

      // Buyer name escaped, raw tag absent.
      expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
      expect(html).not.toContain("<img src=x onerror=");
      // Shop name escaped, raw script absent.
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(html).not.toContain("<script>alert(1)</script>");
      // Ampersand / quote / apostrophe escaped.
      expect(html).toContain("&amp;");
      expect(html).toContain("&quot;");
      expect(html).toContain("&#39;");
      // Invoice name escaped in html body.
      expect(html).toContain("#INJ-&lt;b&gt;001&lt;/b&gt;");

      // Subject is plain text (not HTML): invoice name carried verbatim is sensible.
      expect(body.subject).toBe(`Payment due today - Invoice ${invoiceName}`);

      // No text part is sent for reminders.
      expect(body.text).toBeUndefined();
    });

    // ----- (7) Plain-text part absent for reminders --------------------------
    it("(7) reminders send html only (no plain-text part)", async () => {
      const dueAt = istDate(2026, 11, 2);
      const invoiceId = await createInvoice({
        shopId: SHOP1_ID,
        accountId: ACC_A,
        suffix: "notext",
        name: "#A-NOTEXT",
        total: "6000.00",
        outstanding: "6000.00",
        dueAt,
      });
      const ruleId = await createRule(SHOP1_ID, "notext", 0);

      await sendPaymentReminder(sql, SHOP1_ID, invoiceId, ruleId, 0, "Asia/Kolkata", reminderEnv);

      const { body } = capturedResend();
      expect(body.text).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(body, "text")).toBe(false);
      expect(typeof body.html).toBe("string");
    });
  });

  // ===========================================================================
  // B. Payment reminder catch-up (sendCatchupReminder)
  // ===========================================================================
  describe("B. Payment reminder catch-up (sendCatchupReminder)", () => {
    it("(1)(2)(3)(4)(7) catch-up send captures the same money, IST date, subject, headers and html-only payload", async () => {
      // Catch-up for an invoice whose reminder day (dueAt + offset) was 2 shop-local
      // days ago, with a pre-existing 'delayed' ReminderLog row. Frozen now = 4 Nov
      // 12:00 IST; dueAt IST = 2 Nov, offset 0 => reminder day 2 Nov, D+2 (in window).
      setISTTime(2026, 11, 4, 12, 0);
      const dueAt = new Date("2026-11-01T19:00:00Z"); // == 2 Nov 00:30 IST
      const invoiceId = await createInvoice({
        shopId: SHOP1_ID,
        accountId: ACC_A,
        suffix: "catchup",
        name: "#A-CATCHUP",
        total: "100000.00",
        outstanding: "100000.00",
        dueAt,
      });
      const ruleId = await createRule(SHOP1_ID, "catchup", 0);
      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (gen_random_uuid()::TEXT, ${SHOP1_ID}, ${ruleId}, ${invoiceId}, 'delayed'::"ReminderLogStatus", NOW())
      `;

      const result = await sendCatchupReminder(
        sql,
        SHOP1_ID,
        invoiceId,
        ruleId,
        "logid-catchup",
        0,
        "Asia/Kolkata",
        reminderEnv
      );
      expect(result.action).toBe("sent");

      const { body } = capturedResend();
      expect(body.from).toBe(RESEND_FROM_VALUE);
      expect(body.reply_to).toBe(MERCHANT_CONTACT_EMAIL);
      expect(body.subject).toBe("Payment due today - Invoice #A-CATCHUP");
      expect(body.html).toContain("₹1,00,000.00");
      expect(body.html).toContain("November 2, 2026");
      expect(body.html).not.toContain("November 1, 2026");
      const sentHeaders = body.headers as Record<string, string>;
      expect(sentHeaders["List-Unsubscribe"]).toMatch(/^<https:\/\/app\.example\.com\/unsubscribe\?token=.+>$/);
      expect(sentHeaders["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
      expect(body.text).toBeUndefined();
      assertNoPlaceholders([body.html as string, body.subject as string]);
    });
  });

  // ===========================================================================
  // C. Customer data-request / compliance notice (sendDataRequestNotification)
  // ===========================================================================
  describe("C. Data-request notification (sendDataRequestNotification)", () => {
    const OWNER_EMAIL = "owner@example.com";
    const REQUEST_ID = "req-ec-0001"; // opaque id, not a gid

    it("(4) from=RESEND_FROM and subject is the fixed template; payload has zero forbidden tokens", async () => {
      const res = await sendDataRequestNotification(SHOP1_DOMAIN, OWNER_EMAIL, REQUEST_ID);
      expect(res.sent).toBe(true);

      const { body } = capturedResend();
      expect(body.from).toBe(RESEND_FROM_VALUE);
      expect(body.to).toBe(OWNER_EMAIL);
      expect(body.subject).toBe("Customer Data Request Ready for Download");
      assertNoPlaceholders([body.html as string, body.text as string, body.subject as string]);
    });

    it("(7) sends a plain-text part that carries the same admin download link as the html", async () => {
      const res = await sendDataRequestNotification(SHOP1_DOMAIN, OWNER_EMAIL, REQUEST_ID);
      expect(res.sent).toBe(true);

      const { body } = capturedResend();
      const shopName = SHOP1_DOMAIN.split(".")[0];
      const expectedUrl = `https://admin.shopify.com/store/${shopName}/apps/${APP_HANDLE}/app/data-requests`;
      expect(typeof body.text).toBe("string");
      expect(body.text).toContain(expectedUrl);
      expect(body.html).toContain(expectedUrl);
    });

    it("(3) does NOT set any unsubscribe header on the data-request email", async () => {
      await sendDataRequestNotification(SHOP1_DOMAIN, OWNER_EMAIL, REQUEST_ID);
      const { body } = capturedResend();
      expect(Object.prototype.hasOwnProperty.call(body, "headers")).toBe(false);
    });
  });
});
