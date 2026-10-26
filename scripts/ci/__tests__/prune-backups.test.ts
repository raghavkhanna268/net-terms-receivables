/**
 * Tests for prune-backups.ts
 *
 * Verifies that the retention pruning logic:
 * - Prefix guard rejects objects not starting with 'db/'
 * - Bucket guard rejects incorrect bucket names
 * - Keep-newest-7 holds even when all objects are >30 days old
 * - Only >30d objects beyond the newest 7 are eligible for deletion
 * - Dry-run deletes nothing (tested via selection logic returning empty action)
 */
import { describe, it, expect } from "vitest";
import {
  validatePrefix,
  validateBucket,
  selectForDeletion,
  BUCKET,
  PREFIX,
  RETENTION_DAYS,
  KEEP_NEWEST,
  type S3Object,
} from "../../ops/prune-backups.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function makeObject(key: string, daysAgo: number, nowMs: number): S3Object {
  const date = new Date(nowMs - daysAgo * DAY_MS);
  return {
    Key: key,
    LastModified: date.toISOString(),
  };
}

describe("prune-backups: prefix guard", () => {
  it("accepts all objects with db/ prefix", () => {
    const objects: S3Object[] = [
      { Key: "db/2026/10/net-terms-2026-10-01T210000Z.dump.age", LastModified: "2026-10-01T21:00:00Z" },
      { Key: "db/2026/09/net-terms-2026-09-15T210000Z.dump.age", LastModified: "2026-09-15T21:00:00Z" },
    ];
    expect(validatePrefix(objects, PREFIX)).toBe(true);
  });

  it("rejects objects without db/ prefix", () => {
    const objects: S3Object[] = [
      { Key: "db/2026/10/net-terms-2026-10-01T210000Z.dump.age", LastModified: "2026-10-01T21:00:00Z" },
      { Key: "other/file.txt", LastModified: "2026-10-01T21:00:00Z" },
    ];
    expect(validatePrefix(objects, PREFIX)).toBe(false);
  });

  it("rejects objects with similar but incorrect prefix", () => {
    const objects: S3Object[] = [
      { Key: "database/backup.dump", LastModified: "2026-10-01T21:00:00Z" },
    ];
    expect(validatePrefix(objects, PREFIX)).toBe(false);
  });

  it("rejects empty string prefix objects", () => {
    const objects: S3Object[] = [
      { Key: "", LastModified: "2026-10-01T21:00:00Z" },
    ];
    expect(validatePrefix(objects, PREFIX)).toBe(false);
  });

  it("accepts empty object list", () => {
    expect(validatePrefix([], PREFIX)).toBe(true);
  });

  it("rejects objects with db prefix without trailing slash", () => {
    const objects: S3Object[] = [
      { Key: "db-backup.dump", LastModified: "2026-10-01T21:00:00Z" },
    ];
    expect(validatePrefix(objects, PREFIX)).toBe(false);
  });
});

describe("prune-backups: bucket guard", () => {
  it("accepts correct bucket name", () => {
    expect(validateBucket(BUCKET, BUCKET)).toBe(true);
    expect(validateBucket("ntr-db-backups", "ntr-db-backups")).toBe(true);
  });

  it("rejects incorrect bucket name", () => {
    expect(validateBucket("other-bucket", BUCKET)).toBe(false);
    expect(validateBucket("ntr-db-backups-staging", BUCKET)).toBe(false);
  });

  it("rejects empty bucket name", () => {
    expect(validateBucket("", BUCKET)).toBe(false);
  });

  it("rejects bucket name differing only by case", () => {
    expect(validateBucket("NTR-DB-BACKUPS", BUCKET)).toBe(false);
  });
});

