/**
 * Preflight for .github/workflows/prod-backfill-dry-run.yml.
 *
 * 1. The exact argv the workflow passes must parse as dry-run (via the script's own parseArgs).
 * 2. An explicit READ ONLY transaction must enforce transaction_read_only=on.
 *
 * NOTE: The session-level default_transaction_read_only=on URL param is kept in the workflow
 * as defence in depth but cannot be relied on with transaction-mode poolers (Supavisor)
 * that strip startup parameters. Instead, we open an explicit READ ONLY transaction and:
 *   - Assert current_setting('transaction_read_only') = 'on'
 *   - Verify writes are rejected (CREATE TEMP TABLE fails with SQLSTATE 25006)
 *
 * Uses sqlOptions from db-light.server, the same options the backfill run uses.
 * Prints booleans only; never prints the URL or error text.
 */
import postgres from "postgres";
import { pathToFileURL } from "node:url";
import { sqlOptions } from "~/lib/db-light.server";
import { parseArgs } from "../backstop-backfill";

/**
 * Verifies that an explicit READ ONLY transaction is enforced.
 * Returns ok:true only if the transaction is read-only AND writes are rejected with SQLSTATE 25006.
 * Any other outcome returns ok:false (fail closed).
 */
type VerifyResult = { ok: boolean; error?: string };

export async function verifyReadOnlyTransaction(
  sql: ReturnType<typeof postgres>
): Promise<VerifyResult> {
  let innerResult: VerifyResult | null = null;

  try {
    await sql.begin("read only", async (tx) => {
      const [setting] = await tx<{ transaction_read_only: string }[]>`
        SELECT current_setting('transaction_read_only') AS transaction_read_only
      `;
      if (setting?.transaction_read_only !== "on") {
        innerResult = { ok: false, error: "transaction_read_only is not 'on'" };
        return;
      }

      try {
        await tx`CREATE TEMP TABLE _preflight_write_test (id int)`;
        innerResult = { ok: false, error: "write succeeded inside READ ONLY transaction" };
      } catch (e) {
        const pgError = e as { code?: string };
        if (pgError.code === "25006") {
          innerResult = { ok: true };
        } else {
          innerResult = { ok: false, error: `unexpected error: ${pgError.code ?? "unknown"}` };
        }
      }
    });
  } catch (e) {
    const pgError = e as { code?: string };
    const result = innerResult as VerifyResult | null;
    if (result !== null && result.ok === true && pgError.code === "25006") {
      return result;
    }
    return { ok: false, error: `transaction failed: ${pgError.code ?? "unknown"}` };
  }

  if (innerResult === null) {
    return { ok: false, error: "no result from transaction" };
  }
  return innerResult;
}

async function main(): Promise<void> {
  const since = process.env.SINCE ?? "";
  const until = process.env.UNTIL ?? "";
  const parsed = parseArgs(["--since", since, "--until", until]);
  if (parsed.dryRun !== true || parsed.error) {
    console.error("preflight: argv is not dry-run");
    process.exit(1);
  }
  console.log("preflight: dryRun=true");

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("preflight: DATABASE_URL missing");
    process.exit(1);
  }

  const sql = postgres(url, sqlOptions);
  try {
    const result = await verifyReadOnlyTransaction(sql);
    if (!result.ok) {
      console.error("preflight: READ ONLY transaction check failed");
      process.exit(1);
    }
    console.log("preflight: READ ONLY transaction verified (transaction_read_only=on, writes rejected)");
  } finally {
    await sql.end().catch(() => {});
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("preflight: failed");
    process.exit(1);
  });
}
