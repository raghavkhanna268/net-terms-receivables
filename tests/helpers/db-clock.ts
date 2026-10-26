import { vi } from "vitest";
import type postgres from "postgres";

/**
 * Read NOW() from the database and sync the JS clock to it.
 *
 * ONE CLOCK = THE DB CLOCK. Tests should read NOW() from Postgres, then sync
 * the JS clock to it with vi.setSystemTime(). All date values should be
 * derived from that same DB instant to avoid JS/DB clock disagreement.
 *
 * Usage:
 * - Call vi.useFakeTimers({ toFake: ["Date"] }) in beforeEach BEFORE this
 * - Call syncClockToDb(sql) to read DB NOW() and sync JS clock
 * - Call vi.useRealTimers() in afterEach to restore
 *
 * @param sql - postgres.js connection
 * @returns The DB's NOW() instant
 */
export async function syncClockToDb(
  sql: ReturnType<typeof postgres>
): Promise<Date> {
  const [row] = await sql<{ now: Date }[]>`SELECT NOW() AS now`;
  const dbNow = row.now;
  vi.setSystemTime(dbNow);
  return dbNow;
}
