/**
 * Tests for backfill-dry-run-preflight.ts
 *
 * Verifies that:
 * - verifyReadOnlyTransaction passes inside a READ ONLY transaction
 * - verifyReadOnlyTransaction fails if the transaction is not read-only
 * - verifyReadOnlyTransaction detects write rejection with SQLSTATE 25006
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { verifyReadOnlyTransaction } from "../backfill-dry-run-preflight";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("scripts/ci/backfill-dry-run-preflight", () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(() => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    await sql.end();
  });

  describe("verifyReadOnlyTransaction", () => {
    it("passes inside a READ ONLY transaction", async () => {
      const result = await verifyReadOnlyTransaction(sql);
      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("verifies transaction_read_only is 'on' inside READ ONLY tx", async () => {
      const result = await sql.begin("read only", async (tx) => {
        const [setting] = await tx<{ transaction_read_only: string }[]>`
          SELECT current_setting('transaction_read_only') AS transaction_read_only
        `;
        return setting;
      });
      expect(result.transaction_read_only).toBe("on");
    });

    it("verifies writes are rejected with SQLSTATE 25006 inside READ ONLY tx", async () => {
      let caughtError: { code?: string } | null = null;

      try {
        await sql.begin("read only", async (tx) => {
          await tx`CREATE TEMP TABLE _test_write_rejection (id int)`;
        });
      } catch (e) {
        caughtError = e as { code?: string };
      }

      expect(caughtError).not.toBeNull();
      expect(caughtError!.code).toBe("25006");
    });

    it("would fail if run outside a read-only context (simulation)", async () => {
      const [setting] = await sql<{ transaction_read_only: string }[]>`
        SELECT current_setting('transaction_read_only') AS transaction_read_only
      `;
      expect(setting.transaction_read_only).toBe("off");
    });

    it("returns ok:false when begin ignores mode and opens read-write tx", async () => {
      // Proxy over sql whose begin ignores the mode and calls real sql.begin(fn)
      // This simulates a broken pooler or misconfigured connection that doesn't honor
      // the "read only" mode.
      const proxySql = new Proxy(sql, {
        get(target, prop) {
          if (prop === "begin") {
            return (_mode: string, fn: (tx: ReturnType<typeof postgres>) => Promise<unknown>) => {
              // Ignore the mode, call real begin without "read only"
              return target.begin(fn);
            };
          }
          return Reflect.get(target, prop);
        },
      });

      const result = await verifyReadOnlyTransaction(proxySql);
      expect(result).toEqual({ ok: false, error: "transaction_read_only is not 'on'" });
    });

    it("returns ok:false when begin rejects with 25006 before callback runs", async () => {
      // Wrapper whose begin rejects with error code '25006' before the callback runs.
      // The outer catch must not pass without an inner success.
      const wrapperSql = {
        begin: (_mode: string, _fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
          const error = new Error("cannot execute in a read-only transaction") as Error & { code: string };
          error.code = "25006";
          return Promise.reject(error);
        },
      } as unknown as ReturnType<typeof postgres>;

      const result = await verifyReadOnlyTransaction(wrapperSql);
      expect(result.ok).toBe(false);
      // The error should indicate transaction failure, not pass through as success
      expect(result.error).toContain("transaction failed");
    });

    it("returns ok:false when begin rejects with other error", async () => {
      // Wrapper whose begin rejects with some other error (not 25006).
      const wrapperSql = {
        begin: (_mode: string, _fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
          const error = new Error("connection refused") as Error & { code: string };
          error.code = "08001";
          return Promise.reject(error);
        },
      } as unknown as ReturnType<typeof postgres>;

      const result = await verifyReadOnlyTransaction(wrapperSql);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("transaction failed");
    });
  });
});
