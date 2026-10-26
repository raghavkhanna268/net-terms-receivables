/**
 * Gating flag check - tiny leaf module to avoid circular imports.
 *
 * This module has NO imports and is safe to import from anywhere.
 * Both gating.server.ts and reminders.server.ts import from here.
 */

/**
 * Check if plan gating enforcement is enabled.
 * Default is OFF (plan resolution, banner, usage work but no blocking).
 *
 * Only the exact string 'true' enables gating. '1', 'TRUE', ' true', etc. do NOT.
 */
export function isGatingEnforced(): boolean {
  const env = process.env.PLAN_GATING_ENFORCED as string | undefined;
  return env === "true";
}
