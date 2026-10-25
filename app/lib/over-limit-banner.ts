/**
 * Over-limit banner helper for S21 plan gating UI.
 *
 * Provides consistent logic for rendering the over-limit banner
 * across plan page, app home, and account detail pages.
 */

export interface OverLimitBannerState {
  show: boolean;
  heading: string;
  bodyText: string;
  enforcementNote: string | null;
}

/**
 * Build the over-limit banner state for the plan page and app home.
 *
 * @param gatedCount - Number of accounts over the plan limit
 * @param gatingEnforced - Whether plan gating is currently enforced
 * @returns Banner state with heading, body text, and enforcement note
 */
export function buildOverLimitBannerState(
  gatedCount: number,
  gatingEnforced: boolean
): OverLimitBannerState {
  // Don't show over-limit banner when gating is not enforced
  if (gatedCount <= 0 || !gatingEnforced) {
    return {
      show: false,
      heading: "",
      bodyText: "",
      enforcementNote: null,
    };
  }

  const plural = gatedCount !== 1;
  const heading = `${gatedCount} account${plural ? "s" : ""} over your plan limit`;

  const bodyText =
    "Nothing is hidden and totals include all accounts. Only these actions " +
    "are limited: reminders, credit-limit edits, account-detail edits and " +
    "bulk statement import. Matching, confirming a match and mark-paid are " +
    "never gated. Credit holds and the checkout block work on every plan.";

  return {
    show: true,
    heading,
    bodyText,
    enforcementNote: null,
  };
}

/**
 * Build the over-limit banner state for the account detail page.
 *
 * @param isGated - Whether this account is over the plan limit
 * @param gatingEnforced - Whether plan gating is currently enforced
 * @returns Banner state with heading, body text, and enforcement note
 */
export function buildAccountOverLimitBannerState(
  isGated: boolean,
  gatingEnforced: boolean
): OverLimitBannerState {
  // Don't show over-limit banner when gating is not enforced
  if (!isGated || !gatingEnforced) {
    return {
      show: false,
      heading: "",
      bodyText: "",
      enforcementNote: null,
    };
  }

  const heading = "This account is over your plan limit";

  const bodyText =
    "Nothing is hidden. Only these actions are limited: reminders, credit-limit " +
    "edits, account-detail edits and bulk statement import. Matching, confirming " +
    "a match and mark-paid are never gated. Credit holds and the checkout block " +
    "work on every plan.";

  return {
    show: true,
    heading,
    bodyText,
    enforcementNote: null,
  };
}

/**
 * Banner state for "new accounts paused" condition.
 */
export interface NewAccountsPausedBannerState {
  show: boolean;
  heading: string;
  bodyText: string;
}

/**
 * Build the banner state for the "new accounts paused" condition.
 * Shows on Dashboard, Accounts list, Plan page, and Tag rules page.
 *
 * Displayed when gating is enforced and the shop has reached its plan limit.
 *
 * @param usedCount - Number of active (non-gated) buyer accounts
 * @param limitCount - Plan limit for buyer accounts (-1 means unlimited)
 * @param gatingEnforced - Whether plan gating is currently enforced
 * @returns Banner state with heading and body text
 */
export function buildNewAccountsPausedBannerState(
  usedCount: number,
  limitCount: number,
  gatingEnforced: boolean
): NewAccountsPausedBannerState {
  // Don't show when gating is not enforced or unlimited plan
  if (!gatingEnforced || limitCount === -1) {
    return {
      show: false,
      heading: "",
      bodyText: "",
    };
  }

  // Only show when at or over limit
  if (usedCount < limitCount) {
    return {
      show: false,
      heading: "",
      bodyText: "",
    };
  }

  const heading = `${usedCount} of ${limitCount} buyer accounts`;
  const bodyText =
    "New accounts can't be added or imported over your plan limit.";

  return {
    show: true,
    heading,
    bodyText,
  };
}
