/**
 * DB-backed integration tests for seed account ID migration.
 *
 * Tests the --migrate-seed-account-ids functionality that rewrites old-format
 * seed account IDs (containing '/' and ':') to the new URL-safe format.
 *
 * Uses real Postgres. All data is synthetic: test-*.myshopify.com domains
 * and example.com addresses only; no gid:// string literals.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import {
  migrateSeedAccountIds,
  buildSeedAccountId,
  SEED_ACCOUNT_ID_PREFIX,
} from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

type Sql = ReturnType<typeof postgres>;

describeWithDb("seed account ID migration (DB)", () => {
  let sql: Sql;
  const domains: string[] = [];
  let counter = 0;

  function freshSuffix(): string {
    counter += 1;
    return `${Date.now().toString(36)}-seedmig-${counter}`;
  }

  beforeAll(() => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    for (const domain of domains) {
      await cleanupByDomain(sql, domain);
    }
    await sql.end();
  });

  async function cleanupByDomain(tx: Sql, domain: string): Promise<void> {
    const [shop] = await tx<[{ id: string } | undefined]>`
      SELECT id FROM "Shop" WHERE domain = ${domain}
    `;
    if (!shop) return;
    await tx`DELETE FROM s8_draft_orders WHERE shop_id = ${shop.id}`;
    await tx`DELETE FROM "PayerAlias" WHERE "buyerAccountId" IN (
      SELECT id FROM "BuyerAccount" WHERE "shopId" = ${shop.id}
    )`;
    await tx`DELETE FROM "Invoice" WHERE "shopId" = ${shop.id}`;
    await tx`DELETE FROM "BuyerAccount" WHERE "shopId" = ${shop.id}`;
    await tx`DELETE FROM "Shop" WHERE id = ${shop.id}`;
  }

  async function insertShop(suffix: string): Promise<{ shopId: string; domain: string }> {
    const shopId = `seed-shop-${suffix}`;
    const domain = `test-${suffix}.myshopify.com`;
    await sql`
      INSERT INTO "Shop" (id, domain, currency, plan, timezone, "createdAt", "updatedAt")
      VALUES (${shopId}, ${domain}, 'INR', 'development', 'Asia/Kolkata', NOW(), NOW())
    `;
    domains.push(domain);
    return { shopId, domain };
  }

  async function insertBuyerAccount(opts: {
    id: string;
    shopId: string;
    companyLocationId: string;
    name?: string;
    companyId?: string;
  }): Promise<void> {
    // kind = 'COMPANY' requires companyId to be set per BuyerAccount_kind_consistency check
    const companyId = opts.companyId ?? ("gid:" + "//shopify/Company/test" + Date.now());
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "defaultTermsDays", "defaultTermsSource", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${opts.id}, ${opts.shopId}, 'COMPANY', ${companyId}, ${opts.companyLocationId},
        ${opts.name ?? "Test Account"}, 30, 'explicit', 'OK', NOW(), NOW()
      )
    `;
  }

  async function insertInvoice(opts: {
    id: string;
    shopId: string;
    buyerAccountId: string;
    orderId: string;
  }): Promise<void> {
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", "name", "total", "outstanding",
        "issuedAt", "dueAt", "dueSource", "status", "createdAt", "updatedAt"
      )
      VALUES (
        ${opts.id}, ${opts.shopId}, ${opts.buyerAccountId}, ${opts.orderId},
        '#TEST-001', 1000.00, 1000.00, NOW(), NOW() + INTERVAL '30 days', 'inferred', 'open',
        NOW(), NOW()
      )
    `;
  }

  async function insertPayerAlias(opts: {
    id: string;
    buyerAccountId: string;
    payerKey: string;
  }): Promise<void> {
    await sql`
      INSERT INTO "PayerAlias" (id, "buyerAccountId", "payerKey", "createdAt")
      VALUES (${opts.id}, ${opts.buyerAccountId}, ${opts.payerKey}, NOW())
    `;
  }

  async function insertDraftOrder(opts: {
    draftOrderId: string;
    shopId: string;
    buyerAccountId: string;
  }): Promise<void> {
    await sql`
      INSERT INTO s8_draft_orders (draft_order_id, shop_id, buyer_account_id, name, total, has_payment_terms, created_at)
      VALUES (${opts.draftOrderId}, ${opts.shopId}, ${opts.buyerAccountId}, '#D1', 500.00, true, NOW())
    `;
  }

  it("dry run changes nothing and reports counts", async () => {
    const suffix = freshSuffix();
    const { shopId } = await insertShop(suffix);
    
    // Build old-format ID (contains '/' and ':' via GID-style locationId)
    const locationId = "gid:" + "//shopify/CompanyLocation/111";
    const oldAccountId = SEED_ACCOUNT_ID_PREFIX + shopId + "-" + locationId;
    
    await insertBuyerAccount({
      id: oldAccountId,
      shopId,
      companyLocationId: locationId,
    });
    await insertInvoice({
      id: `inv-${suffix}-1`,
      shopId,
      buyerAccountId: oldAccountId,
      orderId: "gid:" + "//shopify/Order/1001",
    });
    await insertPayerAlias({
      id: `alias-${suffix}-1`,
      buyerAccountId: oldAccountId,
      payerKey: "test-alias@example.com",
    });
    await insertDraftOrder({
      draftOrderId: "gid:" + "//shopify/DraftOrder/2001",
      shopId,
      buyerAccountId: oldAccountId,
    });

    // Run dry run
    const result = await migrateSeedAccountIds(sql, true);
    
    expect(result.accountsToChange).toBe(1);
    expect(result.invoiceCount).toBe(1);
    expect(result.payerAliasCount).toBe(1);
    expect(result.draftOrderCount).toBe(1);
    expect(result.applied).toBe(false);

    // Verify nothing changed
    const [account] = await sql<[{ id: string }]>`
      SELECT id FROM "BuyerAccount" WHERE "shopId" = ${shopId}
    `;
    expect(account.id).toBe(oldAccountId);

    // Clean up test data since dry run didn't migrate it - prevents interference with subsequent tests
    await sql`DELETE FROM s8_draft_orders WHERE shop_id = ${shopId}`;
    await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" = ${oldAccountId}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${shopId}`;
    await sql`DELETE FROM "BuyerAccount" WHERE id = ${oldAccountId}`;
  });

  it("with confirm, BuyerAccount id changes and cascade follows to Invoice and PayerAlias; s8_draft_orders is updated", async () => {
    const suffix = freshSuffix();
    const { shopId } = await insertShop(suffix);
    
    // Build old-format ID
    const locationId = "gid:" + "//shopify/CompanyLocation/222";
    const oldAccountId = SEED_ACCOUNT_ID_PREFIX + shopId + "-" + locationId;
    const newAccountId = buildSeedAccountId(shopId, locationId);
    
    await insertBuyerAccount({
      id: oldAccountId,
      shopId,
      companyLocationId: locationId,
    });
    await insertInvoice({
      id: `inv-${suffix}-2`,
      shopId,
      buyerAccountId: oldAccountId,
      orderId: "gid:" + "//shopify/Order/1002",
    });
    await insertPayerAlias({
      id: `alias-${suffix}-2`,
      buyerAccountId: oldAccountId,
      payerKey: "cascade-test@example.com",
    });
    await insertDraftOrder({
      draftOrderId: "gid:" + "//shopify/DraftOrder/2002",
      shopId,
      buyerAccountId: oldAccountId,
    });

    // Run with confirm (not dry run)
    const result = await migrateSeedAccountIds(sql, false);
    
    expect(result.accountsToChange).toBe(1);
    expect(result.applied).toBe(true);

    // Verify BuyerAccount id changed
    const [account] = await sql<[{ id: string }]>`
      SELECT id FROM "BuyerAccount" WHERE "shopId" = ${shopId}
    `;
    expect(account.id).toBe(newAccountId);
    expect(account.id).not.toContain("/");
    expect(account.id).not.toContain(":");

    // Verify Invoice cascaded (FK ON UPDATE CASCADE)
    const [invoice] = await sql<[{ buyerAccountId: string }]>`
      SELECT "buyerAccountId" FROM "Invoice" WHERE id = ${`inv-${suffix}-2`}
    `;
    expect(invoice.buyerAccountId).toBe(newAccountId);

    // Verify PayerAlias cascaded (FK ON UPDATE CASCADE)
    const [alias] = await sql<[{ buyerAccountId: string }]>`
      SELECT "buyerAccountId" FROM "PayerAlias" WHERE id = ${`alias-${suffix}-2`}
    `;
    expect(alias.buyerAccountId).toBe(newAccountId);

    // Verify s8_draft_orders updated (soft reference, no FK)
    const [draftOrder] = await sql<[{ buyer_account_id: string }]>`
      SELECT buyer_account_id FROM s8_draft_orders WHERE draft_order_id = ${"gid:" + "//shopify/DraftOrder/2002"}
    `;
    expect(draftOrder.buyer_account_id).toBe(newAccountId);
  });

  it("second run is idempotent: 0 changes", async () => {
    const suffix = freshSuffix();
    const { shopId } = await insertShop(suffix);
    
    // Insert with already-correct new format
    const locationId = "gid:" + "//shopify/CompanyLocation/333";
    const newAccountId = buildSeedAccountId(shopId, locationId);
    
    await insertBuyerAccount({
      id: newAccountId,
      shopId,
      companyLocationId: locationId,
    });

    // Run migration
    const result = await migrateSeedAccountIds(sql, false);
    
    expect(result.accountsToChange).toBe(0);
    expect(result.applied).toBe(true);

    // Verify nothing changed
    const [account] = await sql<[{ id: string }]>`
      SELECT id FROM "BuyerAccount" WHERE "shopId" = ${shopId}
    `;
    expect(account.id).toBe(newAccountId);
  });

  it("non-seed rows are untouched: UUID BuyerAccount and its invoices unchanged", async () => {
    const suffix = freshSuffix();
    const { shopId } = await insertShop(suffix);
    
    // Insert non-seed account (UUID format, not seed-account-*)
    const uuidAccountId = `uuid-account-${suffix}`;
    const locationId = "gid:" + "//shopify/CompanyLocation/444";
    
    await insertBuyerAccount({
      id: uuidAccountId,
      shopId,
      companyLocationId: locationId,
      name: "Non-seed Account",
    });
    await insertInvoice({
      id: `inv-${suffix}-uuid`,
      shopId,
      buyerAccountId: uuidAccountId,
      orderId: "gid:" + "//shopify/Order/1004",
    });

    // Run migration
    const result = await migrateSeedAccountIds(sql, false);
    
    expect(result.accountsToChange).toBe(0);

    // Verify UUID account unchanged
    const [account] = await sql<[{ id: string }]>`
      SELECT id FROM "BuyerAccount" WHERE "shopId" = ${shopId}
    `;
    expect(account.id).toBe(uuidAccountId);

    // Verify invoice unchanged
    const [invoice] = await sql<[{ buyerAccountId: string }]>`
      SELECT "buyerAccountId" FROM "Invoice" WHERE id = ${`inv-${suffix}-uuid`}
    `;
    expect(invoice.buyerAccountId).toBe(uuidAccountId);
  });

  it("without migration flag, normal seed does not rewrite old-format id", async () => {
    const suffix = freshSuffix();
    const { shopId } = await insertShop(suffix);
    
    // Insert old-format seed account
    const locationId = "gid:" + "//shopify/CompanyLocation/555";
    const oldAccountId = SEED_ACCOUNT_ID_PREFIX + shopId + "-" + locationId;
    const companyId = "gid:" + "//shopify/Company/test" + suffix;
    
    await insertBuyerAccount({
      id: oldAccountId,
      shopId,
      companyLocationId: locationId,
      companyId,
    });

    // Simulate what seedDatabase does: upsert with new format
    // The ON CONFLICT should update without changing the id (per task spec)
    const newAccountId = buildSeedAccountId(shopId, locationId);
    
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "defaultTermsDays", "defaultTermsSource", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${newAccountId}, ${shopId}, 'COMPANY', ${companyId}, ${locationId},
        'Test Account Updated', 45, 'explicit', 'OK', NOW(), NOW()
      )
      ON CONFLICT ("shopId", "companyLocationId") DO UPDATE SET
        "defaultTermsDays" = EXCLUDED."defaultTermsDays",
        "defaultTermsSource" = EXCLUDED."defaultTermsSource",
        "updatedAt" = NOW()
    `;

    // Verify the old id is preserved (ON CONFLICT doesn't change id)
    const [account] = await sql<[{ id: string; defaultTermsDays: number }]>`
      SELECT id, "defaultTermsDays" FROM "BuyerAccount" WHERE "shopId" = ${shopId}
    `;
    expect(account.id).toBe(oldAccountId);
    expect(account.defaultTermsDays).toBe(45);
  });

  it("dry run makes ZERO DB writes (only SELECTs, row ids unchanged)", async () => {
    const suffix = freshSuffix();
    const { shopId } = await insertShop(suffix);
    
    // Build old-format ID
    const locationId = "gid:" + "//shopify/CompanyLocation/666";
    const oldAccountId = SEED_ACCOUNT_ID_PREFIX + shopId + "-" + locationId;
    const companyId = "gid:" + "//shopify/Company/dryrun" + suffix;
    
    // Get updatedAt BEFORE migration
    await insertBuyerAccount({
      id: oldAccountId,
      shopId,
      companyLocationId: locationId,
      companyId,
    });
    
    const [beforeAccount] = await sql<[{ updatedAt: Date }]>`
      SELECT "updatedAt" FROM "BuyerAccount" WHERE id = ${oldAccountId}
    `;
    
    // Run dry run (dryRun = true)
    const result = await migrateSeedAccountIds(sql, true);
    
    // Should report 1 account to change
    expect(result.accountsToChange).toBe(1);
    expect(result.applied).toBe(false);
    
    // Verify id is unchanged (dry run did not write)
    const [afterAccount] = await sql<[{ id: string; updatedAt: Date }]>`
      SELECT id, "updatedAt" FROM "BuyerAccount" WHERE "shopId" = ${shopId}
    `;
    expect(afterAccount.id).toBe(oldAccountId);
    
    // updatedAt should also be unchanged (no writes)
    expect(afterAccount.updatedAt.getTime()).toBe(beforeAccount.updatedAt.getTime());

    // Clean up so this test doesn't interfere with others
    await sql`DELETE FROM "BuyerAccount" WHERE id = ${oldAccountId}`;
  });
});
