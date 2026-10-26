/**
 * Real-DB integration tests for data-request download route.
 *
 * Tests the case where a data request row exists but export_data is NULL
 * (pending or redacted state). The route should return 404 and NOT call
 * markDataRequestDownloaded or recordAccess.
 *
 * Run with: TEST_DATABASE_URL=postgresql://... npm test -- app.data-requests.download-db
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { getDataRequestExport } from "~/services/compliance";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("data-request download DB integration", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-dr-download";

  const SHOP_ID = `shop-${TEST_SUFFIX}`;
  const SHOP_DOMAIN = `test-shop-${TEST_SUFFIX}.myshopify.com`;
  const REQUEST_ID_PENDING = `req-pending-${TEST_SUFFIX}`;
  const REQUEST_ID_COMPLETED = `req-completed-${TEST_SUFFIX}`;
  const CUSTOMER_GID = `gid://shopify/Customer/${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    await sql`
      INSERT INTO s22_data_requests (
        id, shop_id, customer_gid, request_id, status, export_data, created_at
      ) VALUES (
        gen_random_uuid()::text,
        ${SHOP_ID},
        ${CUSTOMER_GID},
        ${REQUEST_ID_PENDING},
        'pending',
        NULL,
        NOW()
      )
    `;

    await sql`
      INSERT INTO s22_data_requests (
        id, shop_id, customer_gid, request_id, status, export_data, created_at
      ) VALUES (
        gen_random_uuid()::text,
        ${SHOP_ID},
        ${CUSTOMER_GID},
        ${REQUEST_ID_COMPLETED},
        'completed',
        ${sql.json({ customerGid: CUSTOMER_GID, data: { test: true } })},
        NOW()
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM s22_data_requests WHERE shop_id = ${SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
    await sql.end();
  });

  it("returns null for row with NULL export_data (pending state)", async () => {
    const result = await getDataRequestExport(sql, SHOP_ID, REQUEST_ID_PENDING);

    expect(result).toBeNull();
  });

  it("returns export data for row with non-NULL export_data", async () => {
    const result = await getDataRequestExport(sql, SHOP_ID, REQUEST_ID_COMPLETED);

    expect(result).not.toBeNull();
    expect(result!.id).toBeDefined();
    expect(result!.exportData).toEqual({ customerGid: CUSTOMER_GID, data: { test: true } });
  });

  it("returns null for non-existent request", async () => {
    const result = await getDataRequestExport(sql, SHOP_ID, "non-existent-request");

    expect(result).toBeNull();
  });

  it("returns null for request from different shop", async () => {
    const result = await getDataRequestExport(sql, "different-shop-id", REQUEST_ID_COMPLETED);

    expect(result).toBeNull();
  });
});
