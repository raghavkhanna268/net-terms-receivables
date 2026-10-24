/**
 * DB-backed integration tests for backstop-backfill.ts script.
 * Uses the CI pgmq Postgres service.
 *
 * Tests:
 * - Unheld account gives no candidate
 * - Held account (manualHold or holdState=HELD) with no backstop row gives candidate
 * - Order outside --since/--until window is never a candidate
 * - Dry-run evaluates isBuyerHeldBeforeOrder (would-hold/would-skip)
 * - --apply holds via applyBackstop, writes 'held' row, tag and AuditEvent
 * - --apply with bypass account ends in 'skipped'
 * - Second --apply run is a no-op (already processed)
 * - Existing 'held' row gets skipped
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { requestContext } from "~/lib/request-context.server";
import { findCandidates, hasOfflineSession, processBackfill, parseArgs } from "../backstop-backfill";

const mockShopifyGraphQL = vi.fn();
vi.mock("~/services/shopify-client.server", () => ({
  shopifyGraphQLRequest: (...args: unknown[]) => mockShopifyGraphQL(...args),
}));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

describeWithDb("scripts/backstop-backfill", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-backfill";
  const TEST_SHOP_ID = `shop-backfill-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `backfill-test-${TEST_SUFFIX}.myshopify.com`;

  const WINDOW_START = new Date("2026-10-01T00:00:00Z");
  const WINDOW_END = new Date("2026-10-31T23:59:59Z");

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM backstop_processed_orders WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Session" WHERE shop = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  describe("parseArgs", () => {
    it("requires --since and --until", () => {
      const result = parseArgs(["--apply"]);
      expect(result.since).toBeNull();
      expect(result.until).toBeNull();
    });

    it("parses all arguments correctly", () => {
      const result = parseArgs([
        "--since", "2026-10-01",
        "--until", "2026-10-15",
        "--shop", "test.myshopify.com",
        "--apply"
      ]);
      expect(result.dryRun).toBe(false);
      expect(result.since?.toISOString()).toContain("2026-10-01");
      expect(result.until?.toISOString()).toContain("2026-10-15");
      expect(result.shopFilter).toBe("test.myshopify.com");
    });
  });

  describe("findCandidates", () => {
    const UNHELD_ACCOUNT_ID = `acc-unheld-${TEST_SUFFIX}`;
    const HELD_MANUAL_ACCOUNT_ID = `acc-held-manual-${TEST_SUFFIX}`;
    const HELD_STATE_ACCOUNT_ID = `acc-held-state-${TEST_SUFFIX}`;
    const ORDER_GID_1 = `gid://shopify/Order/backfill-1-${TEST_SUFFIX}`;
    const ORDER_GID_2 = `gid://shopify/Order/backfill-2-${TEST_SUFFIX}`;
    const ORDER_GID_3 = `gid://shopify/Order/backfill-3-${TEST_SUFFIX}`;
    const ORDER_GID_4 = `gid://shopify/Order/backfill-4-${TEST_SUFFIX}`;
    const ORDER_GID_OUTSIDE = `gid://shopify/Order/backfill-outside-${TEST_SUFFIX}`;
    const INVOICE_ID_1 = `inv-backfill-1-${TEST_SUFFIX}`;
    const INVOICE_ID_2 = `inv-backfill-2-${TEST_SUFFIX}`;
    const INVOICE_ID_3 = `inv-backfill-3-${TEST_SUFFIX}`;
    const INVOICE_ID_4 = `inv-backfill-4-${TEST_SUFFIX}`;
    const INVOICE_ID_OUTSIDE = `inv-backfill-outside-${TEST_SUFFIX}`;

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
          ${HELD_MANUAL_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
          ${"co-held-manual-" + TEST_SUFFIX}, ${"loc-held-manual-" + TEST_SUFFIX},
          'Held Manual Account', 100000.00, 'HELD', false, true, 'MANUAL_HOLD',
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
          ${HELD_STATE_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
          ${"co-held-state-" + TEST_SUFFIX}, ${"loc-held-state-" + TEST_SUFFIX},
          'Held State Account', 100000.00, 'HELD', false, false, 'CREDIT_REVIEW',
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
          '#BACKFILL-UNHELD', 50000.00, 50000.00, 'open', ${WINDOW_START}, ${WINDOW_START}, NOW()
        )
      `;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${INVOICE_ID_2}, ${TEST_SHOP_ID}, ${HELD_MANUAL_ACCOUNT_ID}, ${ORDER_GID_2},
          '#BACKFILL-HELD-MANUAL', 50000.00, 50000.00, 'open', ${WINDOW_START}, ${WINDOW_START}, NOW()
        )
      `;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${INVOICE_ID_3}, ${TEST_SHOP_ID}, ${HELD_MANUAL_ACCOUNT_ID}, ${ORDER_GID_3},
          '#BACKFILL-HELD-WITH-ROW', 50000.00, 50000.00, 'open', ${WINDOW_START}, ${WINDOW_START}, NOW()
        )
      `;

      await sql`
        INSERT INTO backstop_processed_orders (shop_id, order_gid, action, reason, processed_at)
        VALUES (${TEST_SHOP_ID}, ${ORDER_GID_3}, 'held', 'Manual hold', NOW())
      `;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${INVOICE_ID_4}, ${TEST_SHOP_ID}, ${HELD_STATE_ACCOUNT_ID}, ${ORDER_GID_4},
          '#BACKFILL-HELD-STATE', 50000.00, 50000.00, 'open', ${WINDOW_START}, ${WINDOW_START}, NOW()
        )
      `;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${INVOICE_ID_OUTSIDE}, ${TEST_SHOP_ID}, ${HELD_MANUAL_ACCOUNT_ID}, ${ORDER_GID_OUTSIDE},
          '#BACKFILL-OUTSIDE', 50000.00, 50000.00, 'open', '2026-09-01', '2026-09-01', NOW()
        )
      `;
    });

    afterAll(async () => {
      await sql`DELETE FROM backstop_processed_orders WHERE shop_id = ${TEST_SHOP_ID}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    });

    it("unheld account gives no candidate", async () => {
      const candidates = await findCandidates(sql, WINDOW_START, WINDOW_END, TEST_SHOP_DOMAIN);

      const unheldCandidate = candidates.find((c) => c.orderId === ORDER_GID_1);
      expect(unheldCandidate).toBeUndefined();
    });

    it("held account (manualHold) with no backstop row gives a candidate", async () => {
      const candidates = await findCandidates(sql, WINDOW_START, WINDOW_END, TEST_SHOP_DOMAIN);

      const heldCandidate = candidates.find((c) => c.orderId === ORDER_GID_2);
      expect(heldCandidate).toBeDefined();
      expect(heldCandidate!.buyerAccountId).toBe(HELD_MANUAL_ACCOUNT_ID);
      expect(heldCandidate!.shopId).toBe(TEST_SHOP_ID);
    });

    it("held account (holdState=HELD) with no backstop row gives a candidate", async () => {
      const candidates = await findCandidates(sql, WINDOW_START, WINDOW_END, TEST_SHOP_DOMAIN);

      const heldStateCandidate = candidates.find((c) => c.orderId === ORDER_GID_4);
      expect(heldStateCandidate).toBeDefined();
      expect(heldStateCandidate!.buyerAccountId).toBe(HELD_STATE_ACCOUNT_ID);
    });

    it("existing 'held' row gets skipped (not a candidate)", async () => {
      const candidates = await findCandidates(sql, WINDOW_START, WINDOW_END, TEST_SHOP_DOMAIN);

      const alreadyProcessedCandidate = candidates.find((c) => c.orderId === ORDER_GID_3);
      expect(alreadyProcessedCandidate).toBeUndefined();
    });

    it("order outside --since/--until window is never a candidate", async () => {
      const candidates = await findCandidates(sql, WINDOW_START, WINDOW_END, TEST_SHOP_DOMAIN);

      const outsideCandidate = candidates.find((c) => c.orderId === ORDER_GID_OUTSIDE);
      expect(outsideCandidate).toBeUndefined();
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
          ${INVOICE_ID_PENDING}, ${TEST_SHOP_ID}, ${HELD_MANUAL_ACCOUNT_ID}, ${ORDER_GID_PENDING},
          '#BACKFILL-PENDING', 50000.00, 50000.00, 'open', ${WINDOW_START}, ${WINDOW_START}, NOW()
        )
      `;

      await sql`
        INSERT INTO backstop_processed_orders (shop_id, order_gid, action, reason, processed_at)
        VALUES (${TEST_SHOP_ID}, ${ORDER_GID_PENDING}, 'pending', NULL, NOW() - INTERVAL '10 minutes')
      `;

      try {
        const candidates = await findCandidates(sql, WINDOW_START, WINDOW_END, TEST_SHOP_DOMAIN);
        const pendingCandidate = candidates.find((c) => c.orderId === ORDER_GID_PENDING);
        expect(pendingCandidate).toBeDefined();
      } finally {
        await sql`DELETE FROM backstop_processed_orders WHERE order_gid = ${ORDER_GID_PENDING}`;
        await sql`DELETE FROM "Invoice" WHERE id = ${INVOICE_ID_PENDING}`;
      }
    });
  });

  describe("hasOfflineSession", () => {
    const SESSION_ID = `offline_${TEST_SHOP_DOMAIN}`;

    beforeEach(async () => {
      await sql`DELETE FROM "Session" WHERE shop = ${TEST_SHOP_DOMAIN}`;
    });

    afterAll(async () => {
      await sql`DELETE FROM "Session" WHERE shop = ${TEST_SHOP_DOMAIN}`;
    });

    it("returns false when no offline session exists", async () => {
      const has = await hasOfflineSession(sql, TEST_SHOP_DOMAIN);
      expect(has).toBe(false);
    });

    it("returns false for online-only session", async () => {
      await sql`
        INSERT INTO "Session" (id, shop, state, "isOnline", scope, "accessToken")
        VALUES (${SESSION_ID + "-online"}, ${TEST_SHOP_DOMAIN}, 'state', true, 'read_products', 'shpua_online_token')
      `;

      const has = await hasOfflineSession(sql, TEST_SHOP_DOMAIN);
      expect(has).toBe(false);
    });

    it("returns true when offline session exists", async () => {
      await sql`
        INSERT INTO "Session" (id, shop, state, "isOnline", scope, "accessToken")
        VALUES (${SESSION_ID}, ${TEST_SHOP_DOMAIN}, 'state', false, 'read_products', 'shpat_offline_token')
      `;

      const has = await hasOfflineSession(sql, TEST_SHOP_DOMAIN);
      expect(has).toBe(true);
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

    it("dry-run evaluates would-hold and does not write", async () => {
      const candidates = [{
        invoiceId: INVOICE_ID,
        orderId: ORDER_GID,
        shopId: TEST_SHOP_ID,
        shopDomain: TEST_SHOP_DOMAIN,
        buyerAccountId: HELD_ACCOUNT_ID,
      }];

      const result = await requestContext.run({ getSql: () => sql }, async () => {
        return processBackfill(sql, candidates, true);
      });

      expect(result.candidates).toBe(1);
      expect(result.wouldHold).toBe(1);
      expect(result.wouldSkip).toBe(0);

      const [row] = await sql<{ action: string }[]>`
        SELECT action FROM backstop_processed_orders
        WHERE shop_id = ${TEST_SHOP_ID} AND order_gid = ${ORDER_GID}
      `;
      expect(row).toBeUndefined();
    });

    it("dry-run shows would-skip for bypass account", async () => {
      const BYPASS_ACCOUNT_ID = `acc-bypass-dryrun-${TEST_SUFFIX}`;
      const BYPASS_ORDER_GID = `gid://shopify/Order/backfill-dryrun-bypass-${TEST_SUFFIX}`;
      const BYPASS_INVOICE_ID = `inv-backfill-dryrun-bypass-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "creditLimit", "holdState", bypass, "manualHold", "holdReasonCode",
          "createdAt", "updatedAt"
        )
        VALUES (
          ${BYPASS_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
          ${"co-dryrun-bypass-" + TEST_SUFFIX}, ${"loc-dryrun-bypass-" + TEST_SUFFIX},
          'Bypass Dry Run Account', 100000.00, 'HELD', true, true, 'MANUAL_HOLD',
          NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${BYPASS_INVOICE_ID}, ${TEST_SHOP_ID}, ${BYPASS_ACCOUNT_ID}, ${BYPASS_ORDER_GID},
          '#BACKFILL-DRYRUN-BYPASS', 50000.00, 50000.00, 'open', NOW(), NOW(), NOW()
        )
      `;

      try {
        const bypassCandidate = [{
          invoiceId: BYPASS_INVOICE_ID,
          orderId: BYPASS_ORDER_GID,
          shopId: TEST_SHOP_ID,
          shopDomain: TEST_SHOP_DOMAIN,
          buyerAccountId: BYPASS_ACCOUNT_ID,
        }];

        const result = await requestContext.run({ getSql: () => sql }, async () => {
          return processBackfill(sql, bypassCandidate, true);
        });

        expect(result.candidates).toBe(1);
        expect(result.wouldHold).toBe(0);
        expect(result.wouldSkip).toBe(1);
      } finally {
        await sql`DELETE FROM "Invoice" WHERE id = ${BYPASS_INVOICE_ID}`;
        await sql`DELETE FROM "BuyerAccount" WHERE id = ${BYPASS_ACCOUNT_ID}`;
      }
    });

    it("dry-run shows would-skip for unheld account", async () => {
      const UNHELD_ACCOUNT_ID = `acc-unheld-dryrun-${TEST_SUFFIX}`;
      const UNHELD_ORDER_GID = `gid://shopify/Order/backfill-dryrun-unheld-${TEST_SUFFIX}`;
      const UNHELD_INVOICE_ID = `inv-backfill-dryrun-unheld-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "creditLimit", "holdState", bypass, "manualHold", "holdReasonCode",
          "createdAt", "updatedAt"
        )
        VALUES (
          ${UNHELD_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
          ${"co-dryrun-unheld-" + TEST_SUFFIX}, ${"loc-dryrun-unheld-" + TEST_SUFFIX},
          'Unheld Dry Run Account', 100000.00, 'OK', false, false, NULL,
          NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${UNHELD_INVOICE_ID}, ${TEST_SHOP_ID}, ${UNHELD_ACCOUNT_ID}, ${UNHELD_ORDER_GID},
          '#BACKFILL-DRYRUN-UNHELD', 50000.00, 50000.00, 'open', NOW(), NOW(), NOW()
        )
      `;

      try {
        const unheldCandidate = [{
          invoiceId: UNHELD_INVOICE_ID,
          orderId: UNHELD_ORDER_GID,
          shopId: TEST_SHOP_ID,
          shopDomain: TEST_SHOP_DOMAIN,
          buyerAccountId: UNHELD_ACCOUNT_ID,
        }];

        const result = await requestContext.run({ getSql: () => sql }, async () => {
          return processBackfill(sql, unheldCandidate, true);
        });

        expect(result.candidates).toBe(1);
        expect(result.wouldHold).toBe(0);
        expect(result.wouldSkip).toBe(1);
      } finally {
        await sql`DELETE FROM "Invoice" WHERE id = ${UNHELD_INVOICE_ID}`;
        await sql`DELETE FROM "BuyerAccount" WHERE id = ${UNHELD_ACCOUNT_ID}`;
      }
    });
  });

  describe("processBackfill --apply", () => {
    const HELD_ACCOUNT_ID = `acc-held-apply-${TEST_SUFFIX}`;
    const BYPASS_ACCOUNT_ID = `acc-bypass-apply-${TEST_SUFFIX}`;
    const ORDER_GID = `gid://shopify/Order/backfill-apply-${TEST_SUFFIX}`;
    const BYPASS_ORDER_GID = `gid://shopify/Order/backfill-apply-bypass-${TEST_SUFFIX}`;
    const INVOICE_ID = `inv-backfill-apply-${TEST_SUFFIX}`;
    const BYPASS_INVOICE_ID = `inv-backfill-apply-bypass-${TEST_SUFFIX}`;
    const FO_GID = `gid://shopify/FulfillmentOrder/apply-${TEST_SUFFIX}`;

    beforeAll(async () => {
      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "creditLimit", "holdState", bypass, "manualHold", "holdReasonCode",
          "createdAt", "updatedAt"
        )
        VALUES (
          ${HELD_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
          ${"co-apply-" + TEST_SUFFIX}, ${"loc-apply-" + TEST_SUFFIX},
          'Apply Test Account', 100000.00, 'HELD', false, true, 'MANUAL_HOLD',
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
          ${BYPASS_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
          ${"co-apply-bypass-" + TEST_SUFFIX}, ${"loc-apply-bypass-" + TEST_SUFFIX},
          'Bypass Apply Account', 100000.00, 'HELD', true, true, 'MANUAL_HOLD',
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
          '#BACKFILL-APPLY', 50000.00, 50000.00, 'open', NOW(), NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${BYPASS_INVOICE_ID}, ${TEST_SHOP_ID}, ${BYPASS_ACCOUNT_ID}, ${BYPASS_ORDER_GID},
          '#BACKFILL-APPLY-BYPASS', 50000.00, 50000.00, 'open', NOW(), NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "Session" (id, shop, state, "isOnline", scope, "accessToken", expires)
        VALUES (
          ${"offline_" + TEST_SHOP_DOMAIN},
          ${TEST_SHOP_DOMAIN},
          'state',
          false,
          'read_products,write_merchant_managed_fulfillment_orders,write_orders',
          'shpat_apply_token',
          ${new Date(Date.now() + 60 * 60 * 1000).toISOString()}
        )
        ON CONFLICT (id) DO UPDATE SET
          "accessToken" = EXCLUDED."accessToken",
          expires = EXCLUDED.expires
      `;
    });

    beforeEach(async () => {
      mockShopifyGraphQL.mockReset();
      await sql`DELETE FROM backstop_processed_orders WHERE order_gid IN (${ORDER_GID}, ${BYPASS_ORDER_GID})`;
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    });

    afterAll(async () => {
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
      await sql`DELETE FROM backstop_processed_orders WHERE order_gid IN (${ORDER_GID}, ${BYPASS_ORDER_GID})`;
      await sql`DELETE FROM "Invoice" WHERE id IN (${INVOICE_ID}, ${BYPASS_INVOICE_ID})`;
      await sql`DELETE FROM "BuyerAccount" WHERE id IN (${HELD_ACCOUNT_ID}, ${BYPASS_ACCOUNT_ID})`;
    });

    it("--apply holds via applyBackstop, writes 'held' row, tag and AuditEvent", async () => {
      mockShopifyGraphQL
        .mockResolvedValueOnce({
          success: true,
          data: {
            order: {
              fulfillmentOrders: {
                edges: [
                  {
                    node: {
                      id: FO_GID,
                      status: "OPEN",
                      supportedActions: [{ action: "HOLD" }],
                    },
                  },
                ],
              },
            },
          },
        })
        .mockResolvedValueOnce({
          success: true,
          data: {
            fulfillmentOrderHold: {
              fulfillmentOrder: { id: FO_GID, status: "ON_HOLD" },
              userErrors: [],
            },
          },
        })
        .mockResolvedValueOnce({
          success: true,
          data: {
            tagsAdd: {
              node: { id: ORDER_GID },
              userErrors: [],
            },
          },
        });

      const candidates = [{
        invoiceId: INVOICE_ID,
        orderId: ORDER_GID,
        shopId: TEST_SHOP_ID,
        shopDomain: TEST_SHOP_DOMAIN,
        buyerAccountId: HELD_ACCOUNT_ID,
      }];

      const result = await requestContext.run({ getSql: () => sql }, async () => {
        return processBackfill(sql, candidates, false);
      });

      expect(result.applied).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.errors).toBe(0);

      expect(mockShopifyGraphQL).toHaveBeenCalledTimes(3);

      const holdCall = mockShopifyGraphQL.mock.calls[1];
      expect(holdCall[1]).toContain("fulfillmentOrderHold");
      expect(holdCall[2].id).toBe(FO_GID);

      const tagCall = mockShopifyGraphQL.mock.calls[2];
      expect(tagCall[1]).toContain("tagsAdd");
      expect(tagCall[2].tags).toContain("ntr-credit-hold");

      const [row] = await sql<{ action: string }[]>`
        SELECT action FROM backstop_processed_orders
        WHERE shop_id = ${TEST_SHOP_ID} AND order_gid = ${ORDER_GID}
      `;
      expect(row).toBeDefined();
      expect(row.action).toBe("held");

      const [auditEvent] = await sql<{ type: string; data: unknown }[]>`
        SELECT type, data FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID} AND type = 'backstop.hold_applied'
        ORDER BY at DESC LIMIT 1
      `;
      expect(auditEvent).toBeDefined();
      expect(auditEvent.type).toBe("backstop.hold_applied");
    });

    it("--apply with bypass account ends in 'skipped'", async () => {
      const candidates = [{
        invoiceId: BYPASS_INVOICE_ID,
        orderId: BYPASS_ORDER_GID,
        shopId: TEST_SHOP_ID,
        shopDomain: TEST_SHOP_DOMAIN,
        buyerAccountId: BYPASS_ACCOUNT_ID,
      }];

      const result = await requestContext.run({ getSql: () => sql }, async () => {
        return processBackfill(sql, candidates, false);
      });

      expect(result.applied).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.errors).toBe(0);

      expect(mockShopifyGraphQL).not.toHaveBeenCalled();

      const [row] = await sql<{ action: string }[]>`
        SELECT action FROM backstop_processed_orders
        WHERE shop_id = ${TEST_SHOP_ID} AND order_gid = ${BYPASS_ORDER_GID}
      `;
      expect(row).toBeDefined();
      expect(row.action).toBe("skipped");
    });

    it("second --apply run is a no-op (already processed)", async () => {
      await sql`
        INSERT INTO backstop_processed_orders (shop_id, order_gid, action, reason, processed_at)
        VALUES (${TEST_SHOP_ID}, ${ORDER_GID}, 'held', 'Manual hold', NOW())
      `;

      const candidates = [{
        invoiceId: INVOICE_ID,
        orderId: ORDER_GID,
        shopId: TEST_SHOP_ID,
        shopDomain: TEST_SHOP_DOMAIN,
        buyerAccountId: HELD_ACCOUNT_ID,
      }];

      const result = await requestContext.run({ getSql: () => sql }, async () => {
        return processBackfill(sql, candidates, false);
      });

      expect(result.applied).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.errors).toBe(0);

      expect(mockShopifyGraphQL).not.toHaveBeenCalled();

      const [row] = await sql<{ action: string }[]>`
        SELECT action FROM backstop_processed_orders
        WHERE shop_id = ${TEST_SHOP_ID} AND order_gid = ${ORDER_GID}
      `;
      expect(row.action).toBe("held");
    });
  });
});
