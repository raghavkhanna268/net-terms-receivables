/**
 * End-to-end DB test covering S14 (import) -> S16 (matcher) -> S17 (apply).
 *
 * This test verifies the complete payment matching flow:
 * 1. Parse a synthetic bank import using the real client parser
 * 2. Import payments via the REAL import service
 * 3. Run REAL matcher to produce match suggestions
 * 4. Confirm and apply matches via REAL confirm/apply path
 * 5. Assert resulting state (suggestions, applied matches, audit events, idempotency)
 *
 * ISOLATION: Uses a unique shop domain (test-e2e-match-*.myshopify.com) and cleans
 * up only its own data. Does not interfere with s6_sync queue tests or other tests.
 *
 * TIMEZONE ROBUSTNESS: Uses UTC dates throughout. CI runs both UTC and Auckland passes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

let mockShopifySuccess = true;
let mockAlreadyPaid = false;
let orderMarkAsPaidCallCount = 0;

vi.mock("../shopify-client.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    shopifyGraphQLRequest: vi
      .fn()
      .mockImplementation(async (_shop: string, query: string) => {
        const isOrderQuery = query.includes("query GetOrder");
        if (isOrderQuery) {
          return {
            success: true,
            data: {
              order: {
                id: "gid://shopify/Order/123",
                displayFinancialStatus: mockAlreadyPaid ? "PAID" : "PENDING",
              },
            },
          };
        }

        orderMarkAsPaidCallCount++;

        if (mockAlreadyPaid) {
          return {
            success: true,
            data: {
              orderMarkAsPaid: {
                order: null,
                userErrors: [
                  { field: ["id"], message: "Order has already been paid" },
                ],
              },
            },
          };
        }

        if (!mockShopifySuccess) {
          return { success: false, error: "Shopify API error", retryable: true };
        }

        return {
          success: true,
          data: {
            orderMarkAsPaid: {
              order: {
                id: "gid://shopify/Order/123",
                displayFinancialStatus: "PAID",
              },
              userErrors: [],
            },
          },
        };
      }),
  };
});

vi.mock("../credit-status-recompute.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    enqueueRecomputeForInvoice: vi.fn().mockResolvedValue(undefined),
  };
});

import { runMatcher, confirmMatch } from "../matcher.server";
import { applyMatch } from "../apply.server";
import { requestContext } from "~/lib/request-context.server";
import { action as importAction } from "~/routes/app.imports";

function createMockRequest(body: unknown): Request {
  return new Request("http://localhost/app/imports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createMockContext(shopDomain: string) {
  return {
    shopify: {
      authenticate: {
        admin: vi.fn().mockResolvedValue({
          session: { shop: shopDomain },
        }),
      },
    },
  };
}

async function callImportAction(
  sql: ReturnType<typeof postgres>,
  shopDomain: string,
  body: unknown
): Promise<Response> {
  const request = createMockRequest(body);
  const context = createMockContext(shopDomain);
  const url = new URL(request.url);

  return requestContext.run({ getSql: () => sql }, async () => {
    return importAction({
      request,
      context: context as never,
      params: {},
      url,
      pattern: "/app/imports",
    });
  });
}

function getUtcDateString(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

describeWithDb("E2E: S14 Import -> S16 Match -> S17 Apply (DB-backed)", () => {
  let sql: ReturnType<typeof postgres>;

  const TEST_SUFFIX = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const TEST_SHOP_DOMAIN = `test-e2e-match-${TEST_SUFFIX}.myshopify.com`;
  let testShopId: string;
  let testBuyerAccountId: string;
  let testInvoiceId: string;
  let testOrderGid: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'UTC', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;

    const [buyer] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "manualHold", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'COMPANY',
        ${"gid://shopify/Company/e2e-" + TEST_SUFFIX},
        ${"gid://shopify/CompanyLocation/e2e-" + TEST_SUFFIX},
        'E2E Synthetic Wholesale Corp', 500000.00, 'OK', false, false, NOW(), NOW()
      )
      RETURNING id
    `;
    testBuyerAccountId = buyer.id;

    testOrderGid = `gid://shopify/Order/e2e-${TEST_SUFFIX}`;

    const [invoice] = await sql<{ id: string }[]>`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status,
        "issuedAt", "dueAt", "dueSource", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testBuyerAccountId},
        ${testOrderGid}, '#E2E1001', 85000.00, 85000.00, 'open',
        NOW() - INTERVAL '10 days', NOW() + INTERVAL '20 days', 'schedule', NOW(), NOW()
      )
      RETURNING id
    `;
    testInvoiceId = invoice.id;

    await sql`
      INSERT INTO "PayerAlias" (id, "buyerAccountId", "payerKey", "createdAt")
      VALUES (gen_random_uuid()::text, ${testBuyerAccountId}, 'e2e synthetic wholesale corp', NOW())
    `;
  });

  afterAll(async () => {
    if (sql && testShopId) {
      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
      await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" = ${testBuyerAccountId}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;
    }
    if (sql) {
      await sql.end();
    }
  });

  beforeEach(async () => {
    mockShopifySuccess = true;
    mockAlreadyPaid = false;
    orderMarkAsPaidCallCount = 0;

    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;

    await sql`
      UPDATE "Invoice"
      SET outstanding = 85000.00, status = 'open', "updatedAt" = NOW()
      WHERE id = ${testInvoiceId}
    `;
  });

  it("E2E: import -> match -> confirm -> apply full flow", async () => {
    const syntheticUtr = `SYNTE2E${TEST_SUFFIX.toUpperCase().slice(0, 8)}`;
    const importPayload = {
      bank: "HDFC",
      fileName: "e2e-synthetic-test.csv",
      credits: [
        {
          date: getUtcDateString(3),
          amountPaise: 8500000,
          rail: "NEFT",
          utr: syntheticUtr,
          payerName: "E2E SYNTHETIC WHOLESALE CORP",
          narration: `NEFT CR-E2E SYNTHETIC WHOLESALE CORP-INV#E2E1001`,
        },
      ],
    };

    const importResponse = await callImportAction(
      sql,
      TEST_SHOP_DOMAIN,
      importPayload
    );
    expect(importResponse.status).toBe(200);

    const importData = (await importResponse.json()) as {
      success: boolean;
      counts?: { inserted: number; duplicates: number };
      importId?: string;
    };
    expect(importData.success).toBe(true);
    expect(importData.counts?.inserted).toBe(1);
    expect(importData.counts?.duplicates).toBe(0);

    const [paymentRow] = await sql<
      { id: string; status: string; amount: string }[]
    >`
      SELECT id, status, amount::text FROM "Payment"
      WHERE "shopId" = ${testShopId} AND utr = ${syntheticUtr}
    `;
    expect(paymentRow).toBeDefined();
    expect(paymentRow.status).toBe("unmatched");
    expect(parseFloat(paymentRow.amount)).toBe(85000);

    const matcherResult = await runMatcher(sql, testShopId, { limit: 10 });

    expect(matcherResult.paymentsProcessed).toBe(1);
    expect(matcherResult.matchesCreated).toBeGreaterThanOrEqual(1);

    const suggestedMatches = await sql<
      { id: string; invoice_id: string; score: number; state: string }[]
    >`
      SELECT id, "invoiceId" as invoice_id, score, state
      FROM "Match"
      WHERE "shopId" = ${testShopId} AND "paymentId" = ${paymentRow.id} AND state = 'suggested'
      ORDER BY score DESC
    `;

    expect(suggestedMatches.length).toBeGreaterThanOrEqual(1);
    const topMatch = suggestedMatches[0];
    expect(topMatch.invoice_id).toBe(testInvoiceId);
    expect(topMatch.score).toBeGreaterThanOrEqual(50);

    const confirmResult = await confirmMatch(
      sql,
      testShopId,
      topMatch.id,
      "e2e-test-user"
    );
    expect(confirmResult.success).toBe(true);

    const [confirmedMatch] = await sql<
      { state: string; confirmed_by: string }[]
    >`
      SELECT state, "confirmedBy" as confirmed_by FROM "Match" WHERE id = ${topMatch.id}
    `;
    expect(confirmedMatch.state).toBe("confirmed");
    expect(confirmedMatch.confirmed_by).toBe("e2e-test-user");

    const [matchConfirmedAudit] = await sql<{ id: string; data: object }[]>`
      SELECT id, data FROM "AuditEvent"
      WHERE "shopId" = ${testShopId} AND type = 'match.confirmed'
      ORDER BY at DESC LIMIT 1
    `;
    expect(matchConfirmedAudit).toBeDefined();

    const applyResult = await applyMatch(
      sql,
      testShopId,
      topMatch.id,
      "e2e-test-user"
    );

    expect(applyResult.success).toBe(true);
    expect(applyResult.invoicePaid).toBe(true);
    expect(applyResult.shopifyPushSucceeded).toBe(true);

    const [appliedMatch] = await sql<{ state: string }[]>`
      SELECT state FROM "Match" WHERE id = ${topMatch.id}
    `;
    expect(appliedMatch.state).toBe("pushed");

    const [paidInvoice] = await sql<{ outstanding: string; status: string }[]>`
      SELECT outstanding::text, status FROM "Invoice" WHERE id = ${testInvoiceId}
    `;
    expect(paidInvoice.status).toBe("paid");
    expect(parseFloat(paidInvoice.outstanding)).toBe(0);

    const [matchAppliedAudit] = await sql<{ id: string; data: object }[]>`
      SELECT id, data FROM "AuditEvent"
      WHERE "shopId" = ${testShopId} AND type = 'match.applied'
      ORDER BY at DESC LIMIT 1
    `;
    expect(matchAppliedAudit).toBeDefined();

    const [invoicePaidAudit] = await sql<{ id: string; data: object }[]>`
      SELECT id, data FROM "AuditEvent"
      WHERE "shopId" = ${testShopId} AND type = 'invoice.paid'
      ORDER BY at DESC LIMIT 1
    `;
    expect(invoicePaidAudit).toBeDefined();
  });

  it("E2E: confirm is idempotent", async () => {
    const syntheticUtr = `SYNTIDM${TEST_SUFFIX.toUpperCase().slice(0, 8)}`;
    const importPayload = {
      bank: "HDFC",
      fileName: "e2e-idempotent-test.csv",
      credits: [
        {
          date: getUtcDateString(2),
          amountPaise: 8500000,
          rail: "NEFT",
          utr: syntheticUtr,
          payerName: "E2E SYNTHETIC WHOLESALE CORP",
          narration: `NEFT CR-E2E SYNTHETIC WHOLESALE CORP-#E2E1001`,
        },
      ],
    };

    await callImportAction(sql, TEST_SHOP_DOMAIN, importPayload);
    await runMatcher(sql, testShopId, { limit: 10 });

    const [match] = await sql<{ id: string }[]>`
      SELECT id FROM "Match"
      WHERE "shopId" = ${testShopId} AND state = 'suggested'
      ORDER BY score DESC LIMIT 1
    `;

    const firstConfirm = await confirmMatch(
      sql,
      testShopId,
      match.id,
      "e2e-test-user"
    );
    expect(firstConfirm.success).toBe(true);

    const secondConfirm = await confirmMatch(
      sql,
      testShopId,
      match.id,
      "e2e-test-user"
    );
    expect(secondConfirm.success).toBe(true);

    const auditCount = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count FROM "AuditEvent"
      WHERE "shopId" = ${testShopId} AND type = 'match.confirmed'
    `;
    expect(parseInt(auditCount[0].count, 10)).toBe(1);
  });

  it("E2E: apply is idempotent", async () => {
    const syntheticUtr = `SYNTAPD${TEST_SUFFIX.toUpperCase().slice(0, 8)}`;
    const importPayload = {
      bank: "HDFC",
      fileName: "e2e-apply-idempotent.csv",
      credits: [
        {
          date: getUtcDateString(1),
          amountPaise: 8500000,
          rail: "NEFT",
          utr: syntheticUtr,
          payerName: "E2E SYNTHETIC WHOLESALE CORP",
          narration: `NEFT CR-E2E SYNTHETIC WHOLESALE-INV#E2E1001`,
        },
      ],
    };

    await callImportAction(sql, TEST_SHOP_DOMAIN, importPayload);
    await runMatcher(sql, testShopId, { limit: 10 });

    const [match] = await sql<{ id: string }[]>`
      SELECT id FROM "Match"
      WHERE "shopId" = ${testShopId} AND state = 'suggested'
      ORDER BY score DESC LIMIT 1
    `;

    await confirmMatch(sql, testShopId, match.id, "e2e-test-user");

    const firstApply = await applyMatch(
      sql,
      testShopId,
      match.id,
      "e2e-test-user"
    );
    expect(firstApply.success).toBe(true);
    expect(firstApply.invoicePaid).toBe(true);

    const secondApply = await applyMatch(
      sql,
      testShopId,
      match.id,
      "e2e-test-user"
    );
    expect(secondApply.success).toBe(true);
    expect(secondApply.reasonCode).toBe("ALREADY_APPLIED");

    const appliedAudits = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count FROM "AuditEvent"
      WHERE "shopId" = ${testShopId} AND type = 'match.applied'
    `;
    expect(parseInt(appliedAudits[0].count, 10)).toBe(1);
  });

  it("E2E: partial payment leaves invoice open", async () => {
    const syntheticUtr = `SYNTPRT${TEST_SUFFIX.toUpperCase().slice(0, 8)}`;
    const importPayload = {
      bank: "HDFC",
      fileName: "e2e-partial-test.csv",
      credits: [
        {
          date: getUtcDateString(2),
          amountPaise: 4000000,
          rail: "NEFT",
          utr: syntheticUtr,
          payerName: "E2E SYNTHETIC WHOLESALE CORP",
          narration: `NEFT CR-E2E SYNTHETIC WHOLESALE-#E2E1001`,
        },
      ],
    };

    await callImportAction(sql, TEST_SHOP_DOMAIN, importPayload);
    await runMatcher(sql, testShopId, { limit: 10 });

    const [match] = await sql<{ id: string }[]>`
      SELECT id FROM "Match"
      WHERE "shopId" = ${testShopId} AND state = 'suggested'
      ORDER BY score DESC LIMIT 1
    `;

    await confirmMatch(sql, testShopId, match.id, "e2e-test-user");

    const applyResult = await applyMatch(
      sql,
      testShopId,
      match.id,
      "e2e-test-user"
    );

    expect(applyResult.success).toBe(true);
    expect(applyResult.invoicePaid).toBe(false);
    expect(orderMarkAsPaidCallCount).toBe(0);

    const [invoice] = await sql<{ outstanding: string; status: string }[]>`
      SELECT outstanding::text, status FROM "Invoice" WHERE id = ${testInvoiceId}
    `;
    expect(invoice.status).toBe("open");
    expect(parseFloat(invoice.outstanding)).toBe(45000);
  });

  it("E2E: duplicate import yields all duplicates", async () => {
    const syntheticUtr = `SYNTDUP${TEST_SUFFIX.toUpperCase().slice(0, 8)}`;
    const importPayload = {
      bank: "HDFC",
      fileName: "e2e-duplicate-test.csv",
      credits: [
        {
          date: getUtcDateString(3),
          amountPaise: 5000000,
          rail: "NEFT",
          utr: syntheticUtr,
          payerName: "E2E SYNTHETIC WHOLESALE CORP",
          narration: `NEFT CR-E2E SYNTHETIC WHOLESALE-TEST`,
        },
      ],
    };

    const firstImport = await callImportAction(
      sql,
      TEST_SHOP_DOMAIN,
      importPayload
    );
    const firstData = (await firstImport.json()) as {
      counts?: { inserted: number; duplicates: number };
    };
    expect(firstData.counts?.inserted).toBe(1);
    expect(firstData.counts?.duplicates).toBe(0);

    const secondImport = await callImportAction(
      sql,
      TEST_SHOP_DOMAIN,
      importPayload
    );
    const secondData = (await secondImport.json()) as {
      counts?: { inserted: number; duplicates: number };
    };
    expect(secondData.counts?.inserted).toBe(0);
    expect(secondData.counts?.duplicates).toBe(1);

    const paymentCount = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count FROM "Payment"
      WHERE "shopId" = ${testShopId} AND utr = ${syntheticUtr}
    `;
    expect(parseInt(paymentCount[0].count, 10)).toBe(1);
  });

  it("E2E: matcher produces no duplicate suggestions on re-run", async () => {
    const syntheticUtr = `SYNTRMA${TEST_SUFFIX.toUpperCase().slice(0, 8)}`;
    const importPayload = {
      bank: "HDFC",
      fileName: "e2e-rematch-test.csv",
      credits: [
        {
          date: getUtcDateString(2),
          amountPaise: 8500000,
          rail: "NEFT",
          utr: syntheticUtr,
          payerName: "E2E SYNTHETIC WHOLESALE CORP",
          narration: `NEFT CR-E2E SYNTHETIC WHOLESALE CORP-#E2E1001`,
        },
      ],
    };

    await callImportAction(sql, TEST_SHOP_DOMAIN, importPayload);

    await runMatcher(sql, testShopId, { limit: 10 });
    const firstRunMatches = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count FROM "Match"
      WHERE "shopId" = ${testShopId} AND state = 'suggested'
    `;

    await runMatcher(sql, testShopId, { limit: 10 });
    const secondRunMatches = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count FROM "Match"
      WHERE "shopId" = ${testShopId} AND state = 'suggested'
    `;

    expect(parseInt(firstRunMatches[0].count, 10)).toBe(
      parseInt(secondRunMatches[0].count, 10)
    );
  });

  it("E2E: already-paid Shopify order is handled idempotently", async () => {
    mockAlreadyPaid = true;

    const syntheticUtr = `SYNTALP${TEST_SUFFIX.toUpperCase().slice(0, 8)}`;
    const importPayload = {
      bank: "HDFC",
      fileName: "e2e-already-paid.csv",
      credits: [
        {
          date: getUtcDateString(1),
          amountPaise: 8500000,
          rail: "NEFT",
          utr: syntheticUtr,
          payerName: "E2E SYNTHETIC WHOLESALE CORP",
          narration: `NEFT CR-E2E SYNTHETIC WHOLESALE-#E2E1001`,
        },
      ],
    };

    await callImportAction(sql, TEST_SHOP_DOMAIN, importPayload);
    await runMatcher(sql, testShopId, { limit: 10 });

    const [match] = await sql<{ id: string }[]>`
      SELECT id FROM "Match"
      WHERE "shopId" = ${testShopId} AND state = 'suggested'
      ORDER BY score DESC LIMIT 1
    `;

    await confirmMatch(sql, testShopId, match.id, "e2e-test-user");

    const applyResult = await applyMatch(
      sql,
      testShopId,
      match.id,
      "e2e-test-user"
    );

    expect(applyResult.success).toBe(true);
    expect(applyResult.reasonCode).toBe("ALREADY_PAID_IN_SHOPIFY");

    const [invoice] = await sql<{ status: string }[]>`
      SELECT status FROM "Invoice" WHERE id = ${testInvoiceId}
    `;
    expect(invoice.status).toBe("paid");
  });

  it("E2E: logs contain no PII (payment narration, payer names)", async () => {
    const consoleLogs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      consoleLogs.push(args.map(String).join(" "));
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      consoleLogs.push(args.map(String).join(" "));
    });

    try {
      const syntheticUtr = `SYNTPII${TEST_SUFFIX.toUpperCase().slice(0, 8)}`;
      const piiPayerName = "SECRET PAYER NAME PVT LTD";
      const piiNarration = `NEFT CR-${piiPayerName}-CONFIDENTIAL REF 12345`;

      const importPayload = {
        bank: "HDFC",
        fileName: "e2e-pii-test.csv",
        credits: [
          {
            date: getUtcDateString(2),
            amountPaise: 1000000,
            rail: "NEFT",
            utr: syntheticUtr,
            payerName: piiPayerName,
            narration: piiNarration,
          },
        ],
      };

      await callImportAction(sql, TEST_SHOP_DOMAIN, importPayload);
      await runMatcher(sql, testShopId, { limit: 10 });

      const allLogs = consoleLogs.join("\n");

      expect(allLogs).not.toContain(piiPayerName);
      expect(allLogs).not.toContain("SECRET");
      expect(allLogs).not.toContain("CONFIDENTIAL");
      expect(allLogs).not.toContain(".myshopify.com");
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("E2E: cross-shop isolation (shop B cannot see shop A data)", async () => {
    const shopBSuffix = `${TEST_SUFFIX}-b`;
    const shopBDomain = `test-e2e-match-${shopBSuffix}.myshopify.com`;

    const [shopB] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${shopBDomain}, 'INR', 'UTC', NOW(), NOW())
      RETURNING id
    `;

    try {
      const syntheticUtr = `SYNTISO${TEST_SUFFIX.toUpperCase().slice(0, 8)}`;
      const importPayload = {
        bank: "HDFC",
        fileName: "e2e-isolation-test.csv",
        credits: [
          {
            date: getUtcDateString(2),
            amountPaise: 8500000,
            rail: "NEFT",
            utr: syntheticUtr,
            payerName: "E2E SYNTHETIC WHOLESALE CORP",
            narration: `NEFT CR-E2E SYNTHETIC WHOLESALE-#E2E1001`,
          },
        ],
      };

      await callImportAction(sql, TEST_SHOP_DOMAIN, importPayload);

      const shopAPayments = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM "Payment"
        WHERE "shopId" = ${testShopId}
      `;
      expect(parseInt(shopAPayments[0].count, 10)).toBe(1);

      const shopBPayments = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM "Payment"
        WHERE "shopId" = ${shopB.id}
      `;
      expect(parseInt(shopBPayments[0].count, 10)).toBe(0);
    } finally {
      await sql`DELETE FROM "Shop" WHERE id = ${shopB.id}`;
    }
  });
});
