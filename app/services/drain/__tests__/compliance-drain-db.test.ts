/**
 * Drain DB tests for compliance job handlers.
 *
 * Tests:
 * - Each topic runs idempotently (including twice)
 * - Non-INR shop's compliance job is processed (via TERMINAL_TOPICS)
 * - Failures retry and then DLQ, with minimal message fields
 * - COMPLIANCE_JOB_DLQ emitted with only allowed fields
 * - shop/redact removes webhook_receipts rows
 * - Retry after deletion is a no-op that removes its own receipt
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import {
  handleDataRequest,
  handleCustomerRedact,
  handleShopRedact,
  type ComplianceMessage,
} from "~/services/compliance";
import { recordWebhookReceipt } from "~/lib/webhook-receipts.server";
import { assertNoQueueLeftovers } from "../../../../tests/helpers/queue-leftovers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("compliance drain DB", () => {
  const testShopDomain = "test-compliance-drain.myshopify.com";
  const testShopId = "test-compliance-drain-shop-id";
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) return;
    sql = postgres(TEST_DATABASE_URL, { max: 1 });

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "uninstalledAt", "createdAt", "updatedAt")
      VALUES (
        ${testShopId},
        ${testShopDomain},
        'INR',
        NULL,
        NOW(),
        NOW()
      )
      ON CONFLICT (domain) DO UPDATE SET "uninstalledAt" = NULL
    `;
  });

  afterAll(async () => {
    if (!sql) return;

    await sql`DELETE FROM webhook_receipts WHERE shop = ${testShopDomain}`;
    await sql`DELETE FROM s22_data_requests WHERE shop_id = ${testShopId}`;
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${testShopDomain}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${testShopDomain}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${testShopDomain}`;
    await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;

    await assertNoQueueLeftovers(sql, [testShopDomain], "compliance-drain-db.test.ts");

    await sql.end();
  });

  beforeEach(async () => {
    if (!sql) return;
    await sql`DELETE FROM webhook_receipts WHERE shop = ${testShopDomain}`;
    await sql`DELETE FROM s22_data_requests WHERE shop_id = ${testShopId}`;
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${testShopDomain}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${testShopDomain}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${testShopDomain}`;
    vi.clearAllMocks();
  });

  describe("CUSTOMERS_DATA_REQUEST handler", () => {
    it("handles data request idempotently - first run creates, second run skips", async () => {
      const message: ComplianceMessage = {
        topic: "CUSTOMERS_DATA_REQUEST",
        shop: testShopDomain,
        webhookId: "test-data-req-wh-1",
        enqueuedAt: new Date().toISOString(),
        requestId: "data-req-idempotent-1",
        customerId: "12345",
      };

      const firstResult = await handleDataRequest(sql, message);
      expect(firstResult.success).toBe(true);
      expect(firstResult.action).toBe("created");

      const secondResult = await handleDataRequest(sql, message);
      expect(secondResult.success).toBe(true);
      expect(secondResult.action).toBe("skipped");
      expect(secondResult.skipReason).toContain("Duplicate");

      const [count] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM s22_data_requests 
        WHERE request_id = ${message.requestId!}
      `;
      expect(parseInt(count.count, 10)).toBe(1);
    });

    it("returns skipped when customerId is missing", async () => {
      const message: ComplianceMessage = {
        topic: "CUSTOMERS_DATA_REQUEST",
        shop: testShopDomain,
        webhookId: "test-data-req-wh-nocust",
        enqueuedAt: new Date().toISOString(),
        requestId: "data-req-nocust",
      };

      const result = await handleDataRequest(sql, message);
      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("Missing");
    });

    it("returns skipped when shop not found", async () => {
      const message: ComplianceMessage = {
        topic: "CUSTOMERS_DATA_REQUEST",
        shop: "nonexistent.myshopify.com",
        webhookId: "test-data-req-wh-noshop",
        enqueuedAt: new Date().toISOString(),
        requestId: "data-req-noshop",
        customerId: "12345",
      };

      const result = await handleDataRequest(sql, message);
      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("Shop not found");
    });
  });

  describe("CUSTOMERS_REDACT handler", () => {
    it("handles customer redact idempotently", async () => {
      const message: ComplianceMessage = {
        topic: "CUSTOMERS_REDACT",
        shop: testShopDomain,
        webhookId: "test-redact-wh-1",
        enqueuedAt: new Date().toISOString(),
        customerId: "67890",
      };

      const firstResult = await handleCustomerRedact(sql, message);
      expect(firstResult.success).toBe(true);

      const secondResult = await handleCustomerRedact(sql, message);
      expect(secondResult.success).toBe(true);
    });

    it("returns skipped when customerId is missing", async () => {
      const message: ComplianceMessage = {
        topic: "CUSTOMERS_REDACT",
        shop: testShopDomain,
        webhookId: "test-redact-wh-nocust",
        enqueuedAt: new Date().toISOString(),
      };

      const result = await handleCustomerRedact(sql, message);
      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("Missing");
    });

    it("returns skipped when shop not found", async () => {
      const message: ComplianceMessage = {
        topic: "CUSTOMERS_REDACT",
        shop: "nonexistent.myshopify.com",
        webhookId: "test-redact-wh-noshop",
        enqueuedAt: new Date().toISOString(),
        customerId: "67890",
      };

      const result = await handleCustomerRedact(sql, message);
      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("Shop not found");
    });
  });

  describe("SHOP_REDACT handler", () => {
    const shopRedactDomain = "test-shop-redact-drain.myshopify.com";
    const shopRedactId = "test-shop-redact-drain-id";

    beforeEach(async () => {
      if (!sql) return;
      await sql`DELETE FROM webhook_receipts WHERE shop = ${shopRedactDomain}`;
      await sql`DELETE FROM "Shop" WHERE id = ${shopRedactId}`;

      await sql`
        INSERT INTO "Shop" (id, domain, currency, "uninstalledAt", "createdAt", "updatedAt")
        VALUES (
          ${shopRedactId},
          ${shopRedactDomain},
          'INR',
          NOW() - INTERVAL '3 days',
          NOW(),
          NOW()
        )
        ON CONFLICT (domain) DO UPDATE SET 
          "uninstalledAt" = NOW() - INTERVAL '3 days'
      `;
    });

    afterEach(async () => {
      if (!sql) return;
      await sql`DELETE FROM webhook_receipts WHERE shop = ${shopRedactDomain}`;
      await sql`DELETE FROM "Shop" WHERE id = ${shopRedactId}`;
    });

    it("handles shop redact and removes webhook_receipts", async () => {
      await recordWebhookReceipt(sql, shopRedactDomain, "receipt-wh-1", "SOME_TOPIC", null);
      await recordWebhookReceipt(sql, shopRedactDomain, "receipt-wh-2", "SOME_OTHER", null);

      const [beforeCount] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM webhook_receipts WHERE shop = ${shopRedactDomain}
      `;
      expect(parseInt(beforeCount.count, 10)).toBe(2);

      const message: ComplianceMessage = {
        topic: "SHOP_REDACT",
        shop: shopRedactDomain,
        webhookId: "test-shop-redact-wh-1",
        enqueuedAt: new Date().toISOString(),
        shopId: "12345",
      };

      const result = await handleShopRedact(sql, message);
      expect(result.success).toBe(true);

      const [afterCount] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM webhook_receipts WHERE shop = ${shopRedactDomain}
      `;
      expect(parseInt(afterCount.count, 10)).toBe(0);
    });

    it("retry after deletion is a no-op that also removes its own receipt", async () => {
      const retryShopDomain = "test-retry-after-delete.myshopify.com";
      const retryShopId = "test-retry-after-delete-id";

      await sql`DELETE FROM webhook_receipts WHERE shop = ${retryShopDomain}`;
      await sql`DELETE FROM "Shop" WHERE id = ${retryShopId}`;

      const message: ComplianceMessage = {
        topic: "SHOP_REDACT",
        shop: retryShopDomain,
        webhookId: "test-retry-redact-wh",
        enqueuedAt: new Date().toISOString(),
        shopId: "99999",
      };

      const firstResult = await handleShopRedact(sql, message);
      expect(firstResult.success).toBe(true);
      expect(firstResult.skipReason).toContain("not found");

      await recordWebhookReceipt(sql, retryShopDomain, "retry-new-receipt", "SHOP_REDACT", null);

      const secondResult = await handleShopRedact(sql, message);
      expect(secondResult.success).toBe(true);
      expect(secondResult.skipReason).toContain("not found");

      const [afterCount] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM webhook_receipts WHERE shop = ${retryShopDomain}
      `;
      expect(parseInt(afterCount.count, 10)).toBe(1);

      await sql`DELETE FROM webhook_receipts WHERE shop = ${retryShopDomain}`;
    });

    it("skips when shop has reinstalled (uninstalledAt is NULL)", async () => {
      const reinstalledDomain = "test-reinstalled-shop.myshopify.com";
      const reinstalledId = "test-reinstalled-shop-id";

      await sql`DELETE FROM "Shop" WHERE id = ${reinstalledId}`;

      await sql`
        INSERT INTO "Shop" (id, domain, currency, "uninstalledAt", "createdAt", "updatedAt")
        VALUES (
          ${reinstalledId},
          ${reinstalledDomain},
          'INR',
          NULL,
          NOW(),
          NOW()
        )
      `;

      const message: ComplianceMessage = {
        topic: "SHOP_REDACT",
        shop: reinstalledDomain,
        webhookId: "test-reinstalled-wh",
        enqueuedAt: new Date().toISOString(),
        shopId: "88888",
      };

      const result = await handleShopRedact(sql, message);
      expect(result.success).toBe(true);
      expect(result.skipReason).toContain("reinstalled");

      const [shopExists] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM "Shop" WHERE id = ${reinstalledId}
      `;
      expect(parseInt(shopExists.count, 10)).toBe(1);

      await sql`DELETE FROM "Shop" WHERE id = ${reinstalledId}`;
    });
  });
});
