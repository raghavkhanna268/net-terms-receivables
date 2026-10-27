/**
 * Static analysis tests for the pgmq archive retention migration.
 *
 * Tests:
 * - unschedule comes before the single schedule call
 * - exact name, schedule and the two DELETEs
 * - no other DML or DDL
 * - notices are fixed text
 * - the data-retention.md row exists
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const MIGRATION_PATH = path.join(
  ROOT,
  "prisma/migrations/20261126000000_pgmq_archive_purge_30d/migration.sql"
);
const DATA_RETENTION_PATH = path.join(ROOT, "docs/security/data-retention.md");

const migrationSql = fs.readFileSync(MIGRATION_PATH, "utf8");

describe("pgmq-archive-retention-migration", () => {
  describe("structure", () => {
    it("unschedule comes before the single schedule call", () => {
      const unscheduleMatch = migrationSql.match(/cron\.unschedule\(/);
      const scheduleMatch = migrationSql.match(/cron\.schedule\(/);

      expect(unscheduleMatch).not.toBeNull();
      expect(scheduleMatch).not.toBeNull();

      const unscheduleIndex = migrationSql.indexOf("cron.unschedule(");
      const scheduleIndex = migrationSql.indexOf("cron.schedule(");

      expect(unscheduleIndex).toBeLessThan(scheduleIndex);

      const scheduleMatches = migrationSql.match(/PERFORM cron\.schedule\(/g);
      expect(scheduleMatches).toHaveLength(1);
    });

    it("has exact job name pgmq_purge_archives_30d", () => {
      expect(migrationSql).toContain("'pgmq_purge_archives_30d'");

      const nameMatches = migrationSql.match(/pgmq_purge_archives_30d/g);
      expect(nameMatches!.length).toBeGreaterThanOrEqual(2);
    });

    it("has exact schedule 30 5 * * *", () => {
      expect(migrationSql).toContain("'30 5 * * *'");
    });

    it("has two DELETE statements for the archive tables", () => {
      expect(migrationSql).toContain("DELETE FROM pgmq.a_s6_sync");
      expect(migrationSql).toContain("DELETE FROM pgmq.a_s6_bulk");

      expect(migrationSql).toContain("INTERVAL '30 days'");
    });
  });

  describe("safety", () => {
    it("has no other DML or DDL outside the DO block", () => {
      const codeOutsideDo = migrationSql
        .replace(/DO \$do\$[\s\S]*?\$do\$;/g, "")
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n");

      expect(codeOutsideDo).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\b/i
      );
    });

    it("has no SECURITY DEFINER", () => {
      expect(migrationSql).not.toContain("SECURITY DEFINER");
    });

    it("has no SET ROLE or cron.schedule_in_database", () => {
      expect(migrationSql).not.toContain("SET ROLE");
      expect(migrationSql).not.toContain("schedule_in_database");
    });
  });

  describe("notices", () => {
    it("has fixed notice text for pg_cron not available", () => {
      expect(migrationSql).toContain(
        "RAISE NOTICE 'pg_cron not available; skipping pgmq_purge_archives_30d job (OK for CI)'"
      );
    });
  });

  describe("documentation", () => {
    it("has a row for pgmq_purge_archives_30d in data-retention.md", () => {
      const dataRetention = fs.readFileSync(DATA_RETENTION_PATH, "utf8");

      expect(dataRetention).toContain("`pgmq_purge_archives_30d`");
      expect(dataRetention).toContain("`30 5 * * *`");
      expect(dataRetention).toContain("20261126000000_pgmq_archive_purge_30d");
    });
  });
});