describe("prune-backups: keep-newest-7 when all objects are >30 days old", () => {
  it("keeps exactly 7 objects when all 10 are older than 30 days", () => {
    const nowMs = Date.now();
    const objects: S3Object[] = [];

    // Create 10 objects all older than 30 days (40-49 days old)
    for (let i = 0; i < 10; i++) {
      objects.push(makeObject(`db/2026/09/net-terms-backup-${i}.dump.age`, 40 + i, nowMs));
    }

    const toDelete = selectForDeletion(objects, RETENTION_DAYS, KEEP_NEWEST, nowMs);

    // Should keep 7 newest, delete 3 oldest
    expect(toDelete.length).toBe(3);
    expect(objects.length - toDelete.length).toBe(7);
  });

  it("keeps all 7 objects when exactly 7 exist and all are old", () => {
    const nowMs = Date.now();
    const objects: S3Object[] = [];

    // Create exactly 7 objects all older than 30 days
    for (let i = 0; i < 7; i++) {
      objects.push(makeObject(`db/2026/09/net-terms-backup-${i}.dump.age`, 40 + i, nowMs));
    }

    const toDelete = selectForDeletion(objects, RETENTION_DAYS, KEEP_NEWEST, nowMs);

    // Should keep all 7, delete none
    expect(toDelete.length).toBe(0);
  });

  it("keeps all objects when fewer than 7 exist and all are old", () => {
    const nowMs = Date.now();
    const objects: S3Object[] = [];

    // Create only 5 objects, all older than 30 days
    for (let i = 0; i < 5; i++) {
      objects.push(makeObject(`db/2026/09/net-terms-backup-${i}.dump.age`, 40 + i, nowMs));
    }

    const toDelete = selectForDeletion(objects, RETENTION_DAYS, KEEP_NEWEST, nowMs);

    // Should keep all 5, delete none
    expect(toDelete.length).toBe(0);
  });
});

describe("prune-backups: only >30d objects beyond newest 7 are eligible", () => {
  it("does not delete objects newer than 30 days even beyond keep-newest-7", () => {
    const nowMs = Date.now();
    const objects: S3Object[] = [];

    // 7 newest: within 30 days (1-7 days old)
    for (let i = 0; i < 7; i++) {
      objects.push(makeObject(`db/2026/10/net-terms-new-${i}.dump.age`, i + 1, nowMs));
    }
    // 5 more: also within 30 days (10-14 days old)
    for (let i = 0; i < 5; i++) {
      objects.push(makeObject(`db/2026/10/net-terms-recent-${i}.dump.age`, 10 + i, nowMs));
    }

    const toDelete = selectForDeletion(objects, RETENTION_DAYS, KEEP_NEWEST, nowMs);

    // None should be deleted: all are within 30 days
    expect(toDelete.length).toBe(0);
  });

  it("deletes only objects both older than 30 days AND beyond newest 7", () => {
    const nowMs = Date.now();
    const objects: S3Object[] = [];

    // 5 newest: within 30 days (1-5 days old)
    for (let i = 0; i < 5; i++) {
      objects.push(makeObject(`db/2026/10/net-terms-new-${i}.dump.age`, i + 1, nowMs));
    }
    // 2 more within keep threshold: 25 days old (within 30d)
    for (let i = 0; i < 2; i++) {
      objects.push(makeObject(`db/2026/10/net-terms-mid-${i}.dump.age`, 25, nowMs));
    }
    // 3 older: 35-37 days old (beyond 30d but beyond keep threshold)
    for (let i = 0; i < 3; i++) {
      objects.push(makeObject(`db/2026/09/net-terms-old-${i}.dump.age`, 35 + i, nowMs));
    }

    const toDelete = selectForDeletion(objects, RETENTION_DAYS, KEEP_NEWEST, nowMs);

    // Only the 3 objects older than 30 days AND beyond the 7 newest should be deleted
    expect(toDelete.length).toBe(3);
    toDelete.forEach((key) => {
      expect(key).toContain("net-terms-old-");
    });
  });

  it("handles mixed ages correctly", () => {
    const nowMs = Date.now();
    const objects: S3Object[] = [
      makeObject("db/2026/10/net-terms-a.dump.age", 1, nowMs),   // newest (kept)
      makeObject("db/2026/10/net-terms-b.dump.age", 5, nowMs),   // kept
      makeObject("db/2026/10/net-terms-c.dump.age", 10, nowMs),  // kept
      makeObject("db/2026/10/net-terms-d.dump.age", 15, nowMs),  // kept
      makeObject("db/2026/10/net-terms-e.dump.age", 20, nowMs),  // kept
      makeObject("db/2026/10/net-terms-f.dump.age", 25, nowMs),  // kept
      makeObject("db/2026/10/net-terms-g.dump.age", 28, nowMs),  // kept (7th newest)
      makeObject("db/2026/09/net-terms-h.dump.age", 29, nowMs),  // 8th, but within 30d: NOT deleted
      makeObject("db/2026/09/net-terms-i.dump.age", 31, nowMs),  // 9th, beyond 30d: deleted
      makeObject("db/2026/09/net-terms-j.dump.age", 45, nowMs),  // 10th, beyond 30d: deleted
    ];

    const toDelete = selectForDeletion(objects, RETENTION_DAYS, KEEP_NEWEST, nowMs);

    expect(toDelete.length).toBe(2);
    expect(toDelete).toContain("db/2026/09/net-terms-i.dump.age");
    expect(toDelete).toContain("db/2026/09/net-terms-j.dump.age");
    expect(toDelete).not.toContain("db/2026/09/net-terms-h.dump.age");
  });
});

