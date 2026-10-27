/**
 * #292: Banner copy for currency not supported state.
 *
 * This is in a separate non-.server module so it can be imported
 * by route components without breaking the client bundle.
 * (React Router strips .server imports from client builds.)
 *
 * Admin path source: https://help.shopify.com/en/manual/intro-to-shopify/initial-setup/setup-business-settings
 * Section: "Select a store currency" → Settings > General > Store defaults > Change store currency
 * Note: "store owner only" per Team Lead/Listing Builder Help Center check, not from that page.
 */
import { APP_NAME, SUPPORT_EMAIL_MAILTO } from "./constants";

export const CURRENCY_NOT_SUPPORTED_BANNER_COPY =
  `${APP_NAME} is built for Indian merchants and currently supports INR only. ` +
  "To use it, the store owner must change the store currency to Indian Rupee (INR) in " +
  "Shopify admin → Settings → General → Store defaults → Currency display → ⋯ → Change store currency, " +
  "then reopen the app. To start syncing your data, open the Setup Guide and click Start sync. " +
  "If your store already has orders, Shopify asks you to confirm the change.";

/**
 * #292: Banner copy for currency flip blocked due to existing financial data.
 *
 * Shown when a shop with non-INR historical data (Invoice, Payment, or DraftOrder rows)
 * switches to INR in Shopify. The flip is blocked to prevent relabeling existing
 * USD/EUR/etc. amounts as rupees.
 *
 * The banner text portion without the support link (link rendered separately).
 */
export const CURRENCY_FLIP_BLOCKED_BANNER_TEXT =
  `This store has existing receivables data from when it used a different currency. ` +
  `${APP_NAME} cannot convert this data to INR, so the app is unavailable for this store.`;

/**
 * Re-exported mailto link for banner rendering.
 */
export { SUPPORT_EMAIL_MAILTO };

/**
 * @deprecated Use CURRENCY_FLIP_BLOCKED_BANNER_TEXT and render support link separately.
 * Kept for backward compatibility with existing tests.
 */
export const CURRENCY_FLIP_BLOCKED_BANNER_COPY =
  `${CURRENCY_FLIP_BLOCKED_BANNER_TEXT} Please contact support for assistance.`;
