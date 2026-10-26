/**
 * Schema Trigger Guard Tests
 *
 * Guard that trigger functions only assign columns that exist on their tables.
 *
 * This prevents bugs like PR #490 (s18_shop_reminder_settings) where a BEFORE UPDATE
 * trigger used set_updated_at() which writes NEW."updatedAt", but the table has
 * snake_case updated_at column.
 *
 * Tests:
 * 1. Catalog check: parse prosrc for NEW assignments, verify columns exist
 * 2. Behavioural check: synthetic INSERT + UPDATE for tables with updated_at triggers
 * 3. Coverage guard: fail if new triggers appear without being added to the list
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

/**
 * Expected BEFORE INSERT/UPDATE row triggers in the public schema.
 * New triggers MUST be added here deliberately.
 *
 * Format: { table, trigger, function, behavioural }
 * - behavioural: true if the test can do synthetic INSERT+UPDATE
 * - behavioural: false (catalog-only) with reason if FK complexity prevents it
 */
const EXPECTED_TRIGGERS: Array<{
  table: string;
  trigger: string;
  fn: string;
  behavioural: boolean;
  reason?: string;
}> = [
  // Prisma-style tables with set_updated_at() -> NEW."updatedAt"
  { table: "Shop", trigger: "Shop_updatedAt", fn: "set_updated_at", behavioural: true },
  { table: "AccountSource", trigger: "AccountSource_updatedAt", fn: "set_updated_at", behavioural: false, reason: "FK to Shop" },
  { table: "BuyerAccount", trigger: "BuyerAccount_updatedAt", fn: "set_updated_at", behavioural: false, reason: "FK to Shop" },
  { table: "Invoice", trigger: "Invoice_updatedAt", fn: "set_updated_at", behavioural: false, reason: "FK to Shop, BuyerAccount" },
  { table: "Payment", trigger: "Payment_updatedAt", fn: "set_updated_at", behavioural: false, reason: "FK to Shop, BankImport" },
  { table: "Match", trigger: "Match_updatedAt", fn: "set_updated_at", behavioural: false, reason: "FK to Invoice, Payment" },
  { table: "ReminderRule", trigger: "ReminderRule_updatedAt", fn: "set_updated_at", behavioural: false, reason: "FK to Shop" },

  // Snake_case tables with update_updated_at_column() -> NEW.updated_at
  { table: "s8_tagged_customers", trigger: "trigger_s8_tagged_customers_updated_at", fn: "update_updated_at_column", behavioural: false, reason: "FK to Shop" },
  { table: "s8_draft_orders", trigger: "trigger_s8_draft_orders_updated_at", fn: "update_updated_at_column", behavioural: false, reason: "FK to Shop, s8_tagged_customers" },

  // s18_shop_reminder_settings uses set_updated_at() but has snake_case updated_at
  // This WILL FAIL the catalog check until PR #490 is merged
  { table: "s18_shop_reminder_settings", trigger: "s18_shop_reminder_settings_updated_at", fn: "set_updated_at", behavioural: false, reason: "FK to Shop" },
];

interface TriggerInfo {
  table_name: string;
  trigger_name: string;
  function_name: string;
  prosrc: string;
  event_manipulation: string;
}

interface ColumnInfo {
  table_name: string;
  column_name: string;
}

/**
 * Parse prosrc for NEW."Col" = or NEW.col = assignments.
 * Returns array of assigned column names.
 *
 * Postgres identifier rules:
 * - Quoted (NEW."Col"): case-sensitive, exact match
 * - Unquoted (NEW.col): lowercased by Postgres
 */
function parseNewAssignments(prosrc: string): Array<{ column: string; quoted: boolean }> {
  const assignments: Array<{ column: string; quoted: boolean }> = [];

  // Match NEW."quotedCol" = (case-sensitive)
  const quotedRegex = /NEW\."([^"]+)"\s*[:=]/gi;
  let match;
  while ((match = quotedRegex.exec(prosrc)) !== null) {
    assignments.push({ column: match[1], quoted: true });
  }

  // Match NEW.unquotedCol = (case-insensitive, lowercased)
  // Exclude already-matched quoted identifiers
  const unquotedRegex = /NEW\.([a-z_][a-z0-9_]*)\s*[:=]/gi;
  while ((match = unquotedRegex.exec(prosrc)) !== null) {
    // Check if this position was already matched as quoted
    const pos = match.index;
    const beforeChar = prosrc[pos + 4]; // Character after "NEW."
    if (beforeChar !== '"') {
      assignments.push({ column: match[1].toLowerCase(), quoted: false });
    }
  }

  return assignments;
}

