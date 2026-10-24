/**
 * Preflight for .github/workflows/prod-backfill-dry-run.yml.
 * 1. The exact argv the workflow passes must parse as dry-run (via the script's own parseArgs).
 * 2. The DATABASE_URL session must be read-only (default_transaction_read_only=on).
 * Uses sqlOptions from db-light.server, the same options the backfill run uses.
 * Prints booleans only; never prints the URL or error text.
 */
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { parseArgs } from "../backstop-backfill";

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
  // Same connection config as the backfill run (scripts/backstop-backfill.ts).
  const sql = postgres(url, sqlOptions);
  let readOnly = false;
  try {
    const rows = await sql<{ default_transaction_read_only: string }[]>`SHOW default_transaction_read_only`;
    readOnly = rows[0]?.default_transaction_read_only === "on";
  } catch {
    console.error("preflight: DB check failed");
    process.exit(1);
  } finally {
    await sql.end().catch(() => {});
  }
  if (!readOnly) {
    console.error("preflight: session is not read-only");
    process.exit(1);
  }
  console.log("preflight: default_transaction_read_only=on");
}

main().catch(() => {
  console.error("preflight: failed");
  process.exit(1);
});
