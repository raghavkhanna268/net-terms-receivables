/**
 * Queue drain endpoint for S10.
 *
 * POST /jobs/drain
 *
 * Authenticated by Bearer token compared in constant time against
 * env.JOBS_DRAIN_SECRET. Called by:
 * - Workers Cron (scheduled handler)
 * - pg_cron + pg_net job (every minute)
 *
 * Reads messages from s6_sync and s6_bulk queues, processes them
 * via registered topic handlers, and handles retry/DLQ.
 */

import type { ActionFunctionArgs } from "react-router";
import { getRequestSql } from "~/lib/request-context.server";
import { runDrain, type DrainConfig } from "~/services/drain/processor.server";
import { enqueueReconcileForAllShops } from "~/services/drain/reconcile.server";
import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison to prevent timing attacks.
 *
 * Returns false if lengths differ (unavoidable timing leak, but
 * attacker still can't determine the secret value).
 */
function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  return timingSafeEqual(bufA, bufB);
}

/**
 * Validate the Authorization header.
 *
 * Expected format: "Bearer <secret>"
 * Returns the token if valid format, null otherwise.
 */
function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) {
    return null;
  }
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return null;
  }
  return parts[1];
}

/**
 * Parsed options from query parameters.
 */
interface ParsedOptions {
  config: Partial<DrainConfig>;
  reconcile: boolean;
}

/**
 * Parse drain configuration and options from query parameters.
 */
function parseOptions(url: URL): ParsedOptions {
  const config: Partial<DrainConfig> = {};

  const batchSize = url.searchParams.get("batchSize");
  if (batchSize) {
    const parsed = parseInt(batchSize, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
      config.batchSize = parsed;
    }
  }

  const timeBudgetMs = url.searchParams.get("timeBudgetMs");
  if (timeBudgetMs) {
    const parsed = parseInt(timeBudgetMs, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 60000) {
      config.timeBudgetMs = parsed;
    }
  }

  const reconcile = url.searchParams.get("reconcile") === "true";

  return { config, reconcile };
}

export async function action({ request, context }: ActionFunctionArgs) {
  // Only allow POST
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Get the secret from environment
  const env = (context as { cloudflare: { env: { JOBS_DRAIN_SECRET?: string } } }).cloudflare.env;
  const expectedSecret = env.JOBS_DRAIN_SECRET;

  // If secret is not configured, reject all requests
  if (!expectedSecret) {
    console.error("[drain] JOBS_DRAIN_SECRET not configured");
    return new Response("Unauthorized", { status: 401 });
  }

  // Extract and validate Bearer token
  const authHeader = request.headers.get("Authorization");
  const token = extractBearerToken(authHeader);

  if (!token) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Constant-time comparison
  if (!constantTimeCompare(token, expectedSecret)) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Parse optional configuration from query params
  const url = new URL(request.url);
  const { config, reconcile } = parseOptions(url);

  // Run the drain
  const sql = getRequestSql();

  try {
    // If reconcile mode, enqueue reconcile messages for all shops first
    let reconcileCount = 0;
    if (reconcile) {
      reconcileCount = await enqueueReconcileForAllShops(sql);
      console.log(`[drain] reconcile mode: enqueued ${reconcileCount} messages`);
    }

    const result = await runDrain(sql, config);

    // Log summary (avoid PII - just stats)
    console.log(
      `[drain] processed=${result.processed} skipped=${result.skipped} ` +
        `failed=${result.failed} dlq=${result.deadLettered} ` +
        `timedOut=${result.timedOut} elapsed=${result.elapsedMs}ms`
    );

    // Return result as JSON
    return new Response(
      JSON.stringify({
        ...result,
        reconcileEnqueued: reconcileCount,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("[drain] error:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Internal error",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

// Reject GET requests
export async function loader() {
  return new Response("Method Not Allowed", { status: 405 });
}
