/**
 * DB-backed integration tests for backstop-backfill.ts script.
 * Uses the CI pgmq Postgres service.
 *
 * Tests:
 * - Unheld account gives no candidate
 * - Held account (manualHold or holdState=HELD) with no backstop row gives candidate
 * - Order outside --since/--until window (by issuedAt) is never a candidate
 * - createdAt inside window but issuedAt outside = not a candidate
 * - Dry-run evaluates isBuyerHeldBeforeOrder (would-hold/would-skip with reason codes)
 * - --apply with held account ends in action='held' (global.fetch stubbed)
 * - --apply with bypass account ends in 'skipped'
 * - Second --apply run is a no-op (already processed)
 * - evaluateBackstop decision equals applyBackstop outcome
 * - parseArgs rejects flag used as value (e.g. --shop --apply)
 * - Dry-run runs reads inside READ ONLY transaction (assertReadOnlyTransaction)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { requestContext } from "~/lib/request-context.server";
import { _resetShopifyAppForTesting } from "~/shopify.server";
import { setAbstractFetchFunc } from "@shopify/shopify-api/runtime";
import { findCandidates, hasOfflineSession, processBackfill, parseArgs, assertReadOnlyTransaction, formatFatal } from "../backstop-backfill";

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
    setAbstractFetchFunc(originalFetch);
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

    it("rejects --shop with flag as value", () => {
      const result = parseArgs(["--shop", "--apply", "--since", "2026-10-01", "--until", "2026-10-15"]);
      expect(result.argError).toBe("--shop requires a value, got flag '--apply'");
    });

    it("rejects --since with flag as value", () => {
      const result = parseArgs(["--since", "--until", "2026-10-15"]);
      expect(result.argError).toBe("--since requires a value, got flag '--until'");
    });

    it("rejects --until with flag as value", () => {
      const result = parseArgs(["--since", "2026-10-01", "--until", "--apply"]);
      expect(result.argError).toBe("--until requires a value, got flag '--apply'");
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
    const ORDER_GID_CREATED_IN_ISSUED_OUT = `gid://shopify/Order/backfill-created-in-issued-out-${TEST_SUFFIX}`;
    const INVOICE_ID_1 = `inv-backfill-1-${TEST_SUFFIX}`;
    const INVOICE_ID_2 = `inv-backfill-2-${TEST_SUFFIX}`;
    const INVOICE_ID_3 = `inv-backfill-3-${TEST_SUFFIX}`;
    const INVOICE_ID_4 = `inv-backfill-4-${TEST_SUFFIX}`;
    const INVOICE_ID_OUTSIDE = `inv-backfill-outside-${TEST_SUFFIX}`;
    const INVOICE_ID_CREATED_IN_ISSUED_OUT = `inv-backfill-created-in-issued-out-${TEST_SUFFIX}`;

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

      // issuedAt OUTSIDE window (order date Sep 1)
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

      // createdAt INSIDE window but issuedAt OUTSIDE (order.processedAt was Sep 15)
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${INVOICE_ID_CREATED_IN_ISSUED_OUT}, ${TEST_SHOP_ID}, ${HELD_MANUAL_ACCOUNT_ID}, ${ORDER_GID_CREATED_IN_ISSUED_OUT},
          '#BACKFILL-CREATED-IN-ISSUED-OUT', 50000.00, 50000.00, 'open', '2026-09-15', ${WINDOW_START}, NOW()
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

    it("order with issuedAt outside --since/--until window is never a candidate", async () => {
      const candidates = await findCandidates(sql, WINDOW_START, WINDOW_END, TEST_SHOP_DOMAIN);

      const outsideCandidate = candidates.find((c) => c.orderId === ORDER_GID_OUTSIDE);
      expect(outsideCandidate).toBeUndefined();
    });

    it("createdAt inside window but issuedAt outside = not a candidate (filters on order date)", async () => {
      // This tests that we filter on issuedAt (order.processedAt ?? order.createdAt per order.server.ts:259)
      // not on Invoice.createdAt (DB row creation time)
      const candidates = await findCandidates(sql, WINDOW_START, WINDOW_END, TEST_SHOP_DOMAIN);

      const createdInIssuedOutCandidate = candidates.find((c) => c.orderId === ORDER_GID_CREATED_IN_ISSUED_OUT);
      expect(createdInIssuedOutCandidate).toBeUndefined();
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

    it("returns true when non-expired offline session exists", async () => {
      await sql`
        INSERT INTO "Session" (id, shop, state, "isOnline", scope, "accessToken", expires)
        VALUES (${SESSION_ID}, ${TEST_SHOP_DOMAIN}, 'state', false, 'read_products', 'shpat_offline_token', ${new Date(Date.now() + 3600000).toISOString()})
      `;

      const has = await hasOfflineSession(sql, TEST_SHOP_DOMAIN);
      expect(has).toBe(true);
    });

    it("returns true when offline session has null expires (never expires)", async () => {
      await sql`
        INSERT INTO "Session" (id, shop, state, "isOnline", scope, "accessToken", expires)
        VALUES (${SESSION_ID + "-null"}, ${TEST_SHOP_DOMAIN}, 'state', false, 'read_products', 'shpat_offline_token', NULL)
      `;

      const has = await hasOfflineSession(sql, TEST_SHOP_DOMAIN);
      expect(has).toBe(true);
    });

    it("returns false when offline session is expired", async () => {
      await sql`
        INSERT INTO "Session" (id, shop, state, "isOnline", scope, "accessToken", expires)
        VALUES (${SESSION_ID + "-expired"}, ${TEST_SHOP_DOMAIN}, 'state', false, 'read_products', 'shpat_expired_token', ${new Date(Date.now() - 3600000).toISOString()})
      `;

      const has = await hasOfflineSession(sql, TEST_SHOP_DOMAIN);
      expect(has).toBe(false);
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
        INSERT INTO "Session" (id, shop, state, "isOnline", scope, "accessToken", expires)
        VALUES (${"offline_" + TEST_SHOP_DOMAIN}, ${TEST_SHOP_DOMAIN}, 'state', false, 'read_products', 'shpat_dryrun_token', ${new Date(Date.now() + 3600000).toISOString()})
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

    it("dry-run shows would-skip with 'bypass' reason code for bypass account", async () => {
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

        // Capture console output to verify reason code
        const logs: string[] = [];
        const originalLog = console.log;
        console.log = (...args) => { logs.push(args.join(" ")); };

        try {
          const result = await requestContext.run({ getSql: () => sql }, async () => {
            return processBackfill(sql, bypassCandidate, true);
          });

          expect(result.candidates).toBe(1);
          expect(result.wouldHold).toBe(0);
          expect(result.wouldSkip).toBe(1);

          // Verify the log contains 'bypass' reason code, not 'not_held'
          const bypassLog = logs.find(l => l.includes("would-skip"));
          expect(bypassLog).toContain("bypass");
          expect(bypassLog).not.toContain("not_held");
        } finally {
          console.log = originalLog;
        }
      } finally {
        await sql`DELETE FROM "Invoice" WHERE id = ${BYPASS_INVOICE_ID}`;
        await sql`DELETE FROM "BuyerAccount" WHERE id = ${BYPASS_ACCOUNT_ID}`;
      }
    });

    it("dry-run shows would-skip with 'not_held' reason code for unheld account", async () => {
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

  describe("evaluateBackstop and applyBackstop agreement", () => {
    it("evaluateBackstop decision equals applyBackstop outcome for held, bypass, unheld, already-held", async () => {
      const { evaluateBackstop, applyBackstop } = await import("~/services/backstop.server");

      const HELD_ACCOUNT = `acc-agree-held-${TEST_SUFFIX}`;
      const BYPASS_ACCOUNT = `acc-agree-bypass-${TEST_SUFFIX}`;
      const UNHELD_ACCOUNT = `acc-agree-unheld-${TEST_SUFFIX}`;
      const ALREADY_HELD_ACCOUNT = `acc-agree-already-${TEST_SUFFIX}`;

      const makeOrderGid = (name: string) => `gid://shopify/Order/agree-${name}-${TEST_SUFFIX}`;
      const makeInvoiceId = (name: string) => `inv-agree-${name}-${TEST_SUFFIX}`;

      // Create accounts
      await sql`
        INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", bypass, "manualHold", "holdReasonCode", "createdAt", "updatedAt")
        VALUES
        (${HELD_ACCOUNT}, ${TEST_SHOP_ID}, 'COMPANY', ${"co-agree-held-" + TEST_SUFFIX}, ${"loc-agree-held-" + TEST_SUFFIX}, 'Held', 100000.00, 'HELD', false, true, 'MANUAL_HOLD', NOW(), NOW()),
        (${BYPASS_ACCOUNT}, ${TEST_SHOP_ID}, 'COMPANY', ${"co-agree-bypass-" + TEST_SUFFIX}, ${"loc-agree-bypass-" + TEST_SUFFIX}, 'Bypass', 100000.00, 'HELD', true, true, 'MANUAL_HOLD', NOW(), NOW()),
        (${UNHELD_ACCOUNT}, ${TEST_SHOP_ID}, 'COMPANY', ${"co-agree-unheld-" + TEST_SUFFIX}, ${"loc-agree-unheld-" + TEST_SUFFIX}, 'Unheld', 100000.00, 'OK', false, false, NULL, NOW(), NOW()),
        (${ALREADY_HELD_ACCOUNT}, ${TEST_SHOP_ID}, 'COMPANY', ${"co-agree-already-" + TEST_SUFFIX}, ${"loc-agree-already-" + TEST_SUFFIX}, 'Already', 100000.00, 'HELD', false, true, 'MANUAL_HOLD', NOW(), NOW())
      `;

      // Create invoices
      await sql`
        INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status, "issuedAt", "createdAt", "updatedAt")
        VALUES
        (${makeInvoiceId("held")}, ${TEST_SHOP_ID}, ${HELD_ACCOUNT}, ${makeOrderGid("held")}, '#AGREE-HELD', 50000.00, 50000.00, 'open', NOW(), NOW(), NOW()),
        (${makeInvoiceId("bypass")}, ${TEST_SHOP_ID}, ${BYPASS_ACCOUNT}, ${makeOrderGid("bypass")}, '#AGREE-BYPASS', 50000.00, 50000.00, 'open', NOW(), NOW(), NOW()),
        (${makeInvoiceId("unheld")}, ${TEST_SHOP_ID}, ${UNHELD_ACCOUNT}, ${makeOrderGid("unheld")}, '#AGREE-UNHELD', 50000.00, 50000.00, 'open', NOW(), NOW(), NOW()),
        (${makeInvoiceId("already")}, ${TEST_SHOP_ID}, ${ALREADY_HELD_ACCOUNT}, ${makeOrderGid("already")}, '#AGREE-ALREADY', 50000.00, 50000.00, 'open', NOW(), NOW(), NOW())
      `;

      // Mark already-held as processed
      await sql`
        INSERT INTO backstop_processed_orders (shop_id, order_gid, action, reason, processed_at)
        VALUES (${TEST_SHOP_ID}, ${makeOrderGid("already")}, 'held', 'Manual hold', NOW())
      `;

      try {
        await requestContext.run({ getSql: () => sql }, async () => {
          // Test HELD: evaluateBackstop says wouldApply, applyBackstop would apply (but we can't actually call it without mocking GraphQL)
          const heldEval = await evaluateBackstop(sql, {
            shopDomain: TEST_SHOP_DOMAIN,
            shopId: TEST_SHOP_ID,
            orderGid: makeOrderGid("held"),
            buyerAccountId: HELD_ACCOUNT,
            invoiceId: makeInvoiceId("held"),
          });
          expect(heldEval.wouldApply).toBe(true);
          expect(heldEval.reasonCode).toBe("would_hold");

          // Test BYPASS: evaluateBackstop says skip with bypass reason
          const bypassEval = await evaluateBackstop(sql, {
            shopDomain: TEST_SHOP_DOMAIN,
            shopId: TEST_SHOP_ID,
            orderGid: makeOrderGid("bypass"),
            buyerAccountId: BYPASS_ACCOUNT,
            invoiceId: makeInvoiceId("bypass"),
          });
          expect(bypassEval.wouldApply).toBe(false);
          expect(bypassEval.reasonCode).toBe("bypass");

          // Test UNHELD: evaluateBackstop says skip with not_held reason
          const unheldEval = await evaluateBackstop(sql, {
            shopDomain: TEST_SHOP_DOMAIN,
            shopId: TEST_SHOP_ID,
            orderGid: makeOrderGid("unheld"),
            buyerAccountId: UNHELD_ACCOUNT,
            invoiceId: makeInvoiceId("unheld"),
          });
          expect(unheldEval.wouldApply).toBe(false);
          expect(unheldEval.reasonCode).toBe("not_held");

          // Test ALREADY-HELD: evaluateBackstop says skip with already_held reason
          const alreadyEval = await evaluateBackstop(sql, {
            shopDomain: TEST_SHOP_DOMAIN,
            shopId: TEST_SHOP_ID,
            orderGid: makeOrderGid("already"),
            buyerAccountId: ALREADY_HELD_ACCOUNT,
            invoiceId: makeInvoiceId("already"),
          });
          expect(alreadyEval.wouldApply).toBe(false);
          expect(alreadyEval.reasonCode).toBe("already_held");

          // Now verify applyBackstop agrees for bypass and unheld (no GraphQL needed)
          const bypassApply = await applyBackstop(sql, {
            shopDomain: TEST_SHOP_DOMAIN,
            shopId: TEST_SHOP_ID,
            orderGid: makeOrderGid("bypass"),
            buyerAccountId: BYPASS_ACCOUNT,
            invoiceId: makeInvoiceId("bypass"),
          });
          expect(bypassApply.applied).toBe(false);
          expect(bypassApply.skipReason).toBe("Bypass active");

          const unheldApply = await applyBackstop(sql, {
            shopDomain: TEST_SHOP_DOMAIN,
            shopId: TEST_SHOP_ID,
            orderGid: makeOrderGid("unheld"),
            buyerAccountId: UNHELD_ACCOUNT,
            invoiceId: makeInvoiceId("unheld"),
          });
          expect(unheldApply.applied).toBe(false);
          expect(unheldApply.skipped).toBe(true);

          const alreadyApply = await applyBackstop(sql, {
            shopDomain: TEST_SHOP_DOMAIN,
            shopId: TEST_SHOP_ID,
            orderGid: makeOrderGid("already"),
            buyerAccountId: ALREADY_HELD_ACCOUNT,
            invoiceId: makeInvoiceId("already"),
          });
          expect(alreadyApply.applied).toBe(false);
          expect(alreadyApply.skipReason).toContain("Already processed");
        });
      } finally {
        await sql`DELETE FROM backstop_processed_orders WHERE shop_id = ${TEST_SHOP_ID} AND order_gid LIKE ${"gid://shopify/Order/agree-%"}`;
        await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID} AND id LIKE ${"inv-agree-%"}`;
        await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID} AND id LIKE ${"acc-agree-%"}`;
      }
    });
  });

  describe("processBackfill --apply (fetch stubbed)", () => {
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
      await sql`DELETE FROM backstop_processed_orders WHERE order_gid IN (${ORDER_GID}, ${BYPASS_ORDER_GID})`;
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    });

    afterAll(async () => {
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
      await sql`DELETE FROM backstop_processed_orders WHERE order_gid IN (${ORDER_GID}, ${BYPASS_ORDER_GID})`;
      await sql`DELETE FROM "Invoice" WHERE id IN (${INVOICE_ID}, ${BYPASS_INVOICE_ID})`;
      await sql`DELETE FROM "BuyerAccount" WHERE id IN (${HELD_ACCOUNT_ID}, ${BYPASS_ACCOUNT_ID})`;
    });

    it("--apply with held account ends in action='held' (fetch stubbed)", async () => {
      const fetchCalls: { url: string; body: string }[] = [];

      const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        let url: string;
        let body = "";

        if (input instanceof Request) {
          url = input.url;
          body = await input.clone().text().catch(() => "");
        } else {
          url = typeof input === "string" ? input : input.toString();
          body = typeof init?.body === "string" ? init.body : "";
        }

        fetchCalls.push({ url, body });

        if (url.includes("/admin/api/") && url.includes("/graphql.json")) {
          let query = "";
          try {
            const parsed = JSON.parse(body);
            query = parsed.query || "";
          } catch {
            query = body;
          }

          if (query.includes("GetFulfillmentOrders") || query.includes("fulfillmentOrders")) {
            return new Response(JSON.stringify({
              data: {
                order: {
                  fulfillmentOrders: {
                    edges: [{
                      node: {
                        id: FO_GID,
                        status: "OPEN",
                        supportedActions: [{ action: "HOLD" }],
                      }
                    }]
                  }
                }
              }
            }), { status: 200, headers: { "Content-Type": "application/json" } });
          }

          if (query.includes("FulfillmentOrderHold") || query.includes("fulfillmentOrderHold")) {
            return new Response(JSON.stringify({
              data: {
                fulfillmentOrderHold: {
                  fulfillmentOrder: { id: FO_GID, status: "ON_HOLD" },
                  userErrors: []
                }
              }
            }), { status: 200, headers: { "Content-Type": "application/json" } });
          }

          if (query.includes("TagsAdd") || query.includes("tagsAdd")) {
            return new Response(JSON.stringify({
              data: {
                tagsAdd: {
                  node: { id: ORDER_GID },
                  userErrors: []
                }
              }
            }), { status: 200, headers: { "Content-Type": "application/json" } });
          }

          return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
        }

        return originalFetch(input, init);
      });

      setAbstractFetchFunc(mockFetch as typeof fetch);

      _resetShopifyAppForTesting();
      process.env.SHOPIFY_API_KEY = "test-api-key";
      process.env.SHOPIFY_API_SECRET = "test-api-secret";
      (process.env as Record<string, string>).SHOPIFY_APP_URL = "https://test.example.com";

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

      const [row] = await sql<{ action: string }[]>`
        SELECT action FROM backstop_processed_orders
        WHERE shop_id = ${TEST_SHOP_ID} AND order_gid = ${ORDER_GID}
      `;
      expect(row).toBeDefined();
      expect(row.action).toBe("held");

      const tagsCalls = fetchCalls.filter(c => c.body.includes("tagsAdd") || c.body.includes("TagsAdd"));
      expect(tagsCalls.length).toBeGreaterThan(0);

      const [auditEvent] = await sql<{ type: string; data: { orderGid: string } }[]>`
        SELECT type, data FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID} AND type = 'backstop.hold_applied'
      `;
      expect(auditEvent).toBeDefined();
      expect(auditEvent.type).toBe("backstop.hold_applied");
      expect(auditEvent.data.orderGid).toBe(ORDER_GID);
    });

    it("--apply with bypass account ends in 'skipped' (no GraphQL needed)", async () => {
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

      const [row] = await sql<{ action: string }[]>`
        SELECT action FROM backstop_processed_orders
        WHERE shop_id = ${TEST_SHOP_ID} AND order_gid = ${ORDER_GID}
      `;
      expect(row.action).toBe("held");
    });
  });

  describe("assertReadOnlyTransaction", () => {
    it("passes inside a READ ONLY transaction", async () => {
      await sql.begin("read only", async (tx) => {
        await expect(assertReadOnlyTransaction(tx)).resolves.toBeUndefined();
      });
    });

    it("throws outside a READ ONLY transaction", async () => {
      await expect(assertReadOnlyTransaction(sql)).rejects.toThrow(
        "Dry-run safety check failed: transaction_read_only is not 'on'"
      );
    });

    it("throws inside a normal (read-write) transaction", async () => {
      await sql.begin(async (tx) => {
        await expect(assertReadOnlyTransaction(tx)).rejects.toThrow(
          "Dry-run safety check failed: transaction_read_only is not 'on'"
        );
      });
    });
  });

  describe("dry-run read-only transaction safety", () => {
    it("writes are rejected inside READ ONLY transaction with SQLSTATE 25006", async () => {
      let caughtError: { code?: string } | null = null;

      try {
        await sql.begin("read only", async (tx) => {
          await tx`CREATE TEMP TABLE _test_dryrun_write (id int)`;
        });
      } catch (e) {
        caughtError = e as { code?: string };
      }

      expect(caughtError).not.toBeNull();
      expect(caughtError!.code).toBe("25006");
    });

    it("findCandidates works inside a READ ONLY transaction", async () => {
      const WINDOW_START = new Date("2026-10-01T00:00:00Z");
      const WINDOW_END = new Date("2026-10-31T23:59:59Z");

      await sql.begin("read only", async (tx) => {
        await assertReadOnlyTransaction(tx);
        const candidates = await findCandidates(tx, WINDOW_START, WINDOW_END, TEST_SHOP_DOMAIN);
        expect(Array.isArray(candidates)).toBe(true);
      });
    });

    it("hasOfflineSession works inside a READ ONLY transaction", async () => {
      await sql.begin("read only", async (tx) => {
        await assertReadOnlyTransaction(tx);
        const has = await hasOfflineSession(tx, TEST_SHOP_DOMAIN);
        expect(typeof has).toBe("boolean");
      });
    });

    it("processBackfill dry-run works inside a READ ONLY transaction", async () => {
      const HELD_ACCOUNT_ID = `acc-readonly-test-${Date.now().toString(36)}`;
      const ORDER_GID = `gid://shopify/Order/readonly-test-${Date.now().toString(36)}`;
      const INVOICE_ID = `inv-readonly-test-${Date.now().toString(36)}`;

      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "creditLimit", "holdState", bypass, "manualHold", "holdReasonCode",
          "createdAt", "updatedAt"
        )
        VALUES (
          ${HELD_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
          ${"co-readonly-" + Date.now().toString(36)}, ${"loc-readonly-" + Date.now().toString(36)},
          'Read Only Test Account', 100000.00, 'HELD', false, true, 'MANUAL_HOLD',
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
          '#READONLY-TEST', 50000.00, 50000.00, 'open', NOW(), NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "Session" (id, shop, state, "isOnline", scope, "accessToken", expires)
        VALUES (${"offline_readonly_" + TEST_SHOP_DOMAIN}, ${TEST_SHOP_DOMAIN}, 'state', false, 'read_products', 'shpat_readonly_token', ${new Date(Date.now() + 3600000).toISOString()})
        ON CONFLICT (id) DO NOTHING
      `;

      try {
        await sql.begin("read only", async (tx) => {
          await assertReadOnlyTransaction(tx);

          const candidates = [{
            invoiceId: INVOICE_ID,
            orderId: ORDER_GID,
            shopId: TEST_SHOP_ID,
            shopDomain: TEST_SHOP_DOMAIN,
            buyerAccountId: HELD_ACCOUNT_ID,
          }];

          const result = await requestContext.run({ getSql: () => tx }, async () => {
            return processBackfill(tx, candidates, true);
          });

          expect(result.candidates).toBe(1);
          expect(result.wouldHold + result.wouldSkip).toBeGreaterThanOrEqual(1);
        });
      } finally {
        await sql`DELETE FROM "Invoice" WHERE id = ${INVOICE_ID}`;
        await sql`DELETE FROM "BuyerAccount" WHERE id = ${HELD_ACCOUNT_ID}`;
        await sql`DELETE FROM "Session" WHERE id = ${"offline_readonly_" + TEST_SHOP_DOMAIN}`;
      }
    });
  });

  describe("logging safety (X1, X2, X4)", () => {
    it("formatFatal returns error type, not message", () => {
      const sentinelMessage = "SENTINEL_DOMAIN.myshopify.com error with secret@email.com";
      
      const errorResult = formatFatal(new Error(sentinelMessage));
      expect(errorResult).toBe("Error");
      expect(errorResult).not.toContain(sentinelMessage);
      expect(errorResult).not.toContain("myshopify");
      expect(errorResult).not.toContain("@");
      
      class CustomBackstopError extends Error {}
      const customResult = formatFatal(new CustomBackstopError(sentinelMessage));
      expect(customResult).toBe("CustomBackstopError");
      expect(customResult).not.toContain(sentinelMessage);
      
      expect(formatFatal("string error")).toBe("string");
      expect(formatFatal(42)).toBe("number");
      expect(formatFatal(null)).toBe("object");
      expect(formatFatal(undefined)).toBe("undefined");
    });

    it("error logs use toErrorCode, not raw messages (dry-run path)", async () => {
      const ORDER_GID_ERROR = `gid://shopify/Order/error-logging-${TEST_SUFFIX}`;
      const INVOICE_ID_ERROR = `inv-error-logging-${TEST_SUFFIX}`;
      const HELD_ACCOUNT_ERROR = `acc-error-logging-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "creditLimit", "holdState", bypass, "manualHold", "holdReasonCode",
          "createdAt", "updatedAt"
        )
        VALUES (
          ${HELD_ACCOUNT_ERROR}, ${TEST_SHOP_ID}, 'COMPANY',
          ${"co-error-" + TEST_SUFFIX}, ${"loc-error-" + TEST_SUFFIX},
          'Error Logging Test', 100000.00, 'HELD', false, true, 'MANUAL_HOLD',
          NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${INVOICE_ID_ERROR}, ${TEST_SHOP_ID}, ${HELD_ACCOUNT_ERROR}, ${ORDER_GID_ERROR},
          '#ERROR-LOGGING', 50000.00, 50000.00, 'open', NOW(), NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "Session" (id, shop, state, "isOnline", scope, "accessToken", expires)
        VALUES (${"offline_errorlog_" + TEST_SHOP_DOMAIN}, ${TEST_SHOP_DOMAIN}, 'state', false, 'read_products', 'shpat_test', ${new Date(Date.now() + 3600000).toISOString()})
        ON CONFLICT (id) DO NOTHING
      `;

      try {
        const logs: string[] = [];
        const originalLog = console.log;
        console.log = (...args) => { logs.push(args.join(" ")); };

        try {
          const candidates = [{
            invoiceId: INVOICE_ID_ERROR,
            orderId: ORDER_GID_ERROR,
            shopId: TEST_SHOP_ID,
            shopDomain: TEST_SHOP_DOMAIN,
            buyerAccountId: HELD_ACCOUNT_ERROR,
          }];

          await requestContext.run({ getSql: () => sql }, async () => {
            await processBackfill(sql, candidates, true);
          });

          const allOutput = logs.join("\n");
          expect(allOutput).not.toContain(".myshopify.com");
          expect(allOutput).not.toMatch(/@[^\s]+\.[^\s]+/);
          expect(allOutput).not.toMatch(/\d{5,}/);
        } finally {
          console.log = originalLog;
        }
      } finally {
        await sql`DELETE FROM "Invoice" WHERE id = ${INVOICE_ID_ERROR}`;
        await sql`DELETE FROM "BuyerAccount" WHERE id = ${HELD_ACCOUNT_ERROR}`;
        await sql`DELETE FROM "Session" WHERE id = ${"offline_errorlog_" + TEST_SHOP_DOMAIN}`;
      }
    });

    it("error output contains err= prefix with error codes, not raw messages", async () => {
      const ORDER_GID_ERRCODE = `gid://shopify/Order/errcode-${TEST_SUFFIX}`;
      const INVOICE_ID_ERRCODE = `inv-errcode-${TEST_SUFFIX}`;
      const HELD_ACCOUNT_ERRCODE = `acc-errcode-${TEST_SUFFIX}`;
      const DOMAIN_SENTINEL = `sentinel-${TEST_SUFFIX}.myshopify.com`;

      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "creditLimit", "holdState", bypass, "manualHold", "holdReasonCode",
          "createdAt", "updatedAt"
        )
        VALUES (
          ${HELD_ACCOUNT_ERRCODE}, ${TEST_SHOP_ID}, 'COMPANY',
          ${"co-errcode-" + TEST_SUFFIX}, ${"loc-errcode-" + TEST_SUFFIX},
          'Error Code Test', 100000.00, 'HELD', false, true, 'MANUAL_HOLD',
          NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${INVOICE_ID_ERRCODE}, ${TEST_SHOP_ID}, ${HELD_ACCOUNT_ERRCODE}, ${ORDER_GID_ERRCODE},
          '#ERRCODE', 50000.00, 50000.00, 'open', NOW(), NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "Session" (id, shop, state, "isOnline", scope, "accessToken", expires)
        VALUES (${"offline_errcode_" + TEST_SHOP_DOMAIN}, ${TEST_SHOP_DOMAIN}, 'state', false, 'read_products', 'shpat_test', ${new Date(Date.now() + 3600000).toISOString()})
        ON CONFLICT (id) DO NOTHING
      `;

      try {
        const logs: string[] = [];
        const originalLog = console.log;
        console.log = (...args) => { logs.push(args.join(" ")); };

        const mockEvaluateBackstop = vi.fn().mockRejectedValue(
          new Error(`Network error for shop ${DOMAIN_SENTINEL}: ECONNREFUSED secret@email.com amount=50000`)
        );

        vi.doMock("~/services/backstop.server", async () => {
          const actual = await vi.importActual("~/services/backstop.server");
          return {
            ...actual,
            evaluateBackstop: mockEvaluateBackstop,
          };
        });

        try {
          const candidates = [{
            invoiceId: INVOICE_ID_ERRCODE,
            orderId: ORDER_GID_ERRCODE,
            shopId: TEST_SHOP_ID,
            shopDomain: TEST_SHOP_DOMAIN,
            buyerAccountId: HELD_ACCOUNT_ERRCODE,
          }];

          await requestContext.run({ getSql: () => sql }, async () => {
            await processBackfill(sql, candidates, true);
          });

          const allOutput = logs.join("\n");
          expect(allOutput).not.toContain(DOMAIN_SENTINEL);
          expect(allOutput).not.toContain("myshopify.com");
          expect(allOutput).not.toContain("secret@email.com");
          expect(allOutput).not.toContain("amount=50000");
          expect(allOutput).not.toContain("ECONNREFUSED");

          const errorLogs = logs.filter(l => l.includes("✗ error"));
          expect(errorLogs).toHaveLength(1);
          expect(errorLogs[0]).toContain("err=connection_refused");
        } finally {
          console.log = originalLog;
          vi.doUnmock("~/services/backstop.server");
        }
      } finally {
        await sql`DELETE FROM "Invoice" WHERE id = ${INVOICE_ID_ERRCODE}`;
        await sql`DELETE FROM "BuyerAccount" WHERE id = ${HELD_ACCOUNT_ERRCODE}`;
        await sql`DELETE FROM "Session" WHERE id = ${"offline_errcode_" + TEST_SHOP_DOMAIN}`;
      }
    });
  });
});
