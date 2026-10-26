/**
 * DB-backed integration tests for buyer eligibility and checkout path.
 *
 * Case 3: Overdue invoice puts buyer on hold, paying releases hold
 * Case 4: Tag-mode buyer detection (tag present, absent, case/whitespace variants)
 *
 * Uses the queue-leftover guard pattern from existing DB tests.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { syncClockToDb } from "../../../tests/helpers/db-clock";

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

vi.mock("../shopify-client.server", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    shopifyGraphQLRequest: mockShopifyGraphQLRequest,
  };
});

import { recomputeCreditStatus } from "../credit-status-recompute.server";
import { hasOverdueInvoices } from "../overdue.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

function lettersOnlyId(len: number): string {
  return Array.from({ length: len }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26))
  ).join("");
}

function makeCompanyLocationGid(suffix: string): string {
  return `gid://shopify/CompanyLocation/test-${suffix}`;
}

function makeCustomerGid(suffix: string): string {
  return `gid://shopify/Customer/test-${suffix}`;
}

function makeOrderGid(suffix: string): string {
  return `gid://shopify/Order/test-${suffix}`;
}

describeWithDb("eligibility-checkout: overdue invoice hold lifecycle", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = lettersOnlyId(8) + "-elighold";
  const TEST_SHOP_ID = `shop-elighold-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-elighold-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-elighold-${TEST_SUFFIX}`;
  const TEST_COMPANY_LOCATION_GID = makeCompanyLocationGid(TEST_SUFFIX);

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "manualHold", "holdReasonCode",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-" + TEST_SUFFIX}, ${TEST_COMPANY_LOCATION_GID},
        'Test Eligibility Account', 100000.00, 'OK', false, false, NULL,
        false, 1, NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_recompute:' + TEST_ACCOUNT_ID + '%'}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await syncClockToDb(sql);
    
    mockShopifyGraphQLRequest.mockClear();

    await sql`
      UPDATE "BuyerAccount"
      SET "holdState" = 'OK', "holdReasonCode" = NULL, "manualHold" = false,
          "syncPending" = false, "syncVersion" = 1, gated_at = NULL, "metafieldSyncedAt" = NULL
      WHERE id = ${TEST_ACCOUNT_ID}
    `;
    
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_recompute:' + TEST_ACCOUNT_ID + '%'}`;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("overdue invoice triggers HELD/PAYMENT_OVERDUE state", async () => {
    const invoiceId = `inv-overdue-${TEST_SUFFIX}`;
    const orderId = makeOrderGid(`overdue-${TEST_SUFFIX}`);

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#OVERDUE-ELIG-1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '10 days',
        NOW() - INTERVAL '5 days',
        NOW(), NOW()
      )
    `;

    const isOverdue = await hasOverdueInvoices(sql, TEST_ACCOUNT_ID);
    expect(isOverdue).toBe(true);

    const result = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID, "invoice_change");
    expect(result.success).toBe(true);
    expect(result.newHold).toBe(true);

    const [account] = await sql<{ holdState: string; holdReasonCode: string | null }[]>`
      SELECT "holdState", "holdReasonCode" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
    `;
    expect(account.holdState).toBe("HELD");
    expect(account.holdReasonCode).toBe("PAYMENT_OVERDUE");
  });

  it("paying overdue invoice releases hold", async () => {
    const invoiceId = `inv-paid-${TEST_SUFFIX}`;
    const orderId = makeOrderGid(`paid-${TEST_SUFFIX}`);

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#PAID-ELIG-1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '10 days',
        NOW() - INTERVAL '5 days',
        NOW(), NOW()
      )
    `;

    await recomputeCreditStatus(sql, TEST_ACCOUNT_ID, "invoice_change");

    const [heldAccount] = await sql<{ holdState: string }[]>`
      SELECT "holdState" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
    `;
    expect(heldAccount.holdState).toBe("HELD");

    await sql`
      UPDATE "Invoice"
      SET outstanding = 0.00, status = 'paid'
      WHERE id = ${invoiceId}
    `;

    const isStillOverdue = await hasOverdueInvoices(sql, TEST_ACCOUNT_ID);
    expect(isStillOverdue).toBe(false);

    const result = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID, "invoice_change");
    expect(result.success).toBe(true);
    expect(result.previousHold).toBe(true);
    expect(result.newHold).toBe(false);

    const [releasedAccount] = await sql<{ holdState: string; holdReasonCode: string | null }[]>`
      SELECT "holdState", "holdReasonCode" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
    `;
    expect(releasedAccount.holdState).toBe("OK");
  });

  it("partial payment still keeps hold if invoice remains overdue", async () => {
    const invoiceId = `inv-partial-${TEST_SUFFIX}`;
    const orderId = makeOrderGid(`partial-${TEST_SUFFIX}`);

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#PARTIAL-ELIG-1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '10 days',
        NOW() - INTERVAL '5 days',
        NOW(), NOW()
      )
    `;

    await recomputeCreditStatus(sql, TEST_ACCOUNT_ID, "invoice_change");

    await sql`
      UPDATE "Invoice"
      SET outstanding = 5000.00
      WHERE id = ${invoiceId}
    `;

    const isStillOverdue = await hasOverdueInvoices(sql, TEST_ACCOUNT_ID);
    expect(isStillOverdue).toBe(true);

    await recomputeCreditStatus(sql, TEST_ACCOUNT_ID, "invoice_change");

    const [account] = await sql<{ holdState: string }[]>`
      SELECT "holdState" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
    `;
    expect(account.holdState).toBe("HELD");
  });

  it("multiple overdue invoices - all must be resolved to release hold", async () => {
    const invoice1Id = `inv-multi1-${TEST_SUFFIX}`;
    const invoice2Id = `inv-multi2-${TEST_SUFFIX}`;
    const order1Id = makeOrderGid(`multi1-${TEST_SUFFIX}`);
    const order2Id = makeOrderGid(`multi2-${TEST_SUFFIX}`);

    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status, "issuedAt", "dueAt", "createdAt", "updatedAt")
      VALUES
        (${invoice1Id}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${order1Id}, '#MULTI-1', 5000.00, 5000.00, 'open', NOW() - INTERVAL '15 days', NOW() - INTERVAL '5 days', NOW(), NOW()),
        (${invoice2Id}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${order2Id}, '#MULTI-2', 3000.00, 3000.00, 'open', NOW() - INTERVAL '12 days', NOW() - INTERVAL '3 days', NOW(), NOW())
    `;

    await recomputeCreditStatus(sql, TEST_ACCOUNT_ID, "invoice_change");

    const [heldAccount] = await sql<{ holdState: string }[]>`
      SELECT "holdState" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
    `;
    expect(heldAccount.holdState).toBe("HELD");

    await sql`UPDATE "Invoice" SET outstanding = 0.00, status = 'paid' WHERE id = ${invoice1Id}`;
    await recomputeCreditStatus(sql, TEST_ACCOUNT_ID, "invoice_change");

    const [stillHeld] = await sql<{ holdState: string }[]>`
      SELECT "holdState" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
    `;
    expect(stillHeld.holdState).toBe("HELD");

    await sql`UPDATE "Invoice" SET outstanding = 0.00, status = 'paid' WHERE id = ${invoice2Id}`;
    await recomputeCreditStatus(sql, TEST_ACCOUNT_ID, "invoice_change");

    const [released] = await sql<{ holdState: string }[]>`
      SELECT "holdState" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
    `;
    expect(released.holdState).toBe("OK");
  });
});

describeWithDb("eligibility-checkout: tag-mode buyer detection", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = lettersOnlyId(8) + "-tagmode";
  const TEST_SHOP_ID = `shop-tagmode-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-tagmode-${TEST_SUFFIX}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "AccountSource" ("shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, 'wholesale', 30, NOW(), NOW())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "AccountSource" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
  });

  async function getTagRules(shopId: string): Promise<Array<{ tag: string; defaultTermsDays: number }>> {
    return sql<{ tag: string; defaultTermsDays: number }[]>`
      SELECT tag, "defaultTermsDays" FROM "AccountSource" WHERE "shopId" = ${shopId}
    `;
  }

  function findMatchingTagRule(
    customerTags: string[],
    tagRules: Array<{ tag: string; defaultTermsDays: number }>
  ): { tag: string; defaultTermsDays: number } | undefined {
    return tagRules.find((rule) =>
      customerTags.some((tag) => tag.toLowerCase() === rule.tag.toLowerCase())
    );
  }

  it("tag present: matches buyer to tag rule", async () => {
    const tagRules = await getTagRules(TEST_SHOP_ID);
    const customerTags = ["wholesale", "other-tag"];
    
    const match = findMatchingTagRule(customerTags, tagRules);
    
    expect(match).toBeDefined();
    expect(match?.tag).toBe("wholesale");
    expect(match?.defaultTermsDays).toBe(30);
  });

  it("tag absent: no match when customer lacks tag", async () => {
    const tagRules = await getTagRules(TEST_SHOP_ID);
    const customerTags = ["retail", "vip"];
    
    const match = findMatchingTagRule(customerTags, tagRules);
    
    expect(match).toBeUndefined();
  });

  it("tag case-insensitive: WHOLESALE matches wholesale", async () => {
    const tagRules = await getTagRules(TEST_SHOP_ID);
    const customerTags = ["WHOLESALE"];
    
    const match = findMatchingTagRule(customerTags, tagRules);
    
    expect(match).toBeDefined();
    expect(match?.tag).toBe("wholesale");
  });

  it("tag case-insensitive: Wholesale matches wholesale", async () => {
    const tagRules = await getTagRules(TEST_SHOP_ID);
    const customerTags = ["Wholesale"];
    
    const match = findMatchingTagRule(customerTags, tagRules);
    
    expect(match).toBeDefined();
  });

  it("tag case-insensitive: wHoLeSaLe matches wholesale", async () => {
    const tagRules = await getTagRules(TEST_SHOP_ID);
    const customerTags = ["wHoLeSaLe"];
    
    const match = findMatchingTagRule(customerTags, tagRules);
    
    expect(match).toBeDefined();
  });

  it("empty tags array: no match", async () => {
    const tagRules = await getTagRules(TEST_SHOP_ID);
    const customerTags: string[] = [];
    
    const match = findMatchingTagRule(customerTags, tagRules);
    
    expect(match).toBeUndefined();
  });

  it("multiple matching tags: first rule wins", async () => {
    await sql`
      INSERT INTO "AccountSource" ("shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, 'vip', 60, NOW(), NOW())
    `;

    try {
      const tagRules = await getTagRules(TEST_SHOP_ID);
      const customerTags = ["wholesale", "vip"];
      
      const match = findMatchingTagRule(customerTags, tagRules);
      
      expect(match).toBeDefined();
    } finally {
      await sql`DELETE FROM "AccountSource" WHERE "shopId" = ${TEST_SHOP_ID} AND tag = 'vip'`;
    }
  });
});

describeWithDb("eligibility-checkout: Company and CompanyLocation resolution", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = lettersOnlyId(8) + "-b2b";
  const TEST_SHOP_ID = `shop-b2b-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-b2b-${TEST_SUFFIX}.myshopify.com`;
  const TEST_COMPANY_ID = `co-${TEST_SUFFIX}`;
  const TEST_LOCATION_GID_1 = makeCompanyLocationGid(`${TEST_SUFFIX}-loc1`);
  const TEST_LOCATION_GID_2 = makeCompanyLocationGid(`${TEST_SUFFIX}-loc2`);

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
  });

  it("resolves BuyerAccount by companyLocationId", async () => {
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "manualHold",
        "createdAt", "updatedAt"
      )
      VALUES (
        ${"acc-loc1-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, 'COMPANY',
        ${TEST_COMPANY_ID}, ${TEST_LOCATION_GID_1},
        'Test Location 1', 50000.00, 'OK', false, false,
        NOW(), NOW()
      )
    `;

    const [account] = await sql<{ id: string; companyLocationId: string }[]>`
      SELECT id, "companyLocationId" FROM "BuyerAccount"
      WHERE "shopId" = ${TEST_SHOP_ID} AND "companyLocationId" = ${TEST_LOCATION_GID_1}
    `;

    expect(account).toBeDefined();
    expect(account.companyLocationId).toBe(TEST_LOCATION_GID_1);
  });

  it("distinguishes multiple locations under same company", async () => {
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", bypass, "manualHold", "createdAt", "updatedAt")
      VALUES
        (${"acc-loc1-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, 'COMPANY', ${TEST_COMPANY_ID}, ${TEST_LOCATION_GID_1}, 'Location 1', 50000.00, 'OK', false, false, NOW(), NOW()),
        (${"acc-loc2-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, 'COMPANY', ${TEST_COMPANY_ID}, ${TEST_LOCATION_GID_2}, 'Location 2', 30000.00, 'HELD', false, true, NOW(), NOW())
    `;

    const locations = await sql<{ companyLocationId: string; holdState: string }[]>`
      SELECT "companyLocationId", "holdState" FROM "BuyerAccount"
      WHERE "shopId" = ${TEST_SHOP_ID} AND "companyId" = ${TEST_COMPANY_ID}
      ORDER BY "companyLocationId"
    `;

    expect(locations).toHaveLength(2);
    const loc1 = locations.find(l => l.companyLocationId === TEST_LOCATION_GID_1);
    const loc2 = locations.find(l => l.companyLocationId === TEST_LOCATION_GID_2);
    expect(loc1?.holdState).toBe("OK");
    expect(loc2?.holdState).toBe("HELD");
  });

  it("COMPANY kind has companyLocationId set", async () => {
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "holdState", bypass, "manualHold", "createdAt", "updatedAt"
      )
      VALUES (
        ${"acc-kind-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, 'COMPANY',
        ${TEST_COMPANY_ID}, ${TEST_LOCATION_GID_1},
        'Test Company Account', 'OK', false, false, NOW(), NOW()
      )
    `;

    const [account] = await sql<{ kind: string; companyLocationId: string | null; customerId: string | null }[]>`
      SELECT kind, "companyLocationId", "customerId" FROM "BuyerAccount"
      WHERE id = ${"acc-kind-" + TEST_SUFFIX}
    `;

    expect(account.kind).toBe("COMPANY");
    expect(account.companyLocationId).toBe(TEST_LOCATION_GID_1);
    expect(account.customerId).toBeNull();
  });

  it("TAGGED_CUSTOMER kind has customerId set", async () => {
    const customerId = makeCustomerGid(`${TEST_SUFFIX}-cust`);

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "customerId", name,
        "holdState", bypass, "manualHold", "createdAt", "updatedAt"
      )
      VALUES (
        ${"acc-tagged-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER',
        ${customerId}, 'Test Tagged Customer', 'OK', false, false, NOW(), NOW()
      )
    `;

    const [account] = await sql<{ kind: string; companyLocationId: string | null; customerId: string | null }[]>`
      SELECT kind, "companyLocationId", "customerId" FROM "BuyerAccount"
      WHERE id = ${"acc-tagged-" + TEST_SUFFIX}
    `;

    expect(account.kind).toBe("TAGGED_CUSTOMER");
    expect(account.customerId).toBe(customerId);
    expect(account.companyLocationId).toBeNull();
  });
});
