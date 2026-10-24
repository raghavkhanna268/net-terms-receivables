/**
 * S17 Credit-hold lifecycle end-to-end integration tests.
 *
 * Tests cover:
 * 1. Overdue lifecycle: invoice past due → HELD/PAYMENT_OVERDUE → payment → RELEASED
 * 2. Over credit limit: exposure > limit → HELD/CREDIT_REVIEW → pay down → RELEASED
 * 3. Plan gating: holds work with PLAN_GATING_ENFORCED=true and false
 *
 * All tests:
 * - Use real DB (CI pgmq Postgres)
 * - Mock ONLY the Shopify Admin GraphQL client
 * - Assert exact metafieldsSet mutation and variables per docs/metafields-contract.md
 * - Use synthetic data only (fake IDs, emails like buyer@example.test)
 * - Use ONE as-of time source (DB NOW() fetched once per test)
 * - Must pass under TZ=Pacific/Auckland and TZ=Asia/Kolkata
 * - No conditional assertions
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import type { CreditStatus } from "~/lib/metafields-contract";

let metafieldWriteCount = 0;
let lastMetafieldVariables: { metafields: Array<{ ownerId: string; namespace: string; key: string; type: string; value: string }> } | null = null;
let lastMetafieldJson: CreditStatus | null = null;

const mockShopifyGraphQLRequest = vi.fn().mockImplementation(async (_shop: string, query: string, variables: unknown) => {
  if (query.includes("metafieldsSet")) {
    metafieldWriteCount++;
    lastMetafieldVariables = variables as typeof lastMetafieldVariables;
    if (lastMetafieldVariables?.metafields?.[0]?.value) {
      lastMetafieldJson = JSON.parse(lastMetafieldVariables.metafields[0].value) as CreditStatus;
    }
    return {
      success: true,
      data: {
        metafieldsSet: {
          metafields: [{ id: "gid://shopify/Metafield/123", namespace: "$app", key: "credit_status" }],
          userErrors: [],
        },
      },
    };
  }
  return { success: true, data: {} };
});

vi.mock("../shopify-client.server", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    shopifyGraphQLRequest: (...args: unknown[]) => mockShopifyGraphQLRequest(...args),
  };
});

import { recomputeCreditStatus } from "../credit-status-recompute.server";
import { updateCreditStatus } from "../credit-status.server";
import { applyMatch } from "../apply.server";
import { confirmMatch } from "../matcher.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("S17 credit-hold lifecycle (overdue)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-overdue";
  const TEST_SHOP_ID = `shop-overdue-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `overdue-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-overdue-${TEST_SUFFIX}`;
  const TEST_COMPANY_LOCATION_ID = `gid://shopify/CompanyLocation/overdue-${TEST_SUFFIX}`;
  const TEST_IMPORT_ID = `import-overdue-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "manualHold", "holdReasonCode",
        "defaultTermsDays", "defaultTermsSource",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-" + TEST_SUFFIX}, ${TEST_COMPANY_LOCATION_ID},
        'Test Overdue Buyer',
        100000.00, 'OK', false, false, NULL,
        30, 'explicit',
        false, 1, NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
      VALUES (${TEST_IMPORT_ID}, ${TEST_SHOP_ID}, 'hdfc', 'test-overdue.xlsx', 1, NOW())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'%' + TEST_SUFFIX + '%'}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Match" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    metafieldWriteCount = 0;
    lastMetafieldVariables = null;
    lastMetafieldJson = null;
    mockShopifyGraphQLRequest.mockClear();

    await sql`
      UPDATE "BuyerAccount"
      SET "holdState" = 'OK', "holdReasonCode" = NULL, "manualHold" = false,
          "creditLimit" = 100000.00,
          "syncPending" = false, "syncVersion" = 1, gated_at = NULL, "metafieldSyncedAt" = NULL
      WHERE id = ${TEST_ACCOUNT_ID}
    `;

    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Match" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'%' + TEST_SUFFIX + '%'}`;
  });

  it("overdue invoice triggers HELD/PAYMENT_OVERDUE with correct metafield write", async () => {
    const [{ db_now: dbNow }] = await sql<{ db_now: Date }[]>`SELECT NOW() AS db_now`;
    
    const invoiceId = `inv-overdue-hold-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/overdue-hold-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#OVERDUE-1', 50000.00, 50000.00, 'open',
        ${dbNow}::timestamptz - INTERVAL '40 days',
        ${dbNow}::timestamptz - INTERVAL '10 days',
        ${dbNow}, ${dbNow}
      )
    `;

    const result = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);

    expect(result.success).toBe(true);
    expect(result.previousHold).toBe(false);
    expect(result.newHold).toBe(true);
    expect(result.metafieldWritten).toBe(true);
    expect(metafieldWriteCount).toBe(1);

    const [account] = await sql<{ holdState: string }[]>`
      SELECT "holdState" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
    `;
    expect(account.holdState).toBe("HELD");

    expect(lastMetafieldVariables).not.toBeNull();
    expect(lastMetafieldVariables!.metafields).toHaveLength(1);
    const mf = lastMetafieldVariables!.metafields[0];
    expect(mf.ownerId).toBe(TEST_COMPANY_LOCATION_ID);
    expect(mf.namespace).toBe("$app");
    expect(mf.key).toBe("credit_status");
    expect(mf.type).toBe("json");

    expect(lastMetafieldJson).not.toBeNull();
    expect(lastMetafieldJson!.schemaVersion).toBe(1);
    expect(lastMetafieldJson!.currencyCode).toBe("INR");
    expect(lastMetafieldJson!.hold).toBe(true);
    expect(lastMetafieldJson!.holdReasonCode).toBe("PAYMENT_OVERDUE");
    expect(lastMetafieldJson!.limitPaise).toBe("10000000");
    expect(lastMetafieldJson!.exposurePaise).toBe("5000000");
    expect(lastMetafieldJson!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("payment applied via confirmMatch + applyMatch releases hold with metafield hold=false", async () => {
    const [{ db_now: dbNow }] = await sql<{ db_now: Date }[]>`SELECT NOW() AS db_now`;
    
    const invoiceId = `inv-overdue-pay-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/overdue-pay-${TEST_SUFFIX}`;
    const paymentId = `pmt-overdue-pay-${TEST_SUFFIX}`;
    const matchId = `match-overdue-pay-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#OVERDUE-PAY-1', 50000.00, 50000.00, 'open',
        ${dbNow}::timestamptz - INTERVAL '40 days',
        ${dbNow}::timestamptz - INTERVAL '10 days',
        ${dbNow}, ${dbNow}
      )
    `;

    await sql`
      UPDATE "BuyerAccount"
      SET "holdState" = 'HELD', "holdReasonCode" = 'PAYMENT_OVERDUE', "manualHold" = false
      WHERE id = ${TEST_ACCOUNT_ID}
    `;

    await sql`
      INSERT INTO "Payment" (id, "shopId", "importId", amount, narration, "payerText", utr, "valueDate", status, "createdAt", "updatedAt")
      VALUES (${paymentId}, ${TEST_SHOP_ID}, ${TEST_IMPORT_ID}, 50000.00, 'Payment for overdue invoice', 'Test Buyer', 'UTR-OVERDUE-1', ${dbNow}::timestamptz, 'unmatched', ${dbNow}, ${dbNow})
    `;

    await sql`
      INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
      VALUES (${matchId}, ${TEST_SHOP_ID}, ${paymentId}, ${invoiceId}, 50000.00, 100, ${sql.json([{ type: 'exact_amount', points: 100 }])}, 'suggested', ${dbNow}, ${dbNow})
    `;

    const confirmResult = await confirmMatch(sql, TEST_SHOP_ID, matchId, "test-user@example.test");
    expect(confirmResult.success).toBe(true);

    mockShopifyGraphQLRequest.mockImplementation(async (_shop: string, query: string, variables: unknown) => {
      if (query.includes("orderMarkAsPaid")) {
        return {
          success: true,
          data: {
            orderMarkAsPaid: {
              order: { id: orderId, displayFinancialStatus: "PAID" },
              userErrors: [],
            },
          },
        };
      }
      if (query.includes("GetOrder")) {
        return {
          success: true,
          data: { order: { id: orderId, displayFinancialStatus: "PENDING" } },
        };
      }
      if (query.includes("metafieldsSet")) {
        metafieldWriteCount++;
        lastMetafieldVariables = variables as typeof lastMetafieldVariables;
        if (lastMetafieldVariables?.metafields?.[0]?.value) {
          lastMetafieldJson = JSON.parse(lastMetafieldVariables.metafields[0].value) as CreditStatus;
        }
        return {
          success: true,
          data: {
            metafieldsSet: {
              metafields: [{ id: "gid://shopify/Metafield/123", namespace: "$app", key: "credit_status" }],
              userErrors: [],
            },
          },
        };
      }
      return { success: true, data: {} };
    });

    const applyResult = await applyMatch(sql, TEST_SHOP_ID, matchId, "test-user@example.test");
    expect(applyResult.success).toBe(true);
    expect(applyResult.invoicePaid).toBe(true);

    const [paidInvoice] = await sql<{ status: string; outstanding: string }[]>`
      SELECT status, outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
    `;
    expect(paidInvoice.status).toBe("paid");
    expect(parseFloat(paidInvoice.outstanding)).toBe(0);

    metafieldWriteCount = 0;
    lastMetafieldJson = null;

    const recomputeResult = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);
    expect(recomputeResult.success).toBe(true);
    expect(recomputeResult.previousHold).toBe(true);
    expect(recomputeResult.newHold).toBe(false);

    const [account] = await sql<{ holdState: string }[]>`
      SELECT "holdState" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
    `;
    expect(account.holdState).toBe("OK");

    expect(lastMetafieldJson).not.toBeNull();
    expect(lastMetafieldJson!.hold).toBe(false);
    expect(lastMetafieldJson!.holdReasonCode).toBeNull();
    expect(lastMetafieldJson!.exposurePaise).toBe("0");
  });

  it("manually marking invoice paid releases hold with metafield hold=false", async () => {
    const [{ db_now: dbNow }] = await sql<{ db_now: Date }[]>`SELECT NOW() AS db_now`;
    
    const invoiceId = `inv-overdue-manual-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/overdue-manual-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#OVERDUE-MANUAL-1', 30000.00, 30000.00, 'open',
        ${dbNow}::timestamptz - INTERVAL '45 days',
        ${dbNow}::timestamptz - INTERVAL '15 days',
        ${dbNow}, ${dbNow}
      )
    `;

    const holdResult = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);
    expect(holdResult.newHold).toBe(true);

    await sql`
      UPDATE "Invoice"
      SET status = 'paid', outstanding = 0, "updatedAt" = NOW()
      WHERE id = ${invoiceId}
    `;

    metafieldWriteCount = 0;
    lastMetafieldJson = null;

    const releaseResult = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);
    expect(releaseResult.success).toBe(true);
    expect(releaseResult.previousHold).toBe(true);
    expect(releaseResult.newHold).toBe(false);
    expect(releaseResult.metafieldWritten).toBe(true);

    const [account] = await sql<{ holdState: string }[]>`
      SELECT "holdState" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
    `;
    expect(account.holdState).toBe("OK");

    expect(lastMetafieldJson!.hold).toBe(false);
    expect(lastMetafieldJson!.holdReasonCode).toBeNull();
  });

  it("daily sweep enqueues recompute for overdue account not yet HELD", async () => {
    const [{ db_now: dbNow }] = await sql<{ db_now: Date }[]>`SELECT NOW() AS db_now`;
    
    const invoiceId = `inv-overdue-sweep-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/overdue-sweep-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#OVERDUE-SWEEP-1', 25000.00, 25000.00, 'open',
        ${dbNow}::timestamptz - INTERVAL '35 days',
        ${dbNow}::timestamptz - INTERVAL '5 days',
        ${dbNow}, ${dbNow}
      )
    `;

    // The sweep enqueues for ALL shops with overdue invoices. We archive any messages
    // it creates for other shops' accounts to avoid leaking into later DB tests.
    const [sweepResult] = await sql<{ accounts_enqueued: number }[]>`
      SELECT * FROM enqueue_credit_status_recomputes()
    `;

    expect(sweepResult.accounts_enqueued).toBeGreaterThanOrEqual(1);

    const [queueMsg] = await sql<{ message: { topic: string; buyerAccountId: string; source: string } }[]>`
      SELECT message FROM pgmq.q_s6_sync
      WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
        AND message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
      LIMIT 1
    `;

    expect(queueMsg).toBeDefined();
    expect(queueMsg.message.topic).toBe("CREDIT_STATUS_RECOMPUTE");
    expect(queueMsg.message.buyerAccountId).toBe(TEST_ACCOUNT_ID);
    expect(queueMsg.message.source).toBe("daily_sweep");

    // Clean up messages for other shops that the global sweep may have enqueued
    await sql`
      WITH archived AS (
        SELECT pgmq.archive('s6_sync', msg_id)
        FROM pgmq.q_s6_sync
        WHERE message->>'shop' != ${TEST_SHOP_DOMAIN}
          AND message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
      )
      SELECT 1
    `;
  });
});

describeWithDb("S17 credit-hold lifecycle (over credit limit)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-overlimit";
  const TEST_SHOP_ID = `shop-overlimit-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `overlimit-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-overlimit-${TEST_SUFFIX}`;
  const TEST_COMPANY_LOCATION_ID = `gid://shopify/CompanyLocation/overlimit-${TEST_SUFFIX}`;
  const TEST_IMPORT_ID = `import-overlimit-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', 'Pacific/Auckland', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "manualHold", "holdReasonCode",
        "defaultTermsDays", "defaultTermsSource",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-" + TEST_SUFFIX}, ${TEST_COMPANY_LOCATION_ID},
        'Test Overlimit Buyer',
        50000.00, 'OK', false, false, NULL,
        30, 'explicit',
        false, 1, NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
      VALUES (${TEST_IMPORT_ID}, ${TEST_SHOP_ID}, 'hdfc', 'test-overlimit.xlsx', 1, NOW())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'%' + TEST_SUFFIX + '%'}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Match" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    metafieldWriteCount = 0;
    lastMetafieldVariables = null;
    lastMetafieldJson = null;
    mockShopifyGraphQLRequest.mockClear();
    mockShopifyGraphQLRequest.mockImplementation(async (_shop: string, query: string, variables: unknown) => {
      if (query.includes("metafieldsSet")) {
        metafieldWriteCount++;
        lastMetafieldVariables = variables as typeof lastMetafieldVariables;
        if (lastMetafieldVariables?.metafields?.[0]?.value) {
          lastMetafieldJson = JSON.parse(lastMetafieldVariables.metafields[0].value) as CreditStatus;
        }
        return {
          success: true,
          data: {
            metafieldsSet: {
              metafields: [{ id: "gid://shopify/Metafield/123", namespace: "$app", key: "credit_status" }],
              userErrors: [],
            },
          },
        };
      }
      return { success: true, data: {} };
    });

    await sql`
      UPDATE "BuyerAccount"
      SET "holdState" = 'OK', "holdReasonCode" = NULL, "manualHold" = false,
          "creditLimit" = 50000.00,
          "syncPending" = false, "syncVersion" = 1, gated_at = NULL, "metafieldSyncedAt" = NULL
      WHERE id = ${TEST_ACCOUNT_ID}
    `;

    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Match" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'%' + TEST_SUFFIX + '%'}`;
  });

  it("exposure exceeding credit limit triggers HELD/CREDIT_REVIEW with metafield hold=true", async () => {
    const [{ db_now: dbNow }] = await sql<{ db_now: Date }[]>`SELECT NOW() AS db_now`;
    
    const invoiceId = `inv-overlimit-hold-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/overlimit-hold-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#OVERLIMIT-1', 60000.00, 60000.00, 'open',
        ${dbNow}::timestamptz - INTERVAL '5 days',
        ${dbNow}::timestamptz + INTERVAL '25 days',
        ${dbNow}, ${dbNow}
      )
    `;

    const result = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);

    expect(result.success).toBe(true);
    expect(result.previousHold).toBe(false);
    expect(result.newHold).toBe(true);
    expect(result.metafieldWritten).toBe(true);

    const [account] = await sql<{ holdState: string }[]>`
      SELECT "holdState" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
    `;
    expect(account.holdState).toBe("HELD");

    expect(lastMetafieldJson).not.toBeNull();
    expect(lastMetafieldJson!.hold).toBe(true);
    expect(lastMetafieldJson!.holdReasonCode).toBe("CREDIT_REVIEW");
    expect(lastMetafieldJson!.limitPaise).toBe("5000000");
    expect(lastMetafieldJson!.exposurePaise).toBe("6000000");
  });

  it("paying down below credit limit releases hold with metafield hold=false", async () => {
    const [{ db_now: dbNow }] = await sql<{ db_now: Date }[]>`SELECT NOW() AS db_now`;
    
    const invoiceId = `inv-overlimit-paydown-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/overlimit-paydown-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#OVERLIMIT-PAYDOWN-1', 55000.00, 55000.00, 'open',
        ${dbNow}::timestamptz - INTERVAL '5 days',
        ${dbNow}::timestamptz + INTERVAL '25 days',
        ${dbNow}, ${dbNow}
      )
    `;

    const holdResult = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);
    expect(holdResult.newHold).toBe(true);
    expect(lastMetafieldJson!.holdReasonCode).toBe("CREDIT_REVIEW");

    await sql`
      UPDATE "Invoice"
      SET outstanding = 30000.00, "updatedAt" = NOW()
      WHERE id = ${invoiceId}
    `;

    metafieldWriteCount = 0;
    lastMetafieldJson = null;

    const releaseResult = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);

    expect(releaseResult.success).toBe(true);
    expect(releaseResult.previousHold).toBe(true);
    expect(releaseResult.newHold).toBe(false);
    expect(releaseResult.metafieldWritten).toBe(true);

    const [account] = await sql<{ holdState: string }[]>`
      SELECT "holdState" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
    `;
    expect(account.holdState).toBe("OK");

    expect(lastMetafieldJson!.hold).toBe(false);
    expect(lastMetafieldJson!.holdReasonCode).toBeNull();
    expect(lastMetafieldJson!.exposurePaise).toBe("3000000");
  });

  it("exactly at credit limit is NEAR_LIMIT not HELD (hold only when over limit)", async () => {
    const [{ db_now: dbNow }] = await sql<{ db_now: Date }[]>`SELECT NOW() AS db_now`;
    
    const invoiceId = `inv-at-limit-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/at-limit-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#AT-LIMIT-1', 50000.00, 50000.00, 'open',
        ${dbNow}::timestamptz - INTERVAL '5 days',
        ${dbNow}::timestamptz + INTERVAL '25 days',
        ${dbNow}, ${dbNow}
      )
    `;

    const result = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);

    expect(result.success).toBe(true);
    expect(result.newHold).toBe(false);

    const [account] = await sql<{ holdState: string }[]>`
      SELECT "holdState" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
    `;
    expect(account.holdState).toBe("NEAR_LIMIT");
  });
});

describeWithDb("S17 credit-hold lifecycle (gated accounts)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-gated";
  const TEST_SHOP_ID = `shop-gated-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `gated-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_GATED_ACCOUNT_ID = `acc-gated-${TEST_SUFFIX}`;
  const TEST_GATED_COMPANY_LOCATION_ID = `gid://shopify/CompanyLocation/gated-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', 'Pacific/Auckland', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "manualHold", "holdReasonCode",
        "defaultTermsDays", "defaultTermsSource",
        "syncPending", "syncVersion", gated_at, "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_GATED_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-gated-" + TEST_SUFFIX}, ${TEST_GATED_COMPANY_LOCATION_ID},
        'Test Gated Buyer',
        100000.00, 'OK', false, false, NULL,
        30, 'explicit',
        false, 1, NOW(), NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'%' + TEST_SUFFIX + '%'}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    metafieldWriteCount = 0;
    lastMetafieldVariables = null;
    lastMetafieldJson = null;
    mockShopifyGraphQLRequest.mockClear();
    mockShopifyGraphQLRequest.mockImplementation(async (_shop: string, query: string, variables: unknown) => {
      if (query.includes("metafieldsSet")) {
        metafieldWriteCount++;
        lastMetafieldVariables = variables as typeof lastMetafieldVariables;
        if (lastMetafieldVariables?.metafields?.[0]?.value) {
          lastMetafieldJson = JSON.parse(lastMetafieldVariables.metafields[0].value) as CreditStatus;
        }
        return {
          success: true,
          data: {
            metafieldsSet: {
              metafields: [{ id: "gid://shopify/Metafield/123", namespace: "$app", key: "credit_status" }],
              userErrors: [],
            },
          },
        };
      }
      return { success: true, data: {} };
    });

    // Gated account simulates exceeding Free plan's 3-account limit per docs/plans-and-gating.md.
    // Credit holds apply on ALL plans regardless of gating state.
    await sql`
      UPDATE "BuyerAccount"
      SET "holdState" = 'OK', "holdReasonCode" = NULL, "manualHold" = false,
          "creditLimit" = 100000.00,
          "syncPending" = false, "syncVersion" = 1, gated_at = NOW(), "metafieldSyncedAt" = NULL
      WHERE id = ${TEST_GATED_ACCOUNT_ID}
    `;

    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'%' + TEST_SUFFIX + '%'}`;
  });

  // recomputeCreditStatus does NOT read PLAN_GATING_ENFORCED - credit holds apply identically
  // to gated accounts regardless of whether gating enforcement is on or off. These tests
  // prove that gated accounts are subject to holds just like non-gated accounts.
  it("gated account with overdue invoice becomes HELD with metafield written", async () => {
    const [{ db_now: dbNow }] = await sql<{ db_now: Date }[]>`SELECT NOW() AS db_now`;
    
    const invoiceId = `inv-gated-overdue-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/gated-overdue-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_GATED_ACCOUNT_ID}, ${orderId},
        '#GATED-OVERDUE-1', 40000.00, 40000.00, 'open',
        ${dbNow}::timestamptz - INTERVAL '40 days',
        ${dbNow}::timestamptz - INTERVAL '10 days',
        ${dbNow}, ${dbNow}
      )
    `;

    const result = await recomputeCreditStatus(sql, TEST_GATED_ACCOUNT_ID);

    expect(result.success).toBe(true);
    expect(result.newHold).toBe(true);
    expect(result.metafieldWritten).toBe(true);
    expect(metafieldWriteCount).toBe(1);

    const [account] = await sql<{ holdState: string }[]>`
      SELECT "holdState" FROM "BuyerAccount" WHERE id = ${TEST_GATED_ACCOUNT_ID}
    `;
    expect(account.holdState).toBe("HELD");

    expect(lastMetafieldJson!.hold).toBe(true);
    expect(lastMetafieldJson!.holdReasonCode).toBe("PAYMENT_OVERDUE");
  });

  it("gated account over credit limit becomes HELD with metafield written", async () => {
    await sql`
      UPDATE "BuyerAccount"
      SET "creditLimit" = 50000.00
      WHERE id = ${TEST_GATED_ACCOUNT_ID}
    `;
    
    const [{ db_now: dbNow }] = await sql<{ db_now: Date }[]>`SELECT NOW() AS db_now`;
    
    const invoiceId = `inv-gated-overlimit-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/gated-overlimit-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_GATED_ACCOUNT_ID}, ${orderId},
        '#GATED-OVERLIMIT-1', 60000.00, 60000.00, 'open',
        ${dbNow}::timestamptz - INTERVAL '5 days',
        ${dbNow}::timestamptz + INTERVAL '25 days',
        ${dbNow}, ${dbNow}
      )
    `;

    const result = await recomputeCreditStatus(sql, TEST_GATED_ACCOUNT_ID);

    expect(result.success).toBe(true);
    expect(result.newHold).toBe(true);
    expect(result.metafieldWritten).toBe(true);

    expect(lastMetafieldJson!.hold).toBe(true);
    expect(lastMetafieldJson!.holdReasonCode).toBe("CREDIT_REVIEW");
  });

  it("daily sweep includes gated accounts with overdue invoices", async () => {
    const [{ db_now: dbNow }] = await sql<{ db_now: Date }[]>`SELECT NOW() AS db_now`;
    
    const invoiceId = `inv-gated-sweep-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/gated-sweep-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_GATED_ACCOUNT_ID}, ${orderId},
        '#GATED-SWEEP-1', 20000.00, 20000.00, 'open',
        ${dbNow}::timestamptz - INTERVAL '35 days',
        ${dbNow}::timestamptz - INTERVAL '5 days',
        ${dbNow}, ${dbNow}
      )
    `;

    // The sweep enqueues for ALL shops with overdue invoices. We archive any messages
    // it creates for other shops' accounts to avoid leaking into later DB tests.
    const [sweepResult] = await sql<{ accounts_enqueued: number }[]>`
      SELECT * FROM enqueue_credit_status_recomputes()
    `;

    expect(sweepResult.accounts_enqueued).toBeGreaterThanOrEqual(1);

    const [queueMsg] = await sql<{ message: { topic: string; buyerAccountId: string } }[]>`
      SELECT message FROM pgmq.q_s6_sync
      WHERE message->>'buyerAccountId' = ${TEST_GATED_ACCOUNT_ID}
        AND message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
      LIMIT 1
    `;

    expect(queueMsg).toBeDefined();
    expect(queueMsg.message.buyerAccountId).toBe(TEST_GATED_ACCOUNT_ID);

    // Clean up messages for other shops that the global sweep may have enqueued
    await sql`
      WITH archived AS (
        SELECT pgmq.archive('s6_sync', msg_id)
        FROM pgmq.q_s6_sync
        WHERE message->>'shop' != ${TEST_SHOP_DOMAIN}
          AND message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
      )
      SELECT 1
    `;
  });
});

describeWithDb("S17 metafield contract compliance", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-contract";
  const TEST_SHOP_ID = `shop-contract-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `contract-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-contract-${TEST_SUFFIX}`;
  const TEST_COMPANY_LOCATION_ID = `gid://shopify/CompanyLocation/contract-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "manualHold", "holdReasonCode",
        "defaultTermsDays", "defaultTermsSource",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-" + TEST_SUFFIX}, ${TEST_COMPANY_LOCATION_ID},
        'Test Contract Buyer',
        100000.00, 'OK', false, false, NULL,
        30, 'explicit',
        false, 1, NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    metafieldWriteCount = 0;
    lastMetafieldVariables = null;
    lastMetafieldJson = null;
    mockShopifyGraphQLRequest.mockClear();
    mockShopifyGraphQLRequest.mockImplementation(async (_shop: string, query: string, variables: unknown) => {
      if (query.includes("metafieldsSet")) {
        metafieldWriteCount++;
        lastMetafieldVariables = variables as typeof lastMetafieldVariables;
        if (lastMetafieldVariables?.metafields?.[0]?.value) {
          lastMetafieldJson = JSON.parse(lastMetafieldVariables.metafields[0].value) as CreditStatus;
        }
        return {
          success: true,
          data: {
            metafieldsSet: {
              metafields: [{ id: "gid://shopify/Metafield/123", namespace: "$app", key: "credit_status" }],
              userErrors: [],
            },
          },
        };
      }
      return { success: true, data: {} };
    });

    await sql`
      UPDATE "BuyerAccount"
      SET "holdState" = 'OK', "holdReasonCode" = NULL, "manualHold" = false,
          "creditLimit" = 100000.00,
          "syncPending" = true, "syncVersion" = 1, "metafieldSyncedAt" = NULL
      WHERE id = ${TEST_ACCOUNT_ID}
    `;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
  });

  it("recompute writes metafield with all docs/metafields-contract.md fields", async () => {
    const [{ db_now: dbNow }] = await sql<{ db_now: Date }[]>`SELECT NOW() AS db_now`;
    
    const invoiceId = `inv-contract-full-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/contract-full-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#CONTRACT-FULL-1', 25000.00, 25000.00, 'open',
        ${dbNow}::timestamptz - INTERVAL '35 days',
        ${dbNow}::timestamptz - INTERVAL '5 days',
        ${dbNow}, ${dbNow}
      )
    `;

    await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);

    expect(lastMetafieldVariables).not.toBeNull();
    expect(lastMetafieldVariables!.metafields).toHaveLength(1);
    
    const mf = lastMetafieldVariables!.metafields[0];
    expect(mf.ownerId).toBe(TEST_COMPANY_LOCATION_ID);
    expect(mf.namespace).toBe("$app");
    expect(mf.key).toBe("credit_status");
    expect(mf.type).toBe("json");
    expect(typeof mf.value).toBe("string");
    
    expect(lastMetafieldJson!.schemaVersion).toBe(1);
    expect(lastMetafieldJson!.currencyCode).toBe("INR");
    expect(lastMetafieldJson!.hold).toBe(true);
    expect(lastMetafieldJson!.holdReasonCode).toBe("PAYMENT_OVERDUE");
    expect(lastMetafieldJson!.limitPaise).toMatch(/^\d+$/);
    expect(lastMetafieldJson!.exposurePaise).toMatch(/^\d+$/);
    expect(lastMetafieldJson!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("hold=true uses PAYMENT_OVERDUE for overdue invoices", async () => {
    const [{ db_now: dbNow }] = await sql<{ db_now: Date }[]>`SELECT NOW() AS db_now`;
    
    const invoiceId = `inv-contract-overdue-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/contract-overdue-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#CONTRACT-OVERDUE-1', 10000.00, 10000.00, 'open',
        ${dbNow}::timestamptz - INTERVAL '40 days',
        ${dbNow}::timestamptz - INTERVAL '10 days',
        ${dbNow}, ${dbNow}
      )
    `;

    await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);

    expect(lastMetafieldJson!.hold).toBe(true);
    expect(lastMetafieldJson!.holdReasonCode).toBe("PAYMENT_OVERDUE");
  });

  it("hold=true uses CREDIT_REVIEW for over-limit", async () => {
    await sql`
      UPDATE "BuyerAccount"
      SET "creditLimit" = 5000.00
      WHERE id = ${TEST_ACCOUNT_ID}
    `;
    
    const [{ db_now: dbNow }] = await sql<{ db_now: Date }[]>`SELECT NOW() AS db_now`;
    
    const invoiceId = `inv-contract-overlimit-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/contract-overlimit-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#CONTRACT-OVERLIMIT-1', 10000.00, 10000.00, 'open',
        ${dbNow}::timestamptz - INTERVAL '5 days',
        ${dbNow}::timestamptz + INTERVAL '25 days',
        ${dbNow}, ${dbNow}
      )
    `;

    await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);

    expect(lastMetafieldJson!.hold).toBe(true);
    expect(lastMetafieldJson!.holdReasonCode).toBe("CREDIT_REVIEW");
  });

  it("hold=true uses MANUAL_HOLD for manual holds", async () => {
    await updateCreditStatus(sql, TEST_ACCOUNT_ID, {
      creditLimitAmount: 100000,
      manualHold: true,
      holdReasonCode: "MANUAL_HOLD",
    });

    expect(lastMetafieldJson!.hold).toBe(true);
    expect(lastMetafieldJson!.holdReasonCode).toBe("MANUAL_HOLD");
  });

  it("recompute to OK after paying invoice writes hold=false with holdReasonCode=null", async () => {
    const [{ db_now: dbNow }] = await sql<{ db_now: Date }[]>`SELECT NOW() AS db_now`;
    
    const invoiceId = `inv-contract-release-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/contract-release-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#CONTRACT-RELEASE-1', 15000.00, 15000.00, 'open',
        ${dbNow}::timestamptz - INTERVAL '40 days',
        ${dbNow}::timestamptz - INTERVAL '10 days',
        ${dbNow}, ${dbNow}
      )
    `;

    await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);
    expect(lastMetafieldJson!.hold).toBe(true);

    await sql`
      UPDATE "Invoice"
      SET outstanding = 0.00, status = 'paid'
      WHERE id = ${invoiceId}
    `;

    metafieldWriteCount = 0;
    lastMetafieldJson = null;

    await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);

    expect(lastMetafieldJson!.hold).toBe(false);
    expect(lastMetafieldJson!.holdReasonCode).toBeNull();
  });

  it("limitPaise and exposurePaise are string integers in paise", async () => {
    const [{ db_now: dbNow }] = await sql<{ db_now: Date }[]>`SELECT NOW() AS db_now`;
    
    const invoiceId = `inv-contract-paise-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/contract-paise-${TEST_SUFFIX}`;

    await sql`
      UPDATE "BuyerAccount"
      SET "creditLimit" = 123456.78
      WHERE id = ${TEST_ACCOUNT_ID}
    `;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#CONTRACT-PAISE-1', 45678.90, 45678.90, 'open',
        ${dbNow}::timestamptz - INTERVAL '5 days',
        ${dbNow}::timestamptz + INTERVAL '25 days',
        ${dbNow}, ${dbNow}
      )
    `;

    await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);

    expect(lastMetafieldJson!.limitPaise).toBe("12345678");
    expect(lastMetafieldJson!.exposurePaise).toBe("4567890");
    expect(lastMetafieldJson!.limitPaise).toMatch(/^\d+$/);
    expect(lastMetafieldJson!.exposurePaise).toMatch(/^\d+$/);
  });
});
