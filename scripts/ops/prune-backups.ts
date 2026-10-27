/**
 * Prune old database backups from R2 with 30-day rolling retention.
 *
 * Safety invariants (all fail closed: when in doubt, nothing is deleted):
 * - ONLY operates on bucket `ntr-db-backups`, prefix `db/`
 * - Strict prefix guard: exits non-zero if any listed key doesn't start with `db/`
 * - Listing guard: exits non-zero if the listing fails, is truncated, or has
 *   any entry without a string Key and a parseable LastModified
 * - Always keeps the newest 7 backups regardless of age, and re-checks the
 *   deletion plan independently of the selection (checkDeletionPlan) right
 *   before any delete call
 * - Deletes only objects older than 30 days
 * - Refuses any deletion when fewer than 7 objects are listed
 * - Sanity floor: refuses to delete if total < 8, if eligible would leave < 7,
 *   or if newest backup > 48h old (signals stalled backup job)
 * - Unknown PRUNE_MODE values exit non-zero; an unset PRUNE_MODE is dry_run.
 *   The workflow passes `delete` only for scheduled runs and for a manual
 *   dispatch with an explicit dry_run=false; otherwise `dry_run`.
 * - Output is counts only, never keys or sizes
 * - Stops at the first failed delete and exits non-zero (deleted < eligible)
 *
 * Usage:
 *   node --experimental-strip-types scripts/ops/prune-backups.ts
 *
 * Environment:
 *   R2_BUCKET, R2_ENDPOINT, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 *   PRUNE_MODE: 'dry_run' (default) or 'delete'
 */

import { spawnSync } from "child_process";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration (constants, never modified at runtime)
// ─────────────────────────────────────────────────────────────────────────────

export const BUCKET = "ntr-db-backups";
export const PREFIX = "db/";
export const RETENTION_DAYS = 30;
export const KEEP_NEWEST = 7;
export const MIN_TOTAL_FOR_DELETE = 8;
export const MAX_NEWEST_AGE_HOURS = 48;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type PruneMode = "dry_run" | "delete";

export interface S3Object {
  Key: string;
  LastModified: string;
}

export interface PruneResult {
  totalCount: number;
  eligibleCount: number;
  keptCount: number;
  deletedCount: number;
  newestAgeHours: number;
}

