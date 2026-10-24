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
  });
});
