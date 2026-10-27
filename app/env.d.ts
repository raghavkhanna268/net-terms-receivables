/**
 * Extend the Wrangler-generated Env interface with optional Sentry configuration.
 * These are set via `wrangler secret put` for production.
 */
declare global {
  interface Env {
    /** Sentry DSN for error reporting. Leave unset to disable Sentry. */
    SENTRY_DSN?: string;
    /** Sentry traces sample rate (0-1). Default is 0 for Workers Free CPU limits. */
    SENTRY_TRACES_SAMPLE_RATE?: string;
    /**
     * Plan selection redirect flag. Only the exact string "true" enables the redirect.
     * When enabled, merchants without an active subscription are redirected to the plan page.
     */
    PLAN_SELECTION_REDIRECT_ENABLED?: string;
  }
}

export {};
