import {
  withSentry as sentryWithSentry,
  captureException as sentryCaptureException,
  captureMessage as sentryCaptureMessage,
  type SeverityLevel,
} from "@sentry/cloudflare";
import type { DataCollection } from "@sentry/core";
import { toErrorCode } from "./log.server";
import {
  RESTRICTIVE_DATA_COLLECTION,
  beforeSend,
  beforeSendTransaction,
  beforeBreadcrumb,
} from "./sentry-scrub";

export { RESTRICTIVE_DATA_COLLECTION } from "./sentry-scrub";

/**
 * Environment variables for Sentry configuration.
 * These are optional - Sentry is a no-op when DSN is not set.
 */
export interface SentryEnv {
  SENTRY_DSN?: string;
  SENTRY_TRACES_SAMPLE_RATE?: string;
  SENTRY_RELEASE?: string;
  SENTRY_ENVIRONMENT?: string;
}

/**
 * Options returned by buildSentryOptions for Sentry SDK initialization.
 */
export interface SentryOptions {
  dsn: string;
  release?: string;
  environment: string;
  tracesSampleRate: number;
  dataCollection: DataCollection;
  enhanceFetchErrorMessages: false;
  beforeSend: typeof beforeSend;
  beforeSendTransaction: typeof beforeSendTransaction;
  beforeBreadcrumb: typeof beforeBreadcrumb;
}

/**
 * Build Sentry SDK options from environment variables.
 * Returns undefined if DSN is not set (no-op mode).
 *
 * This is exported for leak testing to ensure tests use the exact same
 * configuration as production. Use it in tests with a fake DSN.
 *
 * @param env - Environment variables containing SENTRY_* config
 * @returns Sentry options or undefined if no DSN
 */
export function buildSentryOptions<E extends SentryEnv>(env: E): SentryOptions | undefined {
  const dsn = env.SENTRY_DSN;
  if (!dsn) {
    return undefined;
  }
  return {
    dsn,
    release: env.SENTRY_RELEASE || undefined,
    environment: env.SENTRY_ENVIRONMENT || "development",
    tracesSampleRate: parseFloat(env.SENTRY_TRACES_SAMPLE_RATE ?? "0"),
    dataCollection: RESTRICTIVE_DATA_COLLECTION,
    enhanceFetchErrorMessages: false,
    beforeSend,
    beforeSendTransaction,
    beforeBreadcrumb,
  };
}

/**
 * Wrap a Cloudflare Workers handler with Sentry error monitoring.
 *
 * This is a no-op when SENTRY_DSN is not set, allowing local dev and CI
 * to run without Sentry credentials.
 *
 * Usage in workers/app.ts:
 *
 *   import { wrapWithSentry } from "~/lib/sentry";
 *
 *   const handler = { async fetch(request, env, ctx) { ... } };
 *   export default wrapWithSentry(handler);
 *
 * Mind Cloudflare Workers Free limits:
 * - 10ms CPU time per request
 * - 3MB compressed bundle size
 *
 * We disable tracing by default (tracesSampleRate: 0) to minimize CPU overhead.
 * Set SENTRY_TRACES_SAMPLE_RATE env var to enable (e.g., 0.1 for 10%).
 */
export function wrapWithSentry<E extends SentryEnv>(
  handler: ExportedHandler<E>
): ExportedHandler<E> {
  return sentryWithSentry(
    (env: E) => buildSentryOptions(env),
    handler
  );
}

/**
 * Manually capture an exception in Sentry.
 * No-op if Sentry is not initialized (no DSN).
 */
export function captureException(error: unknown): void {
  sentryCaptureException(error);
}

/**
 * Tags for exception context.
 */
export interface ExceptionTags {
  shopId?: string;
  code?: string;
}

/**
 * Capture an exception with safe tags (shopId and error code only).
 *
 * Use this instead of raw captureException when you have context.
 * The error is mapped through toErrorCode to avoid raw messages.
 *
 * @param error - The error to capture
 * @param tags - Safe tags (shopId and code only)
 */
export function captureExceptionWithTags(
  error: unknown,
  tags: ExceptionTags
): void {
  const code = tags.code ?? toErrorCode(error);

  sentryCaptureException(error, {
    tags: {
      ...(tags.shopId && { shopId: tags.shopId }),
      code,
    },
  });
}

/**
 * Manually capture a message in Sentry.
 * No-op if Sentry is not initialized (no DSN).
 */
export function captureMessage(message: string, level?: SeverityLevel): void {
  sentryCaptureMessage(message, level);
}
