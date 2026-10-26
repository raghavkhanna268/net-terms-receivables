/**
 * DB integration tests for access logging.
 *
 * Tests:
 * - Rows written by real recordAccess have exact column set
 * - Data keys are subset of {recordType, recordId, count}
 * - No '@' or 'myshopify' in actor or data
 * - Shop isolation: events for shop A not readable through shop B's scope
 * - Cascade deletion: events deleted when shop is deleted
 *
 * Uses real recordAccess with mocked getRequestWaitUntil to collect promises.
 * Requires a running PostgreSQL instance.
 * Run with: TEST_DATABASE_URL=postgresql://... npm test -- access-log-db
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("access-log DB integration", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-access";

  const SHOP_A_ID = `shop-a-${TEST_SUFFIX}`;
  const SHOP_A_DOMAIN = `shop-a-${TEST_SUFFIX}.example.com`;

  const SHOP_B_ID = `shop-b-${TEST_SUFFIX}`;
  const SHOP_B_DOMAIN = `shop-b-${TEST_SUFFIX}.example.com`;

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
    vi.resetModules();
  });

  async function writeAccessEvent(
    shopId: string,
    actor: string,
    action: string,
    recordType: string,
    opts?: { recordId?: string; count?: number }
  ): Promise<void> {
    vi.resetModules();

    const capturedPromises: Promise<unknown>[] = [];
    const mockWaitUntil = (p: Promise<unknown>) => {
      capturedPromises.push(p);
    };

    vi.doMock("~/lib/request-context.server", () => ({
      getRequestWaitUntil: () => mockWaitUntil,
    }));

    const { recordAccess } = await import("../access-log.server");

    recordAccess(sql, {
      shopId,
      actor,
      action,
      recordType,
      recordId: opts?.recordId,
      count: opts?.count,
    });

    await Promise.all(capturedPromises);
  }

  describe("column set and data keys", () => {
    it("stored event has columns: id, shopId, actor, type, data, at", async () => {
      await writeAccessEvent(SHOP_A_ID, "12345", "dashboard", "BuyerAccount", { count: 7 });

      const [event] = await sql<
        { id: string; shopId: string; actor: string; type: string; data: unknown; at: Date }[]
      >`
        SELECT id, "shopId", actor, type, data, at FROM "AuditEvent" WHERE "shopId" = ${SHOP_A_ID}
      `;

      expect(event).toBeDefined();
      expect(event.id).toBeDefined();
      expect(event.shopId).toBe(SHOP_A_ID);
      expect(event.actor).toBe("12345");
      expect(event.type).toBe("access.dashboard");
      expect(event.at).toBeInstanceOf(Date);
      expect(event.data).toEqual({ recordType: "BuyerAccount", count: 7 });
    });

    it("data keys are subset of {recordType, recordId, count}", async () => {
      await writeAccessEvent(SHOP_A_ID, "user-1", "accounts_detail", "BuyerAccount", {
        recordId: "acc-test",
        count: 5,
      });

      const [event] = await sql<{ data: unknown }[]>`
        SELECT data FROM "AuditEvent" WHERE "shopId" = ${SHOP_A_ID}
      `;

      const data = event.data as Record<string, unknown>;
      const keys = Object.keys(data).sort();
      const allowedKeys = ["count", "recordId", "recordType"];
      for (const key of keys) {
        expect(allowedKeys).toContain(key);
      }
    });

    it("data contains only recordType when no recordId/count provided", async () => {
      vi.resetModules();
      const capturedPromises: Promise<unknown>[] = [];
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestWaitUntil: () => (p: Promise<unknown>) => capturedPromises.push(p),
      }));
      const { recordAccess } = await import("../access-log.server");

      recordAccess(sql, {
        shopId: SHOP_A_ID,
        actor: "67890",
        action: "data_requests_list",
        recordType: "DataRequest",
      });

      await Promise.all(capturedPromises);

      const [event] = await sql<{ data: unknown }[]>`
        SELECT data FROM "AuditEvent" WHERE "shopId" = ${SHOP_A_ID}
      `;

      const data = event.data as Record<string, unknown>;
      expect(Object.keys(data)).toEqual(["recordType"]);
      expect(data.recordType).toBe("DataRequest");
    });
  });

  describe("no PII in actor or data", () => {
    it("actor contains no @ or myshopify", async () => {
      await writeAccessEvent(SHOP_A_ID, "67890", "data_requests_download", "DataRequest", {
        recordId: "req-1",
      });

      const [event] = await sql<{ actor: string }[]>`
        SELECT actor FROM "AuditEvent" WHERE "shopId" = ${SHOP_A_ID}
      `;

      expect(event.actor).toBe("67890");
      expect(event.actor).not.toContain("@");
      expect(event.actor).not.toContain("myshopify");
    });

    it("data contains no @ or myshopify", async () => {
      await writeAccessEvent(SHOP_A_ID, "12345", "reconcile", "Payment", { count: 10 });

      const [event] = await sql<{ data: unknown }[]>`
        SELECT data FROM "AuditEvent" WHERE "shopId" = ${SHOP_A_ID}
      `;

      const serialized = JSON.stringify(event.data);
      expect(serialized).not.toContain("@");
      expect(serialized).not.toContain("myshopify");
    });
  });

  describe("real event types", () => {
    it("writes access.dashboard event", async () => {
      await writeAccessEvent(SHOP_A_ID, "111", "dashboard", "BuyerAccount", { count: 5 });
      const [event] = await sql<{ type: string }[]>`
        SELECT type FROM "AuditEvent" WHERE "shopId" = ${SHOP_A_ID}
      `;
      expect(event.type).toBe("access.dashboard");
    });

    it("writes access.accounts_detail event", async () => {
      await writeAccessEvent(SHOP_A_ID, "222", "accounts_detail", "BuyerAccount", { recordId: "acc-1" });
      const [event] = await sql<{ type: string }[]>`
        SELECT type FROM "AuditEvent" WHERE "shopId" = ${SHOP_A_ID}
      `;
      expect(event.type).toBe("access.accounts_detail");
    });

    it("writes access.data_requests_list event", async () => {
      await writeAccessEvent(SHOP_A_ID, "333", "data_requests_list", "DataRequest", { count: 3 });
      const [event] = await sql<{ type: string }[]>`
        SELECT type FROM "AuditEvent" WHERE "shopId" = ${SHOP_A_ID}
      `;
      expect(event.type).toBe("access.data_requests_list");
    });

    it("writes access.data_requests_download event", async () => {
      await writeAccessEvent(SHOP_A_ID, "444", "data_requests_download", "DataRequest", { recordId: "req-1" });
      const [event] = await sql<{ type: string }[]>`
        SELECT type FROM "AuditEvent" WHERE "shopId" = ${SHOP_A_ID}
      `;
      expect(event.type).toBe("access.data_requests_download");
    });

    it("writes access.reconcile event", async () => {
      await writeAccessEvent(SHOP_A_ID, "555", "reconcile", "Payment", { count: 20 });
      const [event] = await sql<{ type: string }[]>`
        SELECT type FROM "AuditEvent" WHERE "shopId" = ${SHOP_A_ID}
      `;
      expect(event.type).toBe("access.reconcile");
    });

    it("writes access.imports event", async () => {
      await writeAccessEvent(SHOP_A_ID, "666", "imports", "BankImport");
      const [event] = await sql<{ type: string }[]>`
        SELECT type FROM "AuditEvent" WHERE "shopId" = ${SHOP_A_ID}
      `;
      expect(event.type).toBe("access.imports");
    });
  });

  describe("shop isolation", () => {
    it("events written for shop A are not readable through shop B scope", async () => {
      await writeAccessEvent(SHOP_A_ID, "user-1", "dashboard", "BuyerAccount", { count: 10 });
      await writeAccessEvent(SHOP_A_ID, "user-2", "accounts_detail", "BuyerAccount", { recordId: "acc-123" });
      await writeAccessEvent(SHOP_B_ID, "user-3", "reconcile", "Payment", { count: 5 });

      const shopAEvents = await sql<{ id: string }[]>`
        SELECT id FROM "AuditEvent" WHERE "shopId" = ${SHOP_A_ID}
      `;
      expect(shopAEvents.length).toBe(2);

      const shopBEvents = await sql<{ id: string }[]>`
        SELECT id FROM "AuditEvent" WHERE "shopId" = ${SHOP_B_ID}
      `;
      expect(shopBEvents.length).toBe(1);

      const shopAIds = new Set(shopAEvents.map((e) => e.id));
      const shopBIds = new Set(shopBEvents.map((e) => e.id));
      for (const id of shopAIds) {
        expect(shopBIds.has(id)).toBe(false);
      }
    });
  });

  describe("cascade deletion", () => {
    it("deleting a shop deletes all its audit events via CASCADE", async () => {
      const tempShopId = `shop-temp-${TEST_SUFFIX}`;
      const tempShopDomain = `shop-temp-${TEST_SUFFIX}.example.com`;

      await sql`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
        VALUES (${tempShopId}, ${tempShopDomain}, 'INR', NOW(), NOW())
      `;

      const capturedPromises: Promise<unknown>[] = [];
      const mockWaitUntil = (p: Promise<unknown>) => {
        capturedPromises.push(p);
      };

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestWaitUntil: () => mockWaitUntil,
      }));

      const { recordAccess } = await import("../access-log.server");

      recordAccess(sql, {
        shopId: tempShopId,
        actor: "user-1",
        action: "dashboard",
        recordType: "BuyerAccount",
        count: 5,
      });

      recordAccess(sql, {
        shopId: tempShopId,
        actor: "user-2",
        action: "accounts_detail",
        recordType: "BuyerAccount",
        recordId: "acc-456",
      });

      recordAccess(sql, {
        shopId: tempShopId,
        actor: "user-3",
        action: "data_requests_download",
        recordType: "DataRequest",
        recordId: "req-789",
      });

      await Promise.all(capturedPromises);

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
      const tempShopDomain = `shop-temp2-${TEST_SUFFIX}.example.com`;

      await sql`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
        VALUES (${tempShopId}, ${tempShopDomain}, 'INR', NOW(), NOW())
      `;

      const capturedPromises: Promise<unknown>[] = [];
      const mockWaitUntil = (p: Promise<unknown>) => {
        capturedPromises.push(p);
      };

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestWaitUntil: () => mockWaitUntil,
      }));

      const { recordAccess } = await import("../access-log.server");

      recordAccess(sql, {
        shopId: tempShopId,
        actor: "user-x",
        action: "reconcile",
        recordType: "Payment",
        count: 10,
      });

      recordAccess(sql, {
        shopId: SHOP_B_ID,
        actor: "user-y",
        action: "imports",
        recordType: "BankImport",
      });

      await Promise.all(capturedPromises);

      const shopBCountBefore = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM "AuditEvent" WHERE "shopId" = ${SHOP_B_ID}
      `;

      await sql`DELETE FROM "Shop" WHERE id = ${tempShopId}`;

      const shopBCountAfter = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM "AuditEvent" WHERE "shopId" = ${SHOP_B_ID}
      `;
      expect(parseInt(shopBCountAfter[0].count, 10)).toBe(parseInt(shopBCountBefore[0].count, 10));
    });
  });
});
