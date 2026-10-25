/**
 * Documentation and migration consistency tests for access event retention.
 *
 * Ensures:
 * - docs/security/data-retention.md references the job name
 * - The migration file contains the job name and schedule from constants
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ACCESS_EVENT_PURGE_JOB,
  ACCESS_EVENT_PURGE_SCHEDULE,
} from "../retention.server";

const DOCS_PATH = resolve(
  __dirname,
  "../../../docs/security/data-retention.md"
);
const MIGRATION_PATH = resolve(
  __dirname,
  "../../../prisma/migrations/20261115000000_access_event_purge/migration.sql"
);

describe("retention docs consistency", () => {
  it("data-retention.md contains the purge job name", () => {
    const docsContent = readFileSync(DOCS_PATH, "utf-8");
    expect(docsContent).toContain(ACCESS_EVENT_PURGE_JOB);
  });

  it("data-retention.md mentions 365 days retention for access events", () => {
    const docsContent = readFileSync(DOCS_PATH, "utf-8");
    expect(docsContent).toMatch(/access\.\*.*365\s*days|365\s*days.*access\.\*/i);
  });
});

describe("retention migration consistency", () => {
  it("migration file contains the job name", () => {
    const migrationContent = readFileSync(MIGRATION_PATH, "utf-8");
    expect(migrationContent).toContain(ACCESS_EVENT_PURGE_JOB);
  });

  it("migration file contains the schedule", () => {
    const migrationContent = readFileSync(MIGRATION_PATH, "utf-8");
    expect(migrationContent).toContain(ACCESS_EVENT_PURGE_SCHEDULE);
  });

  it("migration file contains LIKE 'access.%' pattern", () => {
    const migrationContent = readFileSync(MIGRATION_PATH, "utf-8");
    expect(migrationContent).toContain("LIKE 'access.%'");
  });

  it("migration file contains 365 days interval", () => {
    const migrationContent = readFileSync(MIGRATION_PATH, "utf-8");
    expect(migrationContent).toContain("INTERVAL '365 days'");
  });
});
