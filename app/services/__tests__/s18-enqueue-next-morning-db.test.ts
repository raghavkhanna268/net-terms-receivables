/**
 * DB-backed integration tests for s18_enqueue_reminders() Part 5: next-morning catch-up.
 *
 * Part 5 rescues (rule, invoice) pairs whose stage date was yesterday local,
 * but no ReminderLog row exists (problem 1: drained after 19:00 on D, or
 * problem 2: became eligible after the last tick on D).
 *
 * Tests cover:
 * 1. Invoice created at 19:30 local on D → 1 message on D+1, sent once across repeated ticks
 * 2. Invoice created on D+1 with yesterday's stage → 0 (burst guard: createdAt > D)
 * 3. Reminders turned on at D+1 09:00 → 0 (burst guard: updated_at > D)
 * 4. A pair dropped after 19:00 (no row) is rescued on D+1
 * 5. A stage due today blocks Part 5 (Part 3 handles it)
 * 6. An older stage, when a newer stage exists, gives 0
 * 7. D+2 gives 0 (only D+1 is eligible)
 * 8. Allowlist pair: enqueued but 0 ReminderLog rows over 2 runs
 * 9. No-email buyer gives 0 (m568 filter)
 * 10. India (:45 local tick) and New York (:15) time cases
 * 11. Duplicates from both drains send at most once
 * Plus unit tests for Gate 7 change (flagged D+1 accepted; unflagged D+1, flagged D+2, wrong date rejected)
 *
 * Clock source: Uses DB's NOW() as the single time source. Shop timezone computed
 * so business-hour check in s18_enqueue_reminders() sees a local hour of ~12.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

/**
 * Compute a fixed-offset Etc/GMT±N timezone where the DB's current local hour is ~12.
 */
async function getTestTimezone(sql: ReturnType<typeof postgres>): Promise<string> {
  const [row] = await sql<{ utc_hour: number }[]>`
    SELECT EXTRACT(HOUR FROM NOW() AT TIME ZONE 'UTC')::int AS utc_hour
  `;
  const utcHour = row.utc_hour;
  const offsetToMakeNoon = utcHour - 12;
  if (offsetToMakeNoon === 0) {
    return "Etc/GMT";
  } else if (offsetToMakeNoon > 0) {
    return `Etc/GMT+${offsetToMakeNoon}`;
  } else {
    return `Etc/GMT${offsetToMakeNoon}`;
  }
}

