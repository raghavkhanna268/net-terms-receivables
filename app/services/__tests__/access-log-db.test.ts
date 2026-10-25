/**
 * DB integration tests for access logging.
 *
 * Tests:
 * - Shop isolation: events for shop A not readable through shop B's scope
 * - Cascade deletion: events deleted when shop is deleted
 *
 * Requires a running PostgreSQL instance.
 * Run with: TEST_DATABASE_URL=postgresql://... npm test -- access-log-db
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("access-log DB integration", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-access";

  const SHOP_A_ID = `shop-a-${TEST_SUFFIX}`;
  const SHOP_A_DOMAIN = `shop-a-${TEST_SUFFIX}.myshopify.com`;

  const SHOP_B_ID = `shop-b-${TEST_SUFFIX}`;
  const SHOP_B_DOMAIN = `shop-b-${TEST_SUFFIX}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${SHOP_A_ID}, ${SHOP_A_DOMAIN}, 'INR', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${SHOP_B_ID}, ${SHOP_B_DOMAIN}, 'INR', NOW(), NOW())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "Shop" WHERE id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
  });

  async function insertAccessEvent(
    shopId: string,
    actor: string,
    type: string,
    data: { recordType: string; recordId?: string; count?: number }
  ): Promise<string> {
    const [result] = await sql<{ id: string }[]>`
      INSERT INTO "AuditEvent" (id, "shopId", actor, type, data, at)
      VALUES (gen_random_uuid(), ${shopId}, ${actor}, ${type}, ${sql.json(data as unknown as Record<string, string | number | undefined>)}, NOW())
      RETURNING id
    `;
    return result.id;
  }

  describe("shop isolation", () => {
    it("events written for shop A are not readable through shop B scope", async () => {
      const eventA1 = await insertAccessEvent(SHOP_A_ID, "user-1", "access.dashboard", {
        recordType: "BuyerAccount",
        count: 10,
      });
      const eventA2 = await insertAccessEvent(SHOP_A_ID, "user-2", "access.accounts.detail", {
        recordType: "BuyerAccount",
        recordId: "acc-123",
      });

      const eventB1 = await insertAccessEvent(SHOP_B_ID, "user-3", "access.reconcile", {
        recordType: "Payment",
        count: 5,
      });

      const shopAEvents = await sql<{ id: string; type: string; actor: string }[]>`
        SELECT id, type, actor FROM "AuditEvent" WHERE "shopId" = ${SHOP_A_ID}
      `;
      expect(shopAEvents.length).toBe(2);
      expect(shopAEvents.map((e) => e.id).sort()).toEqual([eventA1, eventA2].sort());

      const shopBEvents = await sql<{ id: string; type: string; actor: string }[]>`
        SELECT id, type, actor FROM "AuditEvent" WHERE "shopId" = ${SHOP_B_ID}
      `;
      expect(shopBEvents.length).toBe(1);
      expect(shopBEvents[0].id).toBe(eventB1);

      expect(shopAEvents.map((e) => e.id)).not.toContain(eventB1);
      expect(shopBEvents.map((e) => e.id)).not.toContain(eventA1);
      expect(shopBEvents.map((e) => e.id)).not.toContain(eventA2);
    });

    it("shop-scoped queries never return events from other shops", async () => {
      await insertAccessEvent(SHOP_A_ID, "user-1", "access.data_requests.list", {
        recordType: "DataRequest",
        count: 3,
      });
      await insertAccessEvent(SHOP_B_ID, "user-2", "access.imports", {
        recordType: "BankImport",
        count: 2,
      });

      const crossShopQuery = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM "AuditEvent"
        WHERE "shopId" = ${SHOP_A_ID}
          AND id IN (SELECT id FROM "AuditEvent" WHERE "shopId" = ${SHOP_B_ID})
      `;
      expect(parseInt(crossShopQuery[0].count, 10)).toBe(0);
    });
  });

  describe("cascade deletion", () => {
    it("deleting a shop deletes all its audit events via CASCADE", async () => {
      const tempShopId = `shop-temp-${TEST_SUFFIX}`;
      const tempShopDomain = `shop-temp-${TEST_SUFFIX}.myshopify.com`;

      await sql`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
        VALUES (${tempShopId}, ${tempShopDomain}, 'INR', NOW(), NOW())
      `;

      await insertAccessEvent(tempShopId, "user-1", "access.dashboard", {
        recordType: "BuyerAccount",
        count: 5,
      });
      await insertAccessEvent(tempShopId, "user-2", "access.accounts.detail", {
        recordType: "BuyerAccount",
        recordId: "acc-456",
      });
      await insertAccessEvent(tempShopId, "user-3", "access.data_requests.download", {
        recordType: "DataRequest",
        recordId: "req-789",
      });

      const beforeDelete = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM "AuditEvent" WHERE "shopId" = ${tempShopId}
      `;
      expect(parseInt(beforeDelete[0].count, 10)).toBe(3);

      await sql`DELETE FROM "Shop" WHERE id = ${tempShopId}`;

      const afterDelete = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM "AuditEvent" WHERE "shopId" = ${tempShopId}
      `;
      expect(parseInt(afterDelete[0].count, 10)).toBe(0);
    });

    it("deleting shop A does not affect shop B events", async () => {
      const tempShopId = `shop-temp2-${TEST_SUFFIX}`;
      const tempShopDomain = `shop-temp2-${TEST_SUFFIX}.myshopify.com`;

      await sql`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
        VALUES (${tempShopId}, ${tempShopDomain}, 'INR', NOW(), NOW())
      `;

      await insertAccessEvent(tempShopId, "user-x", "access.reconcile", {
        recordType: "Payment",
        count: 10,
      });

      const shopBEventId = await insertAccessEvent(SHOP_B_ID, "user-y", "access.imports", {
        recordType: "BankImport",
        count: 1,
      });

      await sql`DELETE FROM "Shop" WHERE id = ${tempShopId}`;

      const shopBEvents = await sql<{ id: string }[]>`
        SELECT id FROM "AuditEvent" WHERE "shopId" = ${SHOP_B_ID}
      `;
      expect(shopBEvents.map((e) => e.id)).toContain(shopBEventId);
    });
  });

  describe("event data structure", () => {
    it("stored event has only shopId, actor, type, at, and data fields", async () => {
      const eventId = await insertAccessEvent(SHOP_A_ID, "12345", "access.dashboard", {
        recordType: "BuyerAccount",
        count: 7,
      });

      const [event] = await sql<
        { id: string; shopId: string; actor: string; type: string; data: unknown; at: Date }[]
      >`
        SELECT id, "shopId", actor, type, data, at FROM "AuditEvent" WHERE id = ${eventId}
      `;

      expect(event.shopId).toBe(SHOP_A_ID);
      expect(event.actor).toBe("12345");
      expect(event.type).toBe("access.dashboard");
      expect(event.at).toBeInstanceOf(Date);
      expect(event.data).toEqual({ recordType: "BuyerAccount", count: 7 });
    });

    it("data contains no PII - only recordType, recordId, count", async () => {
      const testData = {
        recordType: "BuyerAccount",
        recordId: "acc-test",
        count: 5,
      };

      const eventId = await insertAccessEvent(SHOP_A_ID, "user-1", "access.accounts.detail", testData);

      const [event] = await sql<{ data: unknown }[]>`
        SELECT data FROM "AuditEvent" WHERE id = ${eventId}
      `;

      const data = event.data as Record<string, unknown>;
      const keys = Object.keys(data).sort();
      expect(keys).toEqual(["count", "recordId", "recordType"]);

      expect(data).not.toHaveProperty("email");
      expect(data).not.toHaveProperty("name");
      expect(data).not.toHaveProperty("phone");
      expect(data).not.toHaveProperty("narration");
      expect(data).not.toHaveProperty("payerText");
      expect(data).not.toHaveProperty("amount");
      expect(data).not.toHaveProperty("queryString");

      const serialized = JSON.stringify(data);
      expect(serialized).not.toContain("@");
      expect(serialized).not.toContain("myshopify");
    });

    it("actor is never an email address in stored event", async () => {
      const eventId = await insertAccessEvent(SHOP_A_ID, "67890", "access.data_requests.list", {
        recordType: "DataRequest",
        count: 2,
      });

      const [event] = await sql<{ actor: string }[]>`
        SELECT actor FROM "AuditEvent" WHERE id = ${eventId}
      `;

      expect(event.actor).toBe("67890");
      expect(event.actor).not.toContain("@");
      expect(event.actor).not.toContain("myshopify");
      expect(event.actor).not.toContain(".com");
    });
  });
});