export interface SanityCheckResult {
  ok: boolean;
  reason?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Selection logic (exported for testing)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves PRUNE_MODE. Unset/empty -> dry_run (the safe default when the
 * script runs outside the workflow). Any value other than dry_run/delete is
 * rejected (null) so a typo can never be mistaken for either mode.
 */
export function resolvePruneMode(raw: string | undefined): PruneMode | null {
  if (raw === undefined || raw === "") {
    return "dry_run";
  }
  if (raw === "dry_run" || raw === "delete") {
    return raw;
  }
  return null;
}

/**
 * Validates the shape of a listing: every entry needs a string Key and a
 * parseable LastModified. Unparseable dates would break newest-first ordering
 * and therefore keep-newest-7, so they fail the whole run.
 */
export function validateListing(objects: unknown): objects is S3Object[] {
  if (!Array.isArray(objects)) {
    return false;
  }
  for (const obj of objects) {
    if (obj === null || typeof obj !== "object") {
      return false;
    }
    const { Key, LastModified } = obj as Record<string, unknown>;
    if (typeof Key !== "string" || Key.length === 0) {
      return false;
    }
    if (typeof LastModified !== "string" || Number.isNaN(new Date(LastModified).getTime())) {
      return false;
    }
  }
  return true;
}

/**
 * Validates that all objects have keys starting with the required prefix.
 * Returns true if all objects are valid, false otherwise.
 */
export function validatePrefix(objects: S3Object[], expectedPrefix: string): boolean {
  for (const obj of objects) {
    if (!obj.Key.startsWith(expectedPrefix)) {
      return false;
    }
  }
  return true;
}

/**
 * Validates that the bucket name matches the expected constant.
 */
export function validateBucket(bucket: string, expected: string): boolean {
  return bucket === expected;
}

/**
 * Calculates the age of the newest object in hours.
 * Returns 0 if no objects exist.
 */
export function getNewestAgeHours(objects: S3Object[], nowMs: number): number {
  if (objects.length === 0) {
    return 0;
  }

  let newestMs = 0;
  for (const obj of objects) {
    const objMs = new Date(obj.LastModified).getTime();
    if (objMs > newestMs) {
      newestMs = objMs;
    }
  }

  const ageMs = nowMs - newestMs;
  return Math.floor(ageMs / (60 * 60 * 1000));
}

/**
 * The sanity floor protects deletions. When nothing is eligible, delete mode
 * is a no-op and must succeed (exit 0, deleted=0) even while the bucket holds
 * fewer than MIN_TOTAL_FOR_DELETE backups, so scheduled delete-mode runs stay
 * green during the first days of retention. Keep-newest-7 is still enforced
 * by selectForDeletion, and the floor still runs whenever eligible > 0.
 */
export function requiresSanityFloor(eligibleCount: number): boolean {
  return eligibleCount > 0;
}

/**
 * Sanity floor check before allowing deletions.
 * Prevents destructive operations when the backup state looks unhealthy.
 */
export function checkSanityFloor(
  totalCount: number,
  eligibleCount: number,
  newestAgeHours: number,
  minTotal: number,
  keepNewest: number,
  maxNewestAgeHours: number
): SanityCheckResult {
  // Refuse if total objects < minimum threshold
  if (totalCount < minTotal) {
    return {
      ok: false,
      reason: "total_below_minimum total=" + totalCount + " min=" + minTotal,
    };
  }

  // Refuse if eligible would leave fewer than keep-newest threshold
  const afterDelete = totalCount - eligibleCount;
  if (afterDelete < keepNewest) {
    return {
      ok: false,
      reason: "would_leave_below_keep_newest after=" + afterDelete + " min=" + keepNewest,
    };
  }

  // Refuse if newest backup is too old (signals stalled backup job)
  if (newestAgeHours > maxNewestAgeHours) {
    return {
      ok: false,
      reason: "newest_too_old age_hours=" + newestAgeHours + " max=" + maxNewestAgeHours,
    };
  }

  return { ok: true };
}

/**
 * Determines which objects are eligible for deletion based on:
 * 1. Age: object must be older than retentionDays
 * 2. Keep-newest: always keep the newest keepNewest objects
 *
 * Returns a list of keys eligible for deletion.
 */
export function selectForDeletion(
  objects: S3Object[],
  retentionDays: number,
  keepNewest: number,
  nowMs: number
): string[] {
  if (objects.length === 0) {
    return [];
  }

  // Sort by LastModified descending (newest first)
  const sorted = [...objects].sort((a, b) => {
    const dateA = new Date(a.LastModified).getTime();
    const dateB = new Date(b.LastModified).getTime();
    return dateB - dateA;
  });

  // Calculate the cutoff timestamp (30 days ago)
  const cutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;

  // Determine which objects are eligible for deletion:
  // - Must be beyond the keep-newest threshold
  // - Must be older than the retention period
  const eligible: string[] = [];

  for (let i = 0; i < sorted.length; i++) {
    // Always keep the newest N objects
    if (i < keepNewest) {
      continue;
    }

    const obj = sorted[i];
    const objMs = new Date(obj.LastModified).getTime();

    // Only delete if older than retention period
    if (objMs < cutoffMs) {
      eligible.push(obj.Key);
    }
  }

  return eligible;
}

/**
 * Independent re-check of a deletion plan, run right before any delete call.
 * It does not trust selectForDeletion: it recomputes the newest keepNewest
 * keys itself and refuses the plan if
 * - fewer than keepNewest objects are listed and anything would be deleted,
 * - the plan would leave fewer than keepNewest objects,
 * - any planned key is one of the newest keepNewest (even if it is old),
 * - any planned key is outside the prefix, not in the listing, duplicated,
 * - any planned key is not older than the retention cutoff.
 */
export function checkDeletionPlan(
  objects: S3Object[],
  toDelete: string[],
  prefix: string,
  retentionDays: number,
  keepNewest: number,
  nowMs: number
): SanityCheckResult {
  if (toDelete.length === 0) {
    return { ok: true };
  }
  if (objects.length < keepNewest) {
    return { ok: false, reason: "total_below_keep_newest total=" + objects.length + " min=" + keepNewest };
  }
  if (objects.length - toDelete.length < keepNewest) {
    return {
      ok: false,
      reason: "plan_leaves_below_keep_newest after=" + (objects.length - toDelete.length) + " min=" + keepNewest,
    };
  }

  const byKey = new Map<string, number>();
  for (const obj of objects) {
    byKey.set(obj.Key, new Date(obj.LastModified).getTime());
  }
  const newest = new Set(
    [...objects]
      .sort((a, b) => new Date(b.LastModified).getTime() - new Date(a.LastModified).getTime())
      .slice(0, keepNewest)
      .map((o) => o.Key)
  );
  const cutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const seen = new Set<string>();

  for (const key of toDelete) {
    if (!key.startsWith(prefix)) {
      return { ok: false, reason: "plan_prefix_violation" };
    }
    if (seen.has(key)) {
      return { ok: false, reason: "plan_duplicate_key" };
    }
    seen.add(key);
    const ms = byKey.get(key);
    if (ms === undefined) {
      return { ok: false, reason: "plan_key_not_listed" };
    }
    if (newest.has(key)) {
      return { ok: false, reason: "plan_hits_keep_newest" };
    }
    if (!(ms < cutoffMs)) {
      return { ok: false, reason: "plan_not_past_retention" };
    }
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// AWS CLI wrapper
// ─────────────────────────────────────────────────────────────────────────────

function runAwsCommand(args: string[], endpoint: string): { success: boolean; stdout: string } {
  const result = spawnSync(
    "aws",
    [...args, "--endpoint-url", endpoint],
    {
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        AWS_DEFAULT_REGION: "auto",
        AWS_REQUEST_CHECKSUM_CALCULATION: "when_required",
        AWS_RESPONSE_CHECKSUM_VALIDATION: "when_required",
        AWS_PAGER: "",
      },
    }
  );

  return {
    success: result.status === 0,
    stdout: result.stdout ?? "",
  };
}

function listObjects(bucket: string, prefix: string, endpoint: string): unknown[] | null {
  const result = runAwsCommand(
    ["s3api", "list-objects-v2", "--bucket", bucket, "--prefix", prefix, "--output", "json"],
    endpoint
  );

  if (!result.success) {
    return null;
  }

  try {
    const data = JSON.parse(result.stdout);
    if (data === null || typeof data !== "object") {
      return null;
    }
    // The CLI auto-paginates; a leftover token means the listing is partial.
    if (data.NextToken || data.IsTruncated === true) {
      return null;
    }
    const contents = data.Contents ?? [];
    return Array.isArray(contents) ? contents : null;
  } catch {
    return null;
  }
}

function deleteObject(bucket: string, key: string, endpoint: string): boolean {
  const result = runAwsCommand(
    ["s3api", "delete-object", "--bucket", bucket, "--key", key],
    endpoint
  );
  return result.success;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

export async function main(): Promise<number> {
  // Read mode from environment (set by workflow); unset -> dry_run, unknown -> refuse
  const pruneMode = resolvePruneMode(process.env.PRUNE_MODE);
  if (pruneMode === null) {
    console.log("prune_error=true reason=invalid_mode");
    return 1;
  }
  const deleteMode = pruneMode === "delete";

  // Check required environment variables
  const bucket = process.env.R2_BUCKET;
  const endpoint = process.env.R2_ENDPOINT;

  if (!bucket || !endpoint) {
    console.log("prune_error=true reason=missing_env");
    return 1;
  }

  // Strict bucket validation
  if (!validateBucket(bucket, BUCKET)) {
    console.log("prune_error=true reason=bucket_mismatch expected=" + BUCKET);
    return 1;
  }

  // List objects in the prefix
  const listed = listObjects(bucket, PREFIX, endpoint);

  if (listed === null) {
    console.log("prune_error=true reason=list_failed");
    return 1;
  }

  // Listing shape guard (Key + parseable LastModified on every entry)
  if (!validateListing(listed)) {
    console.log("prune_error=true reason=invalid_listing");
    return 1;
  }
  const objects: S3Object[] = listed;

  // Strict prefix validation
  if (!validatePrefix(objects, PREFIX)) {
    console.log("prune_error=true reason=prefix_guard_failed");
    return 1;
  }

  // Calculate which objects to delete
  const nowMs = Date.now();
  const toDelete = selectForDeletion(objects, RETENTION_DAYS, KEEP_NEWEST, nowMs);
  const newestAgeHours = getNewestAgeHours(objects, nowMs);

  const result: PruneResult = {
    totalCount: objects.length,
    eligibleCount: toDelete.length,
    keptCount: objects.length - toDelete.length,
    deletedCount: 0,
    newestAgeHours,
  };

  if (deleteMode) {
    // Fewer than KEEP_NEWEST listed: refuse to delete anything (no-op, exit 0
    // so the nightly stays green while the bucket fills up).
    if (result.totalCount < KEEP_NEWEST) {
      console.log(
        "prune_mode=delete" +
          " prune_refused=true" +
          " reason=total_below_keep_newest" +
          " total=" + result.totalCount +
          " eligible=" + result.eligibleCount +
          " deleted=0" +
          " newest_age_hours=" + result.newestAgeHours
      );
      return 0;
    }

    // Sanity floor check before deletion (skipped only when nothing is eligible)
    const sanity = !requiresSanityFloor(result.eligibleCount)
      ? { ok: true as const }
      : checkSanityFloor(
      result.totalCount,
      result.eligibleCount,
      result.newestAgeHours,
      MIN_TOTAL_FOR_DELETE,
      KEEP_NEWEST,
      MAX_NEWEST_AGE_HOURS
    );

    if (!sanity.ok) {
      console.log(
        "prune_mode=delete" +
          " prune_blocked=true" +
          " reason=" + sanity.reason +
          " total=" + result.totalCount +
          " eligible=" + result.eligibleCount +
          " newest_age_hours=" + result.newestAgeHours
      );
      return 1;
    }

    // Independent re-check of the plan (keep-newest-7, prefix, age)
    const plan = checkDeletionPlan(objects, toDelete, PREFIX, RETENTION_DAYS, KEEP_NEWEST, nowMs);
    if (!plan.ok) {
      console.log(
        "prune_mode=delete" +
          " prune_blocked=true" +
          " reason=" + plan.reason +
          " total=" + result.totalCount +
          " eligible=" + result.eligibleCount
      );
      return 1;
    }

    // Delete eligible objects; stop at the first failure (fail closed)
    for (const key of toDelete) {
      if (!deleteObject(bucket, key, endpoint)) {
        break;
      }
      result.deletedCount++;
    }

    // Structured output: counts only (no keys, sizes, or shop data)
    console.log(
      "prune_mode=delete" +
        " total=" + result.totalCount +
        " eligible=" + result.eligibleCount +
        " kept=" + result.keptCount +
        " deleted=" + result.deletedCount +
        " newest_age_hours=" + result.newestAgeHours
    );

    // Exit non-zero if some deletions failed
    if (result.deletedCount < result.eligibleCount) {
      console.log("prune_error=true reason=partial_delete_failure");
      return 1;
    }
  } else {
    // Dry-run: print counts only
    console.log(
      "prune_mode=dry_run" +
        " total=" + result.totalCount +
        " eligible=" + result.eligibleCount +
        " kept=" + result.keptCount +
        " newest_age_hours=" + result.newestAgeHours
    );
  }

  return 0;
}

// Only run main if this is the entry point
const isMain = process.argv[1]?.endsWith("prune-backups.ts") ||
  process.argv[1]?.endsWith("prune-backups");

if (isMain) {
  main().then((code) => process.exit(code));
}