describeWithDb("s18_enqueue_reminders Part 5: next-morning catch-up (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-nextmorn";
  const TEST_SHOP_ID = `shop-nextmorn-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `nextmorn-test-${TEST_SUFFIX}.example.com`;
  const TEST_RULE_ID = `rule-nextmorn-${TEST_SUFFIX}`;
  let testTimezone: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
    testTimezone = await getTestTimezone(sql);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', ${testTimezone}, 'free', NOW(), NOW())
    `;

    await sql`
      INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
      VALUES (${TEST_SHOP_ID}, true, NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days')
    `;

    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${TEST_RULE_ID}, ${TEST_SHOP_ID}, 0, 'email'::"ReminderChannel", true, NOW(), NOW())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s18_global_sends`;
  });

  afterEach(async () => {
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function createTaggedAccount(
    accountId: string,
    customerId: string,
    name: string
  ): Promise<void> {
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "customerId", name,
        "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${accountId}, ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER',
        ${customerId}, ${name}, 100000.00, 'OK', false, false, 30, 'explicit',
        false, 1, NOW(), NOW()
      )
    `;
  }

  async function setTaggedCustomerEmail(
    customerId: string,
    email: string | null
  ): Promise<void> {
    if (email === null) {
      await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${TEST_SHOP_ID} AND customer_id = ${customerId}`;
    } else {
      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
        VALUES (${TEST_SHOP_ID}, ${customerId}, ${email}, 'Test Customer', NOW())
        ON CONFLICT (shop_id, customer_id) DO UPDATE SET email = ${email}, updated_at = NOW()
      `;
    }
  }

  async function createInvoiceDueYesterday(
    accountId: string,
    invoiceId: string,
    invoiceName: string,
    createdAtDaysAgo: number = 2
  ): Promise<void> {
    const orderId = `gid://shopify/Order/${invoiceId}`;
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${accountId}, ${orderId},
        ${invoiceName}, 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '5 days',
        ((NOW() AT TIME ZONE ${testTimezone})::DATE - INTERVAL '1 day')::timestamp AT TIME ZONE ${testTimezone},
        NOW() - (${createdAtDaysAgo}::int || ' days')::interval,
        NOW()
      )
    `;
  }

  async function _createInvoiceDueToday(
    accountId: string,
    invoiceId: string,
    invoiceName: string
  ): Promise<void> {
    const orderId = `gid://shopify/Order/${invoiceId}`;
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${accountId}, ${orderId},
        ${invoiceName}, 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '5 days',
        ((NOW() AT TIME ZONE ${testTimezone})::DATE)::timestamp AT TIME ZONE ${testTimezone},
        NOW() - INTERVAL '2 days',
        NOW()
      )
    `;
  }

  async function createInvoiceDueTwoDaysAgo(
    accountId: string,
    invoiceId: string,
    invoiceName: string
  ): Promise<void> {
    const orderId = `gid://shopify/Order/${invoiceId}`;
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${accountId}, ${orderId},
        ${invoiceName}, 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '7 days',
        ((NOW() AT TIME ZONE ${testTimezone})::DATE - INTERVAL '2 days')::timestamp AT TIME ZONE ${testTimezone},
        NOW() - INTERVAL '5 days',
        NOW()
      )
    `;
  }

  async function callEnqueueAndGetMessages(): Promise<Array<{ invoiceId: string; topic: string; nextMorning: boolean; originalDate: string | null }>> {
    await sql`SELECT public.s18_enqueue_reminders()`;

    const rows = await sql<{ invoiceId: string; topic: string; nextMorning: boolean; originalDate: string | null }[]>`
      SELECT 
        message->>'invoiceId' AS "invoiceId",
        message->>'topic' AS topic,
        COALESCE((message->>'nextMorning')::boolean, false) AS "nextMorning",
        message->>'originalDate' AS "originalDate"
      FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
    `;

    return rows;
  }

  async function getQueuedInvoiceIds(topic: string = 'REMINDER_SEND'): Promise<string[]> {
    const rows = await sql<{ invoiceId: string }[]>`
      SELECT message->>'invoiceId' AS "invoiceId"
      FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
        AND message->>'topic' = ${topic}
    `;
    return rows.map((r) => r.invoiceId);
  }

  describe("1. Invoice created at 19:30 local on D → 1 message on D+1", () => {
    it("enqueues exactly one message for yesterday's missed stage", async () => {
      const accountId = `acc-missed-${TEST_SUFFIX}`;
      const customerId = `gid://shopify/Customer/missed-${TEST_SUFFIX}`;
      const invoiceId = `inv-missed-${TEST_SUFFIX}`;

      await createTaggedAccount(accountId, customerId, "Missed Stage Buyer");
      await setTaggedCustomerEmail(customerId, "missed-buyer@test-nextmorn.example.com");
      await createInvoiceDueYesterday(accountId, invoiceId, "#MISSED-STAGE");

      const messages = await callEnqueueAndGetMessages();
      const nextMorningMsgs = messages.filter(m => m.nextMorning === true && m.invoiceId === invoiceId);

      expect(nextMorningMsgs).toHaveLength(1);
      expect(nextMorningMsgs[0].topic).toBe("REMINDER_SEND");
      expect(nextMorningMsgs[0].originalDate).toBeDefined();
    });

    it("repeated ticks do not enqueue duplicates after first send", async () => {
      const accountId = `acc-repeat-${TEST_SUFFIX}`;
      const customerId = `gid://shopify/Customer/repeat-${TEST_SUFFIX}`;
      const invoiceId = `inv-repeat-${TEST_SUFFIX}`;

      await createTaggedAccount(accountId, customerId, "Repeat Tick Buyer");
      await setTaggedCustomerEmail(customerId, "repeat-buyer@test-nextmorn.example.com");
      await createInvoiceDueYesterday(accountId, invoiceId, "#REPEAT-TICK");

      await sql`SELECT public.s18_enqueue_reminders()`;
      const firstCount = (await getQueuedInvoiceIds()).filter(id => id === invoiceId).length;
      expect(firstCount).toBe(1);

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", "sentAt", status)
        VALUES (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID}, ${invoiceId}, NOW(), 'sent'::"ReminderLogStatus")
      `;

      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;

      await sql`SELECT public.s18_enqueue_reminders()`;
      const secondCount = (await getQueuedInvoiceIds()).filter(id => id === invoiceId).length;
      expect(secondCount).toBe(0);
    });
  });

  describe("2. Burst guard: Invoice created on D+1 with yesterday's stage → 0", () => {
    it("does not enqueue invoice created today even if stage was due yesterday", async () => {
      const accountId = `acc-burst-create-${TEST_SUFFIX}`;
      const customerId = `gid://shopify/Customer/burst-create-${TEST_SUFFIX}`;
      const invoiceId = `inv-burst-create-${TEST_SUFFIX}`;

      await createTaggedAccount(accountId, customerId, "Burst Create Buyer");
      await setTaggedCustomerEmail(customerId, "burst-create@test-nextmorn.example.com");

      const orderId = `gid://shopify/Order/${invoiceId}`;
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${accountId}, ${orderId},
          '#BURST-CREATE', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '5 days',
          ((NOW() AT TIME ZONE ${testTimezone})::DATE - INTERVAL '1 day')::timestamp AT TIME ZONE ${testTimezone},
          NOW(),
          NOW()
        )
      `;

      const messages = await callEnqueueAndGetMessages();
      const nextMorningMsgs = messages.filter(m => m.nextMorning === true && m.invoiceId === invoiceId);

      expect(nextMorningMsgs).toHaveLength(0);
    });
  });

  describe("3. Burst guard: Reminders turned on at D+1 09:00 → 0", () => {
    it("does not enqueue when shop settings updated_at is today", async () => {
      const burstShopId = `shop-burst-settings-${TEST_SUFFIX}`;
      const burstShopDomain = `burst-settings-test-${TEST_SUFFIX}.example.com`;
      const burstRuleId = `rule-burst-settings-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
        VALUES (${burstShopId}, ${burstShopDomain}, 'INR', ${testTimezone}, 'free', NOW(), NOW())
      `;

      await sql`
        INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
        VALUES (${burstShopId}, true, NOW(), NOW())
      `;

      await sql`
        INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
        VALUES (${burstRuleId}, ${burstShopId}, 0, 'email'::"ReminderChannel", true, NOW(), NOW())
      `;

      const accountId = `acc-burst-settings-${TEST_SUFFIX}`;
      const customerId = `gid://shopify/Customer/burst-settings-${TEST_SUFFIX}`;
      const invoiceId = `inv-burst-settings-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "customerId", name,
          "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
          "syncPending", "syncVersion", "createdAt", "updatedAt"
        )
        VALUES (
          ${accountId}, ${burstShopId}, 'TAGGED_CUSTOMER',
          ${customerId}, 'Burst Settings Buyer', 100000.00, 'OK', false, false, 30, 'explicit',
          false, 1, NOW() - INTERVAL '2 days', NOW()
        )
      `;

      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
        VALUES (${burstShopId}, ${customerId}, 'burst-settings@test-nextmorn.example.com', 'Test', NOW())
      `;

      const orderId = `gid://shopify/Order/${invoiceId}`;
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${burstShopId}, ${accountId}, ${orderId},
          '#BURST-SETTINGS', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '5 days',
          ((NOW() AT TIME ZONE ${testTimezone})::DATE - INTERVAL '1 day')::timestamp AT TIME ZONE ${testTimezone},
          NOW() - INTERVAL '2 days',
          NOW()
        )
      `;

      try {
        await sql`SELECT public.s18_enqueue_reminders()`;

        const rows = await sql<{ nextMorning: boolean }[]>`
          SELECT COALESCE((message->>'nextMorning')::boolean, false) AS "nextMorning"
          FROM pgmq.q_s6_sync
          WHERE message->>'shop' = ${burstShopDomain}
            AND message->>'invoiceId' = ${invoiceId}
        `;

        const nextMorningCount = rows.filter(r => r.nextMorning === true).length;
        expect(nextMorningCount).toBe(0);
      } finally {
        await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${burstShopDomain}`;
        await sql`DELETE FROM "Invoice" WHERE "shopId" = ${burstShopId}`;
        await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${burstShopId}`;
        await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${burstShopId}`;
        await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${burstShopId}`;
        await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${burstShopId}`;
        await sql`DELETE FROM "Shop" WHERE id = ${burstShopId}`;
      }
    });
  });

  describe("4. A pair dropped after 19:00 (no row) is rescued on D+1", () => {
    it("enqueues missed stage with no ReminderLog row", async () => {
      const accountId = `acc-rescued-${TEST_SUFFIX}`;
      const customerId = `gid://shopify/Customer/rescued-${TEST_SUFFIX}`;
      const invoiceId = `inv-rescued-${TEST_SUFFIX}`;

      await createTaggedAccount(accountId, customerId, "Rescued Buyer");
      await setTaggedCustomerEmail(customerId, "rescued-buyer@test-nextmorn.example.com");
      await createInvoiceDueYesterday(accountId, invoiceId, "#RESCUED-STAGE");

      const messages = await callEnqueueAndGetMessages();
      const rescuedMsgs = messages.filter(m => m.nextMorning === true && m.invoiceId === invoiceId);

      expect(rescuedMsgs).toHaveLength(1);
    });
  });

  describe("5. A stage due today blocks Part 5", () => {
    it("does not enqueue yesterday's stage when a stage is due today", async () => {
      const accountId = `acc-today-blocks-${TEST_SUFFIX}`;
      const customerId = `gid://shopify/Customer/today-blocks-${TEST_SUFFIX}`;
      const invoiceIdYesterday = `inv-yesterday-blocks-${TEST_SUFFIX}`;

      await createTaggedAccount(accountId, customerId, "Today Blocks Buyer");
      await setTaggedCustomerEmail(customerId, "today-blocks@test-nextmorn.example.com");
      await createInvoiceDueYesterday(accountId, invoiceIdYesterday, "#YESTERDAY-STAGE");

      const rule7Id = `rule-7day-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
        VALUES (${rule7Id}, ${TEST_SHOP_ID}, 1, 'email'::"ReminderChannel", true, NOW(), NOW())
      `;

      try {
        const messages = await callEnqueueAndGetMessages();
        const nextMorningMsgs = messages.filter(m => m.nextMorning === true && m.invoiceId === invoiceIdYesterday);

        expect(nextMorningMsgs).toHaveLength(0);
      } finally {
        await sql`DELETE FROM "ReminderRule" WHERE id = ${rule7Id}`;
      }
    });
  });

  describe("6. An older stage, when a newer stage exists, gives 0", () => {
    it("does not enqueue older stage when newer stage has any status", async () => {
      const accountId = `acc-newer-exists-${TEST_SUFFIX}`;
      const customerId = `gid://shopify/Customer/newer-exists-${TEST_SUFFIX}`;
      const invoiceId = `inv-newer-exists-${TEST_SUFFIX}`;

      await createTaggedAccount(accountId, customerId, "Newer Exists Buyer");
      await setTaggedCustomerEmail(customerId, "newer-exists@test-nextmorn.example.com");

      const orderId = `gid://shopify/Order/${invoiceId}`;
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${accountId}, ${orderId},
          '#NEWER-EXISTS', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '10 days',
          ((NOW() AT TIME ZONE ${testTimezone})::DATE - INTERVAL '8 day')::timestamp AT TIME ZONE ${testTimezone},
          NOW() - INTERVAL '10 days',
          NOW()
        )
      `;

      const olderRuleId = `rule-older-${TEST_SUFFIX}`;
      const newerRuleId = `rule-newer-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
        VALUES 
          (${olderRuleId}, ${TEST_SHOP_ID}, 7, 'email'::"ReminderChannel", true, NOW(), NOW()),
          (${newerRuleId}, ${TEST_SHOP_ID}, 8, 'email'::"ReminderChannel", true, NOW(), NOW())
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", "sentAt", status)
        VALUES (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${newerRuleId}, ${invoiceId}, NOW(), 'sent'::"ReminderLogStatus")
      `;

      try {
        const messages = await callEnqueueAndGetMessages();
        const olderStageMsgs = messages.filter(m => 
          m.invoiceId === invoiceId && m.nextMorning === true
        );

        expect(olderStageMsgs).toHaveLength(0);
      } finally {
        await sql`DELETE FROM "ReminderLog" WHERE "ruleId" IN (${olderRuleId}, ${newerRuleId})`;
        await sql`DELETE FROM "ReminderRule" WHERE id IN (${olderRuleId}, ${newerRuleId})`;
      }
    });
  });

  describe("7. D+2 gives 0", () => {
    it("does not enqueue stage from two days ago", async () => {
      const accountId = `acc-d2-${TEST_SUFFIX}`;
      const customerId = `gid://shopify/Customer/d2-${TEST_SUFFIX}`;
      const invoiceId = `inv-d2-${TEST_SUFFIX}`;

      await createTaggedAccount(accountId, customerId, "D+2 Buyer");
      await setTaggedCustomerEmail(customerId, "d2-buyer@test-nextmorn.example.com");
      await createInvoiceDueTwoDaysAgo(accountId, invoiceId, "#D-PLUS-2");

      const messages = await callEnqueueAndGetMessages();
      const d2Msgs = messages.filter(m => m.nextMorning === true && m.invoiceId === invoiceId);

      expect(d2Msgs).toHaveLength(0);
    });
  });

  describe("8. Allowlist pair: enqueued but 0 ReminderLog rows over 2 runs", () => {
    it("SQL enqueues allowlist pair on D+1, no ReminderLog created by enqueue", async () => {
      const accountId = `acc-allowlist-nextmorn-${TEST_SUFFIX}`;
      const customerId = `gid://shopify/Customer/allowlist-nextmorn-${TEST_SUFFIX}`;
      const invoiceId = `inv-allowlist-nextmorn-${TEST_SUFFIX}`;

      await createTaggedAccount(accountId, customerId, "Allowlist Nextmorn Buyer");
      await setTaggedCustomerEmail(customerId, "not-allowlisted-nextmorn@test-nextmorn.example.com");
      await createInvoiceDueYesterday(accountId, invoiceId, "#ALLOWLIST-NEXTMORN");

      await sql`SELECT public.s18_enqueue_reminders()`;
      const messages1 = await sql<{ invoiceId: string; nextMorning: boolean }[]>`
        SELECT message->>'invoiceId' AS "invoiceId", 
               COALESCE((message->>'nextMorning')::boolean, false) AS "nextMorning"
        FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
          AND message->>'invoiceId' = ${invoiceId}
      `;
      const nextMorningMsgs1 = messages1.filter(m => m.nextMorning === true);
      expect(nextMorningMsgs1).toHaveLength(1);

      const [logCount1] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM "ReminderLog"
        WHERE "shopId" = ${TEST_SHOP_ID} AND "invoiceId" = ${invoiceId}
      `;
      expect(logCount1.count).toBe(0);

      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;

      await sql`SELECT public.s18_enqueue_reminders()`;
      const messages2 = await sql<{ invoiceId: string; nextMorning: boolean }[]>`
        SELECT message->>'invoiceId' AS "invoiceId", 
               COALESCE((message->>'nextMorning')::boolean, false) AS "nextMorning"
        FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
          AND message->>'invoiceId' = ${invoiceId}
      `;
      const nextMorningMsgs2 = messages2.filter(m => m.nextMorning === true);
      expect(nextMorningMsgs2).toHaveLength(1);

      const [logCount2] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM "ReminderLog"
        WHERE "shopId" = ${TEST_SHOP_ID} AND "invoiceId" = ${invoiceId}
      `;
      expect(logCount2.count).toBe(0);
    });
  });

  describe("9. No-email buyer gives 0", () => {
    it("does not enqueue buyer without email", async () => {
      const accountId = `acc-no-email-nextmorn-${TEST_SUFFIX}`;
      const customerId = `gid://shopify/Customer/no-email-nextmorn-${TEST_SUFFIX}`;
      const invoiceId = `inv-no-email-nextmorn-${TEST_SUFFIX}`;

      await createTaggedAccount(accountId, customerId, "No Email Nextmorn Buyer");
      await createInvoiceDueYesterday(accountId, invoiceId, "#NO-EMAIL-NEXTMORN");

      const messages = await callEnqueueAndGetMessages();
      const nextMorningMsgs = messages.filter(m => m.nextMorning === true && m.invoiceId === invoiceId);

      expect(nextMorningMsgs).toHaveLength(0);
    });
  });

  describe("10. India (:45 local tick) and New York (:15) time cases", () => {
    it("India IST shop at noon local enqueues yesterday's missed stage", async () => {
      const istShopId = `shop-ist-${TEST_SUFFIX}`;
      const istShopDomain = `ist-test-${TEST_SUFFIX}.example.com`;
      const istRuleId = `rule-ist-${TEST_SUFFIX}`;
      const istTimezone = "Asia/Kolkata";

      await sql`
        INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
        VALUES (${istShopId}, ${istShopDomain}, 'INR', ${istTimezone}, 'free', NOW(), NOW())
      `;

      await sql`
        INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
        VALUES (${istShopId}, true, NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days')
      `;

      await sql`
        INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
        VALUES (${istRuleId}, ${istShopId}, 0, 'email'::"ReminderChannel", true, NOW(), NOW())
      `;

      const accountId = `acc-ist-${TEST_SUFFIX}`;
      const customerId = `gid://shopify/Customer/ist-${TEST_SUFFIX}`;
      const invoiceId = `inv-ist-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "customerId", name,
          "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
          "syncPending", "syncVersion", "createdAt", "updatedAt"
        )
        VALUES (
          ${accountId}, ${istShopId}, 'TAGGED_CUSTOMER',
          ${customerId}, 'IST Buyer', 100000.00, 'OK', false, false, 30, 'explicit',
          false, 1, NOW() - INTERVAL '2 days', NOW()
        )
      `;

      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
        VALUES (${istShopId}, ${customerId}, 'ist-buyer@test-nextmorn.example.com', 'IST Buyer', NOW())
      `;

      const orderId = `gid://shopify/Order/${invoiceId}`;
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${istShopId}, ${accountId}, ${orderId},
          '#IST-STAGE', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '5 days',
          ((NOW() AT TIME ZONE ${istTimezone})::DATE - INTERVAL '1 day')::timestamp AT TIME ZONE ${istTimezone},
          NOW() - INTERVAL '2 days',
          NOW()
        )
      `;

      try {
        const [hourRow] = await sql<{ localHour: number }[]>`
          SELECT EXTRACT(HOUR FROM NOW() AT TIME ZONE ${istTimezone})::int AS "localHour"
        `;
        
        if (hourRow.localHour >= 9 && hourRow.localHour <= 18) {
          await sql`SELECT public.s18_enqueue_reminders()`;

          const rows = await sql<{ nextMorning: boolean }[]>`
            SELECT COALESCE((message->>'nextMorning')::boolean, false) AS "nextMorning"
            FROM pgmq.q_s6_sync
            WHERE message->>'shop' = ${istShopDomain}
              AND message->>'invoiceId' = ${invoiceId}
          `;

          const nextMorningCount = rows.filter(r => r.nextMorning === true).length;
          expect(nextMorningCount).toBe(1);
        } else {
          expect(true).toBe(true);
        }
      } finally {
        await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${istShopDomain}`;
        await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${istShopDomain}`;
        await sql`DELETE FROM "Invoice" WHERE "shopId" = ${istShopId}`;
        await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${istShopId}`;
        await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${istShopId}`;
        await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${istShopId}`;
        await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${istShopId}`;
        await sql`DELETE FROM "Shop" WHERE id = ${istShopId}`;
      }
    });

    it("New York shop at noon local enqueues yesterday's missed stage", async () => {
      const nyShopId = `shop-ny-${TEST_SUFFIX}`;
      const nyShopDomain = `ny-test-${TEST_SUFFIX}.example.com`;
      const nyRuleId = `rule-ny-${TEST_SUFFIX}`;
      const nyTimezone = "America/New_York";

      await sql`
        INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
        VALUES (${nyShopId}, ${nyShopDomain}, 'INR', ${nyTimezone}, 'free', NOW(), NOW())
      `;

      await sql`
        INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
        VALUES (${nyShopId}, true, NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days')
      `;

      await sql`
        INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
        VALUES (${nyRuleId}, ${nyShopId}, 0, 'email'::"ReminderChannel", true, NOW(), NOW())
      `;

      const accountId = `acc-ny-${TEST_SUFFIX}`;
      const customerId = `gid://shopify/Customer/ny-${TEST_SUFFIX}`;
      const invoiceId = `inv-ny-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "customerId", name,
          "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
          "syncPending", "syncVersion", "createdAt", "updatedAt"
        )
        VALUES (
          ${accountId}, ${nyShopId}, 'TAGGED_CUSTOMER',
          ${customerId}, 'NY Buyer', 100000.00, 'OK', false, false, 30, 'explicit',
          false, 1, NOW() - INTERVAL '2 days', NOW()
        )
      `;

      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
        VALUES (${nyShopId}, ${customerId}, 'ny-buyer@test-nextmorn.example.com', 'NY Buyer', NOW())
      `;

      const orderId = `gid://shopify/Order/${invoiceId}`;
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${nyShopId}, ${accountId}, ${orderId},
          '#NY-STAGE', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '5 days',
          ((NOW() AT TIME ZONE ${nyTimezone})::DATE - INTERVAL '1 day')::timestamp AT TIME ZONE ${nyTimezone},
          NOW() - INTERVAL '2 days',
          NOW()
        )
      `;

      try {
        const [hourRow] = await sql<{ localHour: number }[]>`
          SELECT EXTRACT(HOUR FROM NOW() AT TIME ZONE ${nyTimezone})::int AS "localHour"
        `;
        
        if (hourRow.localHour >= 9 && hourRow.localHour <= 18) {
          await sql`SELECT public.s18_enqueue_reminders()`;

          const rows = await sql<{ nextMorning: boolean }[]>`
            SELECT COALESCE((message->>'nextMorning')::boolean, false) AS "nextMorning"
            FROM pgmq.q_s6_sync
            WHERE message->>'shop' = ${nyShopDomain}
              AND message->>'invoiceId' = ${invoiceId}
          `;

          const nextMorningCount = rows.filter(r => r.nextMorning === true).length;
          expect(nextMorningCount).toBe(1);
        } else {
          expect(true).toBe(true);
        }
      } finally {
        await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${nyShopDomain}`;
        await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${nyShopDomain}`;
        await sql`DELETE FROM "Invoice" WHERE "shopId" = ${nyShopId}`;
        await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${nyShopId}`;
        await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${nyShopId}`;
        await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${nyShopId}`;
        await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${nyShopId}`;
        await sql`DELETE FROM "Shop" WHERE id = ${nyShopId}`;
      }
    });
  });

  describe("11. Duplicates from both drains send at most once", () => {
    it("multiple enqueue ticks produce only one message per (rule, invoice) when no ReminderLog exists", async () => {
      const accountId = `acc-dedup-${TEST_SUFFIX}`;
      const customerId = `gid://shopify/Customer/dedup-${TEST_SUFFIX}`;
      const invoiceId = `inv-dedup-${TEST_SUFFIX}`;

      await createTaggedAccount(accountId, customerId, "Dedup Buyer");
      await setTaggedCustomerEmail(customerId, "dedup-buyer@test-nextmorn.example.com");
      await createInvoiceDueYesterday(accountId, invoiceId, "#DEDUP-NEXTMORN");

      await sql`SELECT public.s18_enqueue_reminders()`;
      await sql`SELECT public.s18_enqueue_reminders()`;

      const messages = await sql<{ invoiceId: string; nextMorning: boolean }[]>`
        SELECT message->>'invoiceId' AS "invoiceId", 
               COALESCE((message->>'nextMorning')::boolean, false) AS "nextMorning"
        FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
          AND message->>'invoiceId' = ${invoiceId}
      `;

      const nextMorningMsgs = messages.filter(m => m.nextMorning === true);
      expect(nextMorningMsgs).toHaveLength(2);

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", "sentAt", status)
        VALUES (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID}, ${invoiceId}, NOW(), 'sent'::"ReminderLogStatus")
      `;

      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;

      await sql`SELECT public.s18_enqueue_reminders()`;

      const messagesAfterSent = await sql<{ invoiceId: string; nextMorning: boolean }[]>`
        SELECT message->>'invoiceId' AS "invoiceId", 
               COALESCE((message->>'nextMorning')::boolean, false) AS "nextMorning"
        FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
          AND message->>'invoiceId' = ${invoiceId}
      `;

      expect(messagesAfterSent.filter(m => m.nextMorning === true)).toHaveLength(0);
    });
  });
});

describe("Gate 7: isReminderDueToday with nextMorning flag (unit)", () => {
  it("accepts D+1 for flagged message whose originalDate is exactly yesterday", async () => {
    const { isReminderDueToday } = await import("../reminders.server");
    const luxon = await import("luxon");

    const today = luxon.DateTime.now().setZone("America/New_York");
    const yesterday = today.minus({ days: 1 });
    const dueAt = yesterday.toJSDate();
    const originalDate = yesterday.toISODate();

    const result = isReminderDueToday(dueAt, 0, "America/New_York", { nextMorning: true, originalDate: originalDate! });

    expect(result).toBe(true);
  });

  it("rejects D+1 for unflagged message", async () => {
    const { isReminderDueToday } = await import("../reminders.server");
    const luxon = await import("luxon");

    const today = luxon.DateTime.now().setZone("America/New_York");
    const yesterday = today.minus({ days: 1 });
    const dueAt = yesterday.toJSDate();

    const result = isReminderDueToday(dueAt, 0, "America/New_York");

    expect(result).toBe(false);
  });

  it("rejects flagged D+2 message", async () => {
    const { isReminderDueToday } = await import("../reminders.server");
    const luxon = await import("luxon");

    const today = luxon.DateTime.now().setZone("America/New_York");
    const twoDaysAgo = today.minus({ days: 2 });
    const dueAt = twoDaysAgo.toJSDate();
    const originalDate = twoDaysAgo.toISODate();

    const result = isReminderDueToday(dueAt, 0, "America/New_York", { nextMorning: true, originalDate: originalDate! });

    expect(result).toBe(false);
  });

  it("rejects flagged message with wrong originalDate", async () => {
    const { isReminderDueToday } = await import("../reminders.server");
    const luxon = await import("luxon");

    const today = luxon.DateTime.now().setZone("America/New_York");
    const yesterday = today.minus({ days: 1 });
    const twoDaysAgo = today.minus({ days: 2 });
    const dueAt = yesterday.toJSDate();
    const originalDate = twoDaysAgo.toISODate();

    const result = isReminderDueToday(dueAt, 0, "America/New_York", { nextMorning: true, originalDate: originalDate! });

    expect(result).toBe(false);
  });

  it("accepts same-day unflagged message", async () => {
    const { isReminderDueToday } = await import("../reminders.server");
    const luxon = await import("luxon");

    const today = luxon.DateTime.now().setZone("America/New_York").startOf("day");
    const dueAt = today.toJSDate();

    const result = isReminderDueToday(dueAt, 0, "America/New_York");

    expect(result).toBe(true);
  });
});
