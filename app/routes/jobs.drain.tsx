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
 *
 * NOTE: The ?reconcile=true path is disabled until S10b reconcile handlers exist.
 */

import type { ActionFunctionArgs } from "react-router";
import { getRequestSql } from "~/lib/request-context.server";
import { runDrain, type DrainConfig } from "~/services/drain/processor.server";

/**
 * Constant-time comparison using byte lengths (Web Crypto style).
 *
 * XORs all bytes and checks for any mismatch bit, consistent with
 * the pattern in webhook-verify.server.ts. Returns false immediately
 * only if byte lengths differ (unavoidable timing leak, but attacker
 * can't determine the secret value).
 */
function constantTimeCompare(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);

  // Byte length check (unavoidable timing difference)
  if (bufA.length !== bufB.length) {
    return false;
  }

  // XOR all bytes, accumulating any mismatch bits
  let mismatch = 0;
  for (let i = 0; i < bufA.length; i++) {
    mismatch |= bufA[i] ^ bufB[i];
  }
  return mismatch === 0;
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
 * Parse drain configuration from query parameters.
 */
function parseConfig(url: URL): Partial<DrainConfig> {
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

  return config;
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

  // Constant-time comparison using byte XOR
  if (!constantTimeCompare(token, expectedSecret)) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Parse optional configuration from query params
  const url = new URL(request.url);

  // Reconcile is disabled until S10b handlers exist
  if (url.searchParams.get("reconcile") === "true") {
    return new Response(
      JSON.stringify({
        error: "Reconcile is not implemented. Deferred to S10b.",
      }),
      {
        status: 501,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const config = parseConfig(url);

  // Run the drain
  const sql = getRequestSql();

  try {
    const result = await runDrain(sql, config);

    // Log summary (avoid PII - just stats)
    console.log(
      `[drain] processed=${result.processed} skipped=${result.skipped} ` +
        `failed=${result.failed} dlq=${result.deadLettered} noHandler=${result.noHandler} ` +
        `timedOut=${result.timedOut} elapsed=${result.elapsedMs}ms`
    );

    // Return result as JSON
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    // Log the full error details server-side
    console.error("[drain] error:", error);

    // Return generic error response (no raw error.message to client)
    return new Response(
      JSON.stringify({
        error: "Internal server error",
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
