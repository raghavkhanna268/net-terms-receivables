import type postgres from "postgres";
import { expect } from "vitest";

/**
 * Per-file guard asserting that the calling file's own rows are zero in:
 * - pgmq.q_s6_sync (main queue)
 * - pgmq.a_s6_sync (archive)
 * - pgmq.q_s6_bulk (bulk queue - messages carry shop key)
 *
 * Call from afterAll, AFTER the file's own cleanup, to catch leftover rows
 * that could cause flakes in other test files sharing the sequential DB pool.
 *
 * Scopes strictly by the file's own shop domains (message->>'shop' IN (...)),
 * so it never fails on another file's rows.
 */
export async function assertNoQueueLeftovers(
  sql: ReturnType<typeof postgres>,
  shopDomains: string[],
  testFileLabel: string
): Promise<void> {
  if (shopDomains.length === 0) {
    throw new Error(
      `assertNoQueueLeftovers: shopDomains must not be empty (${testFileLabel})`
    );
  }

  const [counts] = await sql<
    [
      {
        q_s6_sync: string;
        a_s6_sync: string;
        q_s6_bulk: string;
      },
    ]
  >`
    SELECT
      (SELECT COUNT(*)::text FROM pgmq.q_s6_sync WHERE message->>'shop' IN ${sql(shopDomains)}) AS q_s6_sync,
      (SELECT COUNT(*)::text FROM pgmq.a_s6_sync WHERE message->>'shop' IN ${sql(shopDomains)}) AS a_s6_sync,
      (SELECT COUNT(*)::text FROM pgmq.q_s6_bulk WHERE message->>'shop' IN ${sql(shopDomains)}) AS q_s6_bulk
  `;

  expect(
    parseInt(counts.q_s6_sync, 10),
    `${testFileLabel}: pgmq.q_s6_sync leftover rows for ${shopDomains.join(", ")}`
  ).toBe(0);

  expect(
    parseInt(counts.a_s6_sync, 10),
    `${testFileLabel}: pgmq.a_s6_sync leftover rows for ${shopDomains.join(", ")}`
  ).toBe(0);

  expect(
    parseInt(counts.q_s6_bulk, 10),
    `${testFileLabel}: pgmq.q_s6_bulk leftover rows for ${shopDomains.join(", ")}`
  ).toBe(0);
}
