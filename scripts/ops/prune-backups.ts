#!/usr/bin/env npx tsx
/**
 * Prune old database backups from R2 with 30-day rolling retention.
 *
 * Safety invariants:
 * - ONLY operates on bucket `ntr-db-backups`, prefix `db/`
 * - Strict prefix guard: exits non-zero if any listed key doesn't start with `db/`
 * - Always keeps the newest 7 backups regardless of age
 * - Deletes only objects older than 30 days
 * - Dry-run is default: prints counts only, never prints keys or sizes
 *
 * Usage:
 *   npx tsx scripts/ops/prune-backups.ts [--delete]
 *
 * Environment:
 *   R2_BUCKET, R2_ENDPOINT, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 */

import { spawnSync } from "child_process";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration (constants, never modified at runtime)
// ─────────────────────────────────────────────────────────────────────────────

export const BUCKET = "ntr-db-backups";
export const PREFIX = "db/";
export const RETENTION_DAYS = 30;
export const KEEP_NEWEST = 7;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface S3Object {
  Key: string;
  LastModified: string;
}

export interface PruneResult {
  totalCount: number;
  eligibleCount: number;
  keptCount: number;
  deletedCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Selection logic (exported for testing)
// ─────────────────────────────────────────────────────────────────────────────

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

function listObjects(bucket: string, prefix: string, endpoint: string): S3Object[] | null {
  const result = runAwsCommand(
    ["s3api", "list-objects-v2", "--bucket", bucket, "--prefix", prefix, "--output", "json"],
    endpoint
  );

  if (!result.success) {
    return null;
  }

  try {
    const data = JSON.parse(result.stdout);
    return (data.Contents ?? []) as S3Object[];
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
  const args = process.argv.slice(2);
  const deleteMode = args.includes("--delete");

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
  const objects = listObjects(bucket, PREFIX, endpoint);

  if (objects === null) {
    console.log("prune_error=true reason=list_failed");
    return 1;
  }

  // Strict prefix validation
  if (!validatePrefix(objects, PREFIX)) {
    console.log("prune_error=true reason=prefix_guard_failed");
    return 1;
  }

  // Calculate which objects to delete
  const nowMs = Date.now();
  const toDelete = selectForDeletion(objects, RETENTION_DAYS, KEEP_NEWEST, nowMs);

  const result: PruneResult = {
    totalCount: objects.length,
    eligibleCount: toDelete.length,
    keptCount: objects.length - toDelete.length,
    deletedCount: 0,
  };

  if (deleteMode) {
    // Delete eligible objects
    for (const key of toDelete) {
      if (deleteObject(bucket, key, endpoint)) {
        result.deletedCount++;
      }
    }
    // Structured output: counts only (no keys, sizes, or shop data)
    console.log(
      "prune_mode=delete" +
        " total=" + result.totalCount +
        " eligible=" + result.eligibleCount +
        " kept=" + result.keptCount +
        " deleted=" + result.deletedCount
    );
  } else {
    // Dry-run: print counts only
    console.log(
      "prune_mode=dry_run" +
        " total=" + result.totalCount +
        " eligible=" + result.eligibleCount +
        " kept=" + result.keptCount
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