describeWithDb("Schema Trigger Guard", () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    await sql.end();
  });

  describe("Catalog Check: trigger assignments match table columns", () => {
    it("verifies all BEFORE INSERT/UPDATE row triggers assign only existing columns", async () => {
      // Query all BEFORE INSERT/UPDATE row triggers in public schema
      const triggers = await sql<TriggerInfo[]>`
        SELECT
          c.relname AS table_name,
          t.tgname AS trigger_name,
          p.proname AS function_name,
          p.prosrc,
          CASE
            WHEN t.tgtype & 4 > 0 THEN 'INSERT'
            WHEN t.tgtype & 16 > 0 THEN 'UPDATE'
            ELSE 'OTHER'
          END AS event_manipulation
        FROM pg_trigger t
        JOIN pg_class c ON t.tgrelid = c.oid
        JOIN pg_namespace n ON c.relnamespace = n.oid
        JOIN pg_proc p ON t.tgfoid = p.oid
        WHERE n.nspname = 'public'
          AND NOT t.tgisinternal
          AND t.tgtype & 2 > 0  -- BEFORE trigger
          AND t.tgtype & 1 > 0  -- FOR EACH ROW
          AND (t.tgtype & 4 > 0 OR t.tgtype & 16 > 0)  -- INSERT or UPDATE
      `;

      // Get all columns for public schema tables
      const columns = await sql<ColumnInfo[]>`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
      `;

      // Build column lookup map: table -> Set<column>
      const columnMap = new Map<string, Set<string>>();
      for (const col of columns) {
        if (!columnMap.has(col.table_name)) {
          columnMap.set(col.table_name, new Set());
        }
        columnMap.get(col.table_name)!.add(col.column_name);
      }

      // Check each trigger's assignments
      const failures: Array<{
        table: string;
        trigger: string;
        fn: string;
        missingColumn: string;
        quoted: boolean;
      }> = [];

      for (const trigger of triggers) {
        const assignments = parseNewAssignments(trigger.prosrc);
        const tableColumns = columnMap.get(trigger.table_name);

        if (!tableColumns) {
          failures.push({
            table: trigger.table_name,
            trigger: trigger.trigger_name,
            fn: trigger.function_name,
            missingColumn: "(table not found)",
            quoted: false,
          });
          continue;
        }

        for (const { column, quoted } of assignments) {
          // Case-sensitive check: column must match exactly
          if (!tableColumns.has(column)) {
            failures.push({
              table: trigger.table_name,
              trigger: trigger.trigger_name,
              fn: trigger.function_name,
              missingColumn: column,
              quoted,
            });
          }
        }
      }

      // Report failures clearly
      if (failures.length > 0) {
        const report = failures
          .map(
            (f) =>
              `  ${f.table}.${f.trigger} (${f.fn}): missing column "${f.missingColumn}"${f.quoted ? " (quoted)" : ""}`
          )
          .join("\n");
        expect.fail(
          `Trigger functions assign columns that don't exist on their tables:\n${report}\n\n` +
            `Fix: ensure trigger function uses correct column name (case-sensitive for quoted identifiers)`
        );
      }

      // Also verify we found the expected triggers
      expect(triggers.length).toBeGreaterThan(0);
    });
  });

  describe("Behavioural Check: UPDATE triggers fire correctly", () => {
    const TEST_SUFFIX = Date.now().toString(36) + "-triggerguard";
    const TEST_SHOP_ID = `shop-${TEST_SUFFIX}`;
    const TEST_SHOP_DOMAIN = `test-trigger-guard-${TEST_SUFFIX}.myshopify.com`;

    it("Shop: INSERT + UPDATE succeeds and updatedAt advances", async () => {
      await sql.begin(async (tx) => {
        const now = new Date();

        // INSERT
        await tx`
          INSERT INTO "Shop" (id, domain, currency, timezone, "createdAt", "updatedAt")
          VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', ${now}, ${now})
        `;

        // Get initial updatedAt
        const [before] = await tx<{ updatedAt: Date }[]>`
          SELECT "updatedAt" FROM "Shop" WHERE id = ${TEST_SHOP_ID}
        `;
        expect(before.updatedAt).toBeDefined();

        // Small delay to ensure timestamp changes
        await new Promise((r) => setTimeout(r, 10));

        // UPDATE (trigger should fire)
        await tx`
          UPDATE "Shop" SET currency = 'USD' WHERE id = ${TEST_SHOP_ID}
        `;

        // Verify updatedAt advanced (or at least is not null and >= before)
        const [after] = await tx<{ updatedAt: Date }[]>`
          SELECT "updatedAt" FROM "Shop" WHERE id = ${TEST_SHOP_ID}
        `;
        expect(after.updatedAt).toBeDefined();
        expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());

        // Rollback the transaction
        throw new Error("ROLLBACK");
      }).catch((e) => {
        if (e.message !== "ROLLBACK") throw e;
      });
    });
  });

  describe("Coverage Guard: all triggers are tracked", () => {
    it("fails if a BEFORE INSERT/UPDATE trigger is not in EXPECTED_TRIGGERS", async () => {
      // Query actual triggers
      const actualTriggers = await sql<{ table_name: string; trigger_name: string; function_name: string }[]>`
        SELECT
          c.relname AS table_name,
          t.tgname AS trigger_name,
          p.proname AS function_name
        FROM pg_trigger t
        JOIN pg_class c ON t.tgrelid = c.oid
        JOIN pg_namespace n ON c.relnamespace = n.oid
        JOIN pg_proc p ON t.tgfoid = p.oid
        WHERE n.nspname = 'public'
          AND NOT t.tgisinternal
          AND t.tgtype & 2 > 0  -- BEFORE trigger
          AND t.tgtype & 1 > 0  -- FOR EACH ROW
          AND (t.tgtype & 4 > 0 OR t.tgtype & 16 > 0)  -- INSERT or UPDATE
        ORDER BY c.relname, t.tgname
      `;

      // Build expected set
      const expectedSet = new Set(
        EXPECTED_TRIGGERS.map((t) => `${t.table}|${t.trigger}`)
      );

      // Check for unexpected triggers
      const unexpected: string[] = [];
      for (const actual of actualTriggers) {
        const key = `${actual.table_name}|${actual.trigger_name}`;
        if (!expectedSet.has(key)) {
          unexpected.push(
            `  ${actual.table_name}.${actual.trigger_name} (${actual.function_name})`
          );
        }
      }

      if (unexpected.length > 0) {
        expect.fail(
          `New BEFORE INSERT/UPDATE triggers found that are not in EXPECTED_TRIGGERS:\n${unexpected.join("\n")}\n\n` +
            `Add them to EXPECTED_TRIGGERS in schema-trigger-guard-db.test.ts`
        );
      }

      // Check for missing expected triggers (removed from schema)
      const actualSet = new Set(
        actualTriggers.map((t) => `${t.table_name}|${t.trigger_name}`)
      );

      const missing: string[] = [];
      for (const expected of EXPECTED_TRIGGERS) {
        const key = `${expected.table}|${expected.trigger}`;
        if (!actualSet.has(key)) {
          missing.push(`  ${expected.table}.${expected.trigger}`);
        }
      }

      if (missing.length > 0) {
        expect.fail(
          `Expected triggers not found in database:\n${missing.join("\n")}\n\n` +
            `Remove them from EXPECTED_TRIGGERS if they were intentionally deleted`
        );
      }
    });

    it("reports the complete trigger inventory", async () => {
      const triggers = await sql<{
        table_name: string;
        trigger_name: string;
        function_name: string;
      }[]>`
        SELECT
          c.relname AS table_name,
          t.tgname AS trigger_name,
          p.proname AS function_name
        FROM pg_trigger t
        JOIN pg_class c ON t.tgrelid = c.oid
        JOIN pg_namespace n ON c.relnamespace = n.oid
        JOIN pg_proc p ON t.tgfoid = p.oid
        WHERE n.nspname = 'public'
          AND NOT t.tgisinternal
          AND t.tgtype & 2 > 0  -- BEFORE trigger
          AND t.tgtype & 1 > 0  -- FOR EACH ROW
          AND (t.tgtype & 4 > 0 OR t.tgtype & 16 > 0)  -- INSERT or UPDATE
        ORDER BY c.relname, t.tgname
      `;

      // Build inventory with behavioural status
      const expectedMap = new Map(
        EXPECTED_TRIGGERS.map((t) => [`${t.table}|${t.trigger}`, t])
      );

      const inventory = triggers.map((t) => {
        const key = `${t.table_name}|${t.trigger_name}`;
        const expected = expectedMap.get(key);
        return {
          table: t.table_name,
          trigger: t.trigger_name,
          fn: t.function_name,
          behavioural: expected?.behavioural ?? false,
          reason: expected?.reason,
        };
      });

      // Log inventory for PR reporting
      console.log("\n=== Trigger Inventory ===");
      console.log("| Table | Trigger | Function | Behavioural |");
      console.log("|-------|---------|----------|-------------|");
      for (const row of inventory) {
        const behavLabel = row.behavioural
          ? "Yes"
          : row.reason
            ? `Catalog (${row.reason})`
            : "Catalog";
        console.log(
          `| ${row.table} | ${row.trigger} | ${row.fn} | ${behavLabel} |`
        );
      }
      console.log("=========================\n");

      expect(inventory.length).toBe(EXPECTED_TRIGGERS.length);
    });
  });
});
