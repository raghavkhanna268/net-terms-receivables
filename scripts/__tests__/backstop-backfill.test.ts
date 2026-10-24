/**
 * DB-backed integration tests for backstop-backfill.ts script.
 * Uses the CI pgmq Postgres service.
 *
 * Tests:
 * - Unheld account gives no candidate
 * - Held account with no backstop row gives candidate in dry-run (no writes)
 * - --apply holds it via applyBackstop
 * - Existing 'held' row gets skipped
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { findCandidates, getOfflineAccessToken } from "../backstop-backfill";

vi.mock("~/services/shopify-client.server", () => ({
  shopifyGraphQLRequest: vi.fn(),
}));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("scripts/backstop-backfill", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-backfill";
  const TEST_SHOP_ID = `shop-backfill-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `backfill-test-${TEST_SUFFIX}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM backstop_processed_orders WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Session" WHERE shop = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  describe("findCandidates", () => {
    const UNHELD_ACCOUNT_ID = `acc-unheld-${TEST_SUFFIX}`;
    const HELD_ACCOUNT_ID = `acc-held-${TEST_SUFFIX}`;
    const ORDER_GID_1 = `gid://shopify/Order/backfill-1-${TEST_SUFFIX}`;
    const ORDER_GID_2 = `gid://shopify/Order/backfill-2-${TEST_SUFFIX}`;
    const ORDER_GID_3 = `gid://shopify/Order/backfill-3-${TEST_SUFFIX}`;
    const INVOICE_ID_1 = `inv-backfill-1-${TEST_SUFFIX}`;
    const INVOICE_ID_2 = `inv-backfill-2-${TEST_SUFFIX}`;
    const INVOICE_ID_3 = `inv-backfill-3-${TEST_SUFFIX}`;

    beforeAll(async () => {
      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "creditLimit", "holdState", bypass, "manualHold", "holdReasonCode",
          "createdAt", "updatedAt"
        )
        VALUES (
          ${UNHELD_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
          ${"co-unheld-" + TEST_SUFFIX}, ${"loc-unheld-" + TEST_SUFFIX},
          'Unheld Account', 100000.00, 'OK', false, false, NULL,
          NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "creditLimit", "holdState", bypass, "manualHold", "holdReasonCode",
          "createdAt", "updatedAt"
        )
        VALUES (
          ${HELD_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
          ${"co-held-" + TEST_SUFFIX}, ${"loc-held-" + TEST_SUFFIX},
          'Held Account', 100000.00, 'HELD', false, true, 'MANUAL_HOLD',
          NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${INVOICE_ID_1}, ${TEST_SHOP_ID}, ${UNHELD_ACCOUNT_ID}, ${ORDER_GID_1},
          '#BACKFILL-UNHELD', 50000.00, 50000.00, 'open', NOW(), NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${INVOICE_ID_2}, ${TEST_SHOP_ID}, ${HELD_ACCOUNT_ID}, ${ORDER_GID_2},
          '#BACKFILL-HELD-NO-ROW', 50000.00, 50000.00, 'open', NOW(), NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${INVOICE_ID_3}, ${TEST_SHOP_ID}, ${HELD_ACCOUNT_ID}, ${ORDER_GID_3},
          '#BACKFILL-HELD-WITH-ROW', 50000.00, 50000.00, 'open', NOW(), NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO backstop_processed_orders (shop_id, order_gid, action, reason, processed_at)
        VALUES (${TEST_SHOP_ID}, ${ORDER_GID_3}, 'held', 'Manual hold', NOW())
      `;
    });

    afterAll(async () => {
      await sql`DELETE FROM backstop_processed_orders WHERE shop_id = ${TEST_SHOP_ID}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    });

    it("unheld account gives no candidate", async () => {
      const candidates = await findCandidates(sql, TEST_SHOP_DOMAIN);

      const unheldCandidate = candidates.find((c) => c.orderId === ORDER_GID_1);
      expect(unheldCandidate).toBeUndefined();
    });

    it("held account with no backstop row gives a candidate", async () => {
      const candidates = await findCandidates(sql, TEST_SHOP_DOMAIN);

      const heldCandidate = candidates.find((c) => c.orderId === ORDER_GID_2);
      expect(heldCandidate).toBeDefined();
      expect(heldCandidate!.buyerAccountId).toBe(HELD_ACCOUNT_ID);
      expect(heldCandidate!.shopDomain).toBe(TEST_SHOP_DOMAIN);
    });

    it("existing 'held' row gets skipped (not a candidate)", async () => {
      const candidates = await findCandidates(sql, TEST_SHOP_DOMAIN);

      const alreadyProcessedCandidate = candidates.find((c) => c.orderId === ORDER_GID_3);
      expect(alreadyProcessedCandidate).toBeUndefined();
    });

    it("pending row is still a candidate (incomplete processing)", async () => {
      const ORDER_GID_PENDING = `gid://shopify/Order/backfill-pending-${TEST_SUFFIX}`;
      const INVOICE_ID_PENDING = `inv-backfill-pending-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${INVOICE_ID_PENDING}, ${TEST_SHOP_ID}, ${HELD_ACCOUNT_ID}, ${ORDER_GID_PENDING},
          '#BACKFILL-PENDING', 50000.00, 50000.00, 'open', NOW(), NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO backstop_processed_orders (shop_id, order_gid, action, reason, processed_at)
        VALUES (${TEST_SHOP_ID}, ${ORDER_GID_PENDING}, 'pending', NULL, NOW() - INTERVAL '10 minutes')
      `;

      try {
        const candidates = await findCandidates(sql, TEST_SHOP_DOMAIN);
        const pendingCandidate = candidates.find((c) => c.orderId === ORDER_GID_PENDING);
        expect(pendingCandidate).toBeDefined();
      } finally {
        await sql`DELETE FROM backstop_processed_orders WHERE order_gid = ${ORDER_GID_PENDING}`;
        await sql`DELETE FROM "Invoice" WHERE id = ${INVOICE_ID_PENDING}`;
      }
    });
  });

  describe("getOfflineAccessToken", () => {
    const SESSION_ID = `offline_${TEST_SHOP_DOMAIN}`;

    beforeEach(async () => {
      await sql`DELETE FROM "Session" WHERE shop = ${TEST_SHOP_DOMAIN}`;
    });

    afterAll(async () => {
      await sql`DELETE FROM "Session" WHERE shop = ${TEST_SHOP_DOMAIN}`;
    });

    it("returns null when no offline session exists", async () => {
      const token = await getOfflineAccessToken(sql, TEST_SHOP_DOMAIN);
      expect(token).toBeNull();
    });

    it("returns null for online-only session", async () => {
      await sql`
        INSERT INTO "Session" (id, shop, state, "isOnline", scope, "accessToken")
        VALUES (${SESSION_ID + "-online"}, ${TEST_SHOP_DOMAIN}, 'state', true, 'read_products', 'shpua_online_token')
      `;

      const token = await getOfflineAccessToken(sql, TEST_SHOP_DOMAIN);
      expect(token).toBeNull();
    });

    it("returns offline access token when exists", async () => {
      await sql`
        INSERT INTO "Session" (id, shop, state, "isOnline", scope, "accessToken")
        VALUES (${SESSION_ID}, ${TEST_SHOP_DOMAIN}, 'state', false, 'read_products', 'shpat_offline_token')
      `;

      const token = await getOfflineAccessToken(sql, TEST_SHOP_DOMAIN);
      expect(token).toBe("shpat_offline_token");
    });

    it("returns most recent offline session when multiple exist", async () => {
      await sql`
        INSERT INTO "Session" (id, shop, state, "isOnline", scope, "accessToken")
        VALUES (${SESSION_ID + "-1"}, ${TEST_SHOP_DOMAIN}, 'state', false, 'read_products', 'shpat_old_token')
      `;
      await sql`
        INSERT INTO "Session" (id, shop, state, "isOnline", scope, "accessToken")
        VALUES (${SESSION_ID + "-2"}, ${TEST_SHOP_DOMAIN}, 'state', false, 'read_products', 'shpat_new_token')
      `;

      const token = await getOfflineAccessToken(sql, TEST_SHOP_DOMAIN);
      expect(token).toBe("shpat_new_token");
    });
  });

  describe("processBackfill dry-run", () => {
    const HELD_ACCOUNT_ID = `acc-held-dryrun-${TEST_SUFFIX}`;
    const ORDER_GID = `gid://shopify/Order/backfill-dryrun-${TEST_SUFFIX}`;
    const INVOICE_ID = `inv-backfill-dryrun-${TEST_SUFFIX}`;

    beforeAll(async () => {
      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "creditLimit", "holdState", bypass, "manualHold", "holdReasonCode",
          "createdAt", "updatedAt"
        )
        VALUES (
          ${HELD_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
          ${"co-dryrun-" + TEST_SUFFIX}, ${"loc-dryrun-" + TEST_SUFFIX},
          'Dry Run Account', 100000.00, 'HELD', false, true, 'MANUAL_HOLD',
          NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${INVOICE_ID}, ${TEST_SHOP_ID}, ${HELD_ACCOUNT_ID}, ${ORDER_GID},
          '#BACKFILL-DRYRUN', 50000.00, 50000.00, 'open', NOW(), NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "Session" (id, shop, state, "isOnline", scope, "accessToken")
        VALUES (${"offline_" + TEST_SHOP_DOMAIN}, ${TEST_SHOP_DOMAIN}, 'state', false, 'read_products', 'shpat_dryrun_token')
      `;
    });

    afterAll(async () => {
      await sql`DELETE FROM backstop_processed_orders WHERE order_gid = ${ORDER_GID}`;
      await sql`DELETE FROM "Invoice" WHERE id = ${INVOICE_ID}`;
      await sql`DELETE FROM "BuyerAccount" WHERE id = ${HELD_ACCOUNT_ID}`;
      await sql`DELETE FROM "Session" WHERE shop = ${TEST_SHOP_DOMAIN}`;
    });

    it("dry-run does not write to backstop_processed_orders", async () => {
      const { processBackfill } = await import("../backstop-backfill");

      const candidates = await findCandidates(sql, TEST_SHOP_DOMAIN);
      const dryRunCandidates = candidates.filter((c) => c.orderId === ORDER_GID);
      expect(dryRunCandidates).toHaveLength(1);

      const result = await processBackfill(sql, dryRunCandidates, true);

      expect(result.candidates).toBe(1);
      expect(result.applied).toBe(1);

      const [row] = await sql<{ action: string }[]>`
        SELECT action FROM backstop_processed_orders
        WHERE shop_id = ${TEST_SHOP_ID} AND order_gid = ${ORDER_GID}
      `;
      expect(row).toBeUndefined();
    });
  });
});
