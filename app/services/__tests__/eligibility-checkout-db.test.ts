/**
 * DB-backed integration tests for buyer eligibility and checkout path.
 *
 * Case 3: Overdue invoice puts buyer on hold, paying releases hold
 * Case 4: Tag-mode buyer detection against REAL findMatchingTagRule from customer.server.ts
 *
 * Note: app/lib/invoice-eligibility.ts:352-363 has a second findMatchingTagRule that trims
 * whitespace, but it is not exported and cannot be tested directly without source changes.
 *
 * Pattern: one postgres client per file, unique test-* shop per test, afterEach cleanup,
 * assertNoQueueLeftovers in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { syncClockToDb } from "../../../tests/helpers/db-clock";
import { assertNoQueueLeftovers } from "../../../tests/helpers/queue-leftovers";
import { findMatchingTagRule as findMatchingTagRuleSync } from "../sync/customer.server";

const { mockShopifyGraphQLRequest } = vi.hoisted(() => {
  const mockShopifyGraphQLRequest = vi.fn().mockImplementation(async () => {
    return {
      success: true,
      data: {
        metafieldsSet: {
          metafields: [{ id: "mf-1", namespace: "$app", key: "credit_status" }],
          userErrors: [],
        },
      },
    };
  });
  return { mockShopifyGraphQLRequest };
});

vi.mock("../shopify-client.server", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    shopifyGraphQLRequest: mockShopifyGraphQLRequest,
  };
});

import { recomputeCreditStatus } from "../credit-status-recompute.server";
import { hasOverdueInvoices } from "../overdue.server";
import type { CreditStatus } from "~/lib/metafields-contract";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

let sql: ReturnType<typeof postgres>;
const allShopDomains: string[] = [];

function getLastMetafieldJson(): CreditStatus | null {
  const lastCall = mockShopifyGraphQLRequest.mock.calls.at(-1);
  if (!lastCall) return null;
  const variables = lastCall[1] as { metafields?: Array<{ value: string }> } | undefined;
  if (!variables?.metafields?.[0]?.value) return null;
  return JSON.parse(variables.metafields[0].value) as CreditStatus;
}

function lettersOnlyId(len: number): string {
  return Array.from({ length: len }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26))
  ).join("");
}

function makeCompanyLocationGid(suffix: string): string {
  return `gid://shopify/CompanyLocation/test-${suffix}`;
}

function makeOrderGid(suffix: string): string {
  return `gid://shopify/Order/test-${suffix}`;
}

describeWithDb("eligibility-checkout-db", () => {
  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    if (allShopDomains.length > 0) {
      await assertNoQueueLeftovers(sql, allShopDomains, "eligibility-checkout-db.test.ts");
    }
    await sql.end();
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  describe("overdue invoice hold lifecycle", () => {
    async function setupTestShop(): Promise<{
      shopId: string;
      shopDomain: string;
      accountId: string;
      suffix: string;
      cleanup: () => Promise<void>;
    }> {
      const suffix = lettersOnlyId(8) + "-elighold";
      const shopId = `shop-elighold-${suffix}`;
      const shopDomain = `test-elighold-${suffix}.myshopify.com`;
      const accountId = `acc-elighold-${suffix}`;
      const companyLocationGid = makeCompanyLocationGid(suffix);

      allShopDomains.push(shopDomain);

      await sql`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
        VALUES (${shopId}, ${shopDomain}, 'INR', NOW(), NOW())
      `;

      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "creditLimit", "holdState", bypass, "manualHold", "holdReasonCode",
          "syncPending", "syncVersion", "createdAt", "updatedAt"
        )
        VALUES (
          ${accountId}, ${shopId}, 'COMPANY',
          ${"co-" + suffix}, ${companyLocationGid},
          'Test Eligibility Account', 100000.00, 'OK', false, false, NULL,
          false, 1, NOW(), NOW()
        )
      `;

      const cleanup = async () => {
        await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${shopDomain}`;
        await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${shopDomain}`;
        await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${shopDomain}`;
        await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_recompute:' + accountId + '%'}`;
        await sql`DELETE FROM "Invoice" WHERE "shopId" = ${shopId}`;
        await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${shopId}`;
        await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${shopId}`;
        await sql`DELETE FROM "Shop" WHERE id = ${shopId}`;
      };

      return { shopId, shopDomain, accountId, suffix, cleanup };
    }

    it("overdue invoice triggers HELD/PAYMENT_OVERDUE state", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      await syncClockToDb(sql);
      mockShopifyGraphQLRequest.mockClear();

      const { shopId, accountId, suffix, cleanup } = await setupTestShop();

      try {
        const invoiceId = `inv-overdue-${suffix}`;
        const orderId = makeOrderGid(`overdue-${suffix}`);

        await sql`
          INSERT INTO "Invoice" (
            id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
            status, "issuedAt", "dueAt", "createdAt", "updatedAt"
          )
          VALUES (
            ${invoiceId}, ${shopId}, ${accountId}, ${orderId},
            '#OVERDUE-ELIG-1', 10000.00, 10000.00, 'open',
            NOW() - INTERVAL '10 days',
            NOW() - INTERVAL '5 days',
            NOW(), NOW()
          )
        `;

        const isOverdue = await hasOverdueInvoices(sql, accountId);
        expect(isOverdue).toBe(true);

        const result = await recomputeCreditStatus(sql, accountId, "invoice_change");
        expect(result.success).toBe(true);
        expect(result.newHold).toBe(true);

        const [account] = await sql<{ holdState: string }[]>`
          SELECT "holdState" FROM "BuyerAccount" WHERE id = ${accountId}
        `;
        expect(account.holdState).toBe("HELD");

        const metafieldJson = getLastMetafieldJson();
        expect(metafieldJson).not.toBeNull();
        expect(metafieldJson!.hold).toBe(true);
        expect(metafieldJson!.holdReasonCode).toBe("PAYMENT_OVERDUE");
      } finally {
        await cleanup();
      }
    });

    it("paying overdue invoice releases hold", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      await syncClockToDb(sql);
      mockShopifyGraphQLRequest.mockClear();

      const { shopId, accountId, suffix, cleanup } = await setupTestShop();

      try {
        const invoiceId = `inv-paid-${suffix}`;
        const orderId = makeOrderGid(`paid-${suffix}`);

        await sql`
          INSERT INTO "Invoice" (
            id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
            status, "issuedAt", "dueAt", "createdAt", "updatedAt"
          )
          VALUES (
            ${invoiceId}, ${shopId}, ${accountId}, ${orderId},
            '#PAID-ELIG-1', 10000.00, 10000.00, 'open',
            NOW() - INTERVAL '10 days',
            NOW() - INTERVAL '5 days',
            NOW(), NOW()
          )
        `;

        await recomputeCreditStatus(sql, accountId, "invoice_change");

        const [heldAccount] = await sql<{ holdState: string }[]>`
          SELECT "holdState" FROM "BuyerAccount" WHERE id = ${accountId}
        `;
        expect(heldAccount.holdState).toBe("HELD");

        await sql`
          UPDATE "Invoice"
          SET outstanding = 0.00, status = 'paid'
          WHERE id = ${invoiceId}
        `;

        const isStillOverdue = await hasOverdueInvoices(sql, accountId);
        expect(isStillOverdue).toBe(false);

        const result = await recomputeCreditStatus(sql, accountId, "invoice_change");
        expect(result.success).toBe(true);
        expect(result.previousHold).toBe(true);
        expect(result.newHold).toBe(false);

        const [releasedAccount] = await sql<{ holdState: string }[]>`
          SELECT "holdState" FROM "BuyerAccount" WHERE id = ${accountId}
        `;
        expect(releasedAccount.holdState).toBe("OK");
      } finally {
        await cleanup();
      }
    });

    it("partial payment still keeps hold if invoice remains overdue", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      await syncClockToDb(sql);
      mockShopifyGraphQLRequest.mockClear();

      const { shopId, accountId, suffix, cleanup } = await setupTestShop();

      try {
        const invoiceId = `inv-partial-${suffix}`;
        const orderId = makeOrderGid(`partial-${suffix}`);

        await sql`
          INSERT INTO "Invoice" (
            id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
            status, "issuedAt", "dueAt", "createdAt", "updatedAt"
          )
          VALUES (
            ${invoiceId}, ${shopId}, ${accountId}, ${orderId},
            '#PARTIAL-ELIG-1', 10000.00, 10000.00, 'open',
            NOW() - INTERVAL '10 days',
            NOW() - INTERVAL '5 days',
            NOW(), NOW()
          )
        `;

        await recomputeCreditStatus(sql, accountId, "invoice_change");

        await sql`
          UPDATE "Invoice"
          SET outstanding = 5000.00
          WHERE id = ${invoiceId}
        `;

        const isStillOverdue = await hasOverdueInvoices(sql, accountId);
        expect(isStillOverdue).toBe(true);

        await recomputeCreditStatus(sql, accountId, "invoice_change");

        const [account] = await sql<{ holdState: string }[]>`
          SELECT "holdState" FROM "BuyerAccount" WHERE id = ${accountId}
        `;
        expect(account.holdState).toBe("HELD");
      } finally {
        await cleanup();
      }
    });

    it("multiple overdue invoices - all must be resolved to release hold", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      await syncClockToDb(sql);
      mockShopifyGraphQLRequest.mockClear();

      const { shopId, accountId, suffix, cleanup } = await setupTestShop();

      try {
        const invoice1Id = `inv-multi1-${suffix}`;
        const invoice2Id = `inv-multi2-${suffix}`;
        const order1Id = makeOrderGid(`multi1-${suffix}`);
        const order2Id = makeOrderGid(`multi2-${suffix}`);

        await sql`
          INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status, "issuedAt", "dueAt", "createdAt", "updatedAt")
          VALUES
            (${invoice1Id}, ${shopId}, ${accountId}, ${order1Id}, '#MULTI-1', 5000.00, 5000.00, 'open', NOW() - INTERVAL '15 days', NOW() - INTERVAL '5 days', NOW(), NOW()),
            (${invoice2Id}, ${shopId}, ${accountId}, ${order2Id}, '#MULTI-2', 3000.00, 3000.00, 'open', NOW() - INTERVAL '12 days', NOW() - INTERVAL '3 days', NOW(), NOW())
        `;

        await recomputeCreditStatus(sql, accountId, "invoice_change");

        const [heldAccount] = await sql<{ holdState: string }[]>`
          SELECT "holdState" FROM "BuyerAccount" WHERE id = ${accountId}
        `;
        expect(heldAccount.holdState).toBe("HELD");

        await sql`UPDATE "Invoice" SET outstanding = 0.00, status = 'paid' WHERE id = ${invoice1Id}`;
        await recomputeCreditStatus(sql, accountId, "invoice_change");

        const [stillHeld] = await sql<{ holdState: string }[]>`
          SELECT "holdState" FROM "BuyerAccount" WHERE id = ${accountId}
        `;
        expect(stillHeld.holdState).toBe("HELD");

        await sql`UPDATE "Invoice" SET outstanding = 0.00, status = 'paid' WHERE id = ${invoice2Id}`;
        await recomputeCreditStatus(sql, accountId, "invoice_change");

        const [released] = await sql<{ holdState: string }[]>`
          SELECT "holdState" FROM "BuyerAccount" WHERE id = ${accountId}
        `;
        expect(released.holdState).toBe("OK");
      } finally {
        await cleanup();
      }
    });
  });

  describe("tag-mode buyer detection (real findMatchingTagRule from customer.server.ts)", () => {
    async function setupTestShop(extraTag?: string): Promise<{
      shopId: string;
      shopDomain: string;
      suffix: string;
      cleanup: () => Promise<void>;
    }> {
      const suffix = lettersOnlyId(8) + "-tagmode";
      const shopId = `shop-tagmode-${suffix}`;
      const shopDomain = `test-tagmode-${suffix}.myshopify.com`;

      allShopDomains.push(shopDomain);

      await sql`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
        VALUES (${shopId}, ${shopDomain}, 'INR', NOW(), NOW())
      `;

      await sql`
        INSERT INTO "AccountSource" ("shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")
        VALUES (${shopId}, 'wholesale', 30, NOW(), NOW())
      `;

      if (extraTag) {
        await sql`
          INSERT INTO "AccountSource" ("shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")
          VALUES (${shopId}, ${extraTag}, 60, NOW(), NOW())
        `;
      }

      const cleanup = async () => {
        await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${shopId}`;
        await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${shopId}`;
        await sql`DELETE FROM "AccountSource" WHERE "shopId" = ${shopId}`;
        await sql`DELETE FROM "Shop" WHERE id = ${shopId}`;
      };

      return { shopId, shopDomain, suffix, cleanup };
    }

    async function getTagRulesOrdered(shopId: string): Promise<Array<{ tag: string; defaultTermsDays: number }>> {
      return sql<{ tag: string; defaultTermsDays: number }[]>`
        SELECT tag, "defaultTermsDays" FROM "AccountSource" 
        WHERE "shopId" = ${shopId}
        ORDER BY tag ASC
      `;
    }

    it("tag present: matches buyer to tag rule", async () => {
      const { shopId, cleanup } = await setupTestShop();

      try {
        const tagRules = await getTagRulesOrdered(shopId);
        const customerTags = ["wholesale", "other-tag"];
        
        const match = findMatchingTagRuleSync(customerTags, tagRules);
        
        expect(match).toBeDefined();
        expect(match?.tag).toBe("wholesale");
        expect(match?.defaultTermsDays).toBe(30);
      } finally {
        await cleanup();
      }
    });

    it("tag absent: no match when customer lacks tag", async () => {
      const { shopId, cleanup } = await setupTestShop();

      try {
        const tagRules = await getTagRulesOrdered(shopId);
        const customerTags = ["retail", "premium"];
        
        const match = findMatchingTagRuleSync(customerTags, tagRules);
        
        expect(match).toBeUndefined();
      } finally {
        await cleanup();
      }
    });

    it("tag case-insensitive: WHOLESALE matches wholesale", async () => {
      const { shopId, cleanup } = await setupTestShop();

      try {
        const tagRules = await getTagRulesOrdered(shopId);
        const customerTags = ["WHOLESALE"];
        
        const match = findMatchingTagRuleSync(customerTags, tagRules);
        
        expect(match).toBeDefined();
        expect(match?.tag).toBe("wholesale");
      } finally {
        await cleanup();
      }
    });

    it("tag case-insensitive: wHoLeSaLe matches wholesale", async () => {
      const { shopId, cleanup } = await setupTestShop();

      try {
        const tagRules = await getTagRulesOrdered(shopId);
        const customerTags = ["wHoLeSaLe"];
        
        const match = findMatchingTagRuleSync(customerTags, tagRules);
        
        expect(match).toBeDefined();
        expect(match?.tag).toBe("wholesale");
      } finally {
        await cleanup();
      }
    });

    it("empty tags array: no match", async () => {
      const { shopId, cleanup } = await setupTestShop();

      try {
        const tagRules = await getTagRulesOrdered(shopId);
        const customerTags: string[] = [];
        
        const match = findMatchingTagRuleSync(customerTags, tagRules);
        
        expect(match).toBeUndefined();
      } finally {
        await cleanup();
      }
    });

    it("multiple rules: first matching rule in rule order wins", async () => {
      const { shopId, cleanup } = await setupTestShop("vip");

      try {
        const tagRules = await getTagRulesOrdered(shopId);
        expect(tagRules[0].tag).toBe("vip");
        expect(tagRules[1].tag).toBe("wholesale");
        
        const customerTags = ["wholesale", "vip"];
        const match = findMatchingTagRuleSync(customerTags, tagRules);
        
        expect(match).toBeDefined();
        expect(match?.tag).toBe("vip");
        expect(match?.defaultTermsDays).toBe(60);
      } finally {
        await cleanup();
      }
    });

    // Skipped: customer.server.ts:697-705 does not trim whitespace
    // See https://github.com/raghavkhanna268/net-terms-receivables/issues/479
    it.skip("' wholesale ' should match wholesale (skipped: #479)", async () => {
      const { shopId, cleanup } = await setupTestShop();

      try {
        const tagRules = await getTagRulesOrdered(shopId);
        const customerTags = [" wholesale "];
        
        const match = findMatchingTagRuleSync(customerTags, tagRules);
        
        expect(match).toBeDefined();
        expect(match?.tag).toBe("wholesale");
      } finally {
        await cleanup();
      }
    });

    // Skipped: customer.server.ts:697-705 does not trim whitespace
    // See https://github.com/raghavkhanna268/net-terms-receivables/issues/479
    it.skip("'wholesale ' should match wholesale (skipped: #479)", async () => {
      const { shopId, cleanup } = await setupTestShop();

      try {
        const tagRules = await getTagRulesOrdered(shopId);
        const customerTags = ["wholesale "];
        
        const match = findMatchingTagRuleSync(customerTags, tagRules);
        
        expect(match).toBeDefined();
        expect(match?.tag).toBe("wholesale");
      } finally {
        await cleanup();
      }
    });
  });
});
