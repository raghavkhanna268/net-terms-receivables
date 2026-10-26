/**
 * Email sender configuration check.
 *
 * Shared between onboarding-steps.server.ts and reminders.server.ts
 * to ensure they use the same logic for determining if email sending is enabled.
 * This is a leaf module with no app-specific imports.
 */

/**
 * Check if email/reminder sending is enabled.
 * Requires BOTH RESEND_API_KEY AND RESEND_FROM to be set and non-empty.
 *
 * This mirrors the check in reminders.server.ts and is used by
 * onboarding-steps.server.ts to show the step as complete only when
 * BOTH the API key and sender address are configured.
 */
export function isEmailSendingConfigured(
  env: { RESEND_API_KEY?: string; RESEND_FROM?: string } = {}
): boolean {
  const key = env.RESEND_API_KEY ?? process.env.RESEND_API_KEY;
  const from = env.RESEND_FROM ?? process.env.RESEND_FROM;
  const hasKey = typeof key === "string" && key.trim().length > 0;
  const hasFrom = typeof from === "string" && from.trim().length > 0;
  return hasKey && hasFrom;
}
