/**
 * Preflight for .github/workflows/prod-credit-status-backfill-dry-run.yml.
 *
 * 1. The exact argv the workflow passes (--dry-run) must parse as dry-run via the
 *    script's own parseArgs (dryRun=true, apply=false, no error).
 * 2. An explicit READ ONLY transaction must report transaction_read_only=on and reject writes.
 *
 * Prints booleans only; never prints the URL or error text.
 */
import postgres from "postgres";
import { pathToFileURL } from "node:url";
import { sqlOptions } from "~/lib/db-light.server";
import { parseArgs } from "../credit-status-metafield-backfill";
import { verifyReadOnlyTransaction } from "./backfill-dry-run-preflight";

export const WORKFLOW_ARGV = ["--dry-run"] as const;

export function argvIsDryRunOnly(argv: readonly string[]): boolean {
  const p = parseArgs([...argv]);
  return p.dryRun === true && p.apply === false && !p.argError && !argv.includes("--apply");
}

async function main(): Promise<void> {
  if (!argvIsDryRunOnly(WORKFLOW_ARGV)) {
    console.error("preflight: argv is not dry-run");
    process.exit(1);
  }
  console.log("preflight: dryRun=true apply=false");

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
    console.log("preflight: READ ONLY transaction verified");
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
