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
  if (gatedCount <= 0) {
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

  const enforcementNote = gatingEnforced
    ? null
    : "(Limits are not currently enforced.)";

  return {
    show: true,
    heading,
    bodyText,
    enforcementNote,
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
  if (!isGated) {
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

  const enforcementNote = gatingEnforced
    ? null
    : "(Limits are not currently enforced.)";

  return {
    show: true,
    heading,
    bodyText,
    enforcementNote,
  };
}
