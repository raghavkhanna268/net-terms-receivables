import type postgres from "postgres";

/**
 * Archive queue rows belonging to OTHER shops (foreign rows) to prevent
 * cross-test pollution when tests run in a shuffled order.
 *
 * Uses pgmq.archive() to move rows from the active queue to the archive,
 * preserving the message for debugging while removing it from processing.
 *
 * SAFETY: Refuses to run unless TEST_DATABASE_URL is set AND the sql connection's
 * current_database() matches the database name parsed from TEST_DATABASE_URL.
 * This guard reuses the pattern from drain-guard-db, dlq-sanitize-db,
 * orders-no-session-ack-db, and drain-redact-inflight-db (#604 pattern).
 *
 * @param sql - postgres.js connection
 * @param ownShopDomains - Domains belonging to THIS test; all other shops are archived
 * @returns Object with counts of archived sync and bulk rows
 */
export async function archiveForeignQueueRows(
  sql: ReturnType<typeof postgres>,
  ownShopDomains: string[]
): Promise<{ archivedSync: number; archivedBulk: number }> {
  if (ownShopDomains.length === 0) {
    throw new Error("archiveForeignQueueRows: ownShopDomains must not be empty");
  }

  const testDbUrl = process.env.TEST_DATABASE_URL;
  if (!testDbUrl) {
    throw new Error(
      "archiveForeignQueueRows: TEST_DATABASE_URL is not set. " +
        "This helper must only run against the test database."
    );
  }

  const expectedDbName = decodeURIComponent(new URL(testDbUrl).pathname.slice(1));
  const [{ db: actualDbName }] = await sql<[{ db: string }]>`SELECT current_database() AS db`;

  if (actualDbName !== expectedDbName) {
    throw new Error(
      `archiveForeignQueueRows: database mismatch. ` +
        `Connection is to "${actualDbName}" but TEST_DATABASE_URL specifies "${expectedDbName}". ` +
        `This helper must only run against the test database.`
    );
  }

  const [syncResult] = await sql<[{ archived: string }]>`
    WITH visible AS (
      SELECT msg_id FROM pgmq.q_s6_sync
      WHERE message->>'shop' IS NULL
         OR message->>'shop' NOT IN ${sql(ownShopDomains)}
    )
    SELECT count(*)::text AS archived
    FROM pgmq.archive('s6_sync', (SELECT array_agg(msg_id) FROM visible))
  `;

  const [bulkResult] = await sql<[{ archived: string }]>`
    WITH visible AS (
      SELECT msg_id FROM pgmq.q_s6_bulk
      WHERE message->>'shop' IS NULL
         OR message->>'shop' NOT IN ${sql(ownShopDomains)}
    )
    SELECT count(*)::text AS archived
    FROM pgmq.archive('s6_bulk', (SELECT array_agg(msg_id) FROM visible))
  `;

  return {
    archivedSync: parseInt(syncResult.archived, 10),
    archivedBulk: parseInt(bulkResult.archived, 10),
  };
}