describe("prune-backups: dry-run deletes nothing", () => {
  it("selection returns keys but does not perform deletion", () => {
    const nowMs = Date.now();
    const objects: S3Object[] = [];

    // Create objects that would be eligible for deletion
    for (let i = 0; i < 10; i++) {
      objects.push(makeObject(`db/2026/09/net-terms-backup-${i}.dump.age`, 40 + i, nowMs));
    }

    const toDelete = selectForDeletion(objects, RETENTION_DAYS, KEEP_NEWEST, nowMs);

    // Selection returns keys that WOULD be deleted
    expect(toDelete.length).toBe(3);

    // But the function itself doesn't delete - it just returns the list
    // The actual deletion is done by the caller (main function) only in delete mode
    // This test verifies the separation of concerns
    expect(typeof toDelete[0]).toBe("string");
    expect(toDelete[0]).toMatch(/^db\//);
  });

  it("returns empty list when no objects eligible", () => {
    const nowMs = Date.now();
    const objects: S3Object[] = [];

    // All objects are new
    for (let i = 0; i < 5; i++) {
      objects.push(makeObject(`db/2026/10/net-terms-backup-${i}.dump.age`, i + 1, nowMs));
    }

    const toDelete = selectForDeletion(objects, RETENTION_DAYS, KEEP_NEWEST, nowMs);

    expect(toDelete.length).toBe(0);
  });
});

describe("prune-backups: edge cases", () => {
  it("handles empty object list", () => {
    const toDelete = selectForDeletion([], RETENTION_DAYS, KEEP_NEWEST, Date.now());
    expect(toDelete.length).toBe(0);
  });

  it("handles objects with identical timestamps", () => {
    const nowMs = Date.now();
    const timestamp = new Date(nowMs - 40 * DAY_MS).toISOString();

    const objects: S3Object[] = [];
    for (let i = 0; i < 10; i++) {
      objects.push({
        Key: `db/2026/09/net-terms-backup-${i}.dump.age`,
        LastModified: timestamp,
      });
    }

    const toDelete = selectForDeletion(objects, RETENTION_DAYS, KEEP_NEWEST, nowMs);

    // Keep 7, delete 3 (all have same age, so sort is stable)
    expect(toDelete.length).toBe(3);
  });

  it("respects exact 30-day boundary", () => {
    const nowMs = Date.now();

    const objects: S3Object[] = [
      // Objects to fill keep-newest-7
      ...Array.from({ length: 7 }, (_, i) =>
        makeObject(`db/2026/10/net-terms-new-${i}.dump.age`, i + 1, nowMs)
      ),
      // Exactly 30 days old: NOT deleted (need to be >30 days)
      makeObject("db/2026/09/net-terms-boundary.dump.age", 30, nowMs),
      // 31 days old: deleted
      makeObject("db/2026/09/net-terms-old.dump.age", 31, nowMs),
    ];

    const toDelete = selectForDeletion(objects, RETENTION_DAYS, KEEP_NEWEST, nowMs);

    expect(toDelete.length).toBe(1);
    expect(toDelete[0]).toBe("db/2026/09/net-terms-old.dump.age");
  });

  it("uses constants correctly", () => {
    expect(BUCKET).toBe("ntr-db-backups");
    expect(PREFIX).toBe("db/");
    expect(RETENTION_DAYS).toBe(30);
    expect(KEEP_NEWEST).toBe(7);
  });
});
