/**
 * Store setup state banner component.
 *
 * Shows a "Setting up your store..." state when the Shop row is missing
 * or the currency is still the placeholder 'XXX'.
 */

/**
 * Banner shown when the store is still being set up.
 * Used on routes that gate on currency support.
 */
export function StoreSettingUpBanner() {
  return (
    <s-banner tone="info" heading="Setting up your store">
      <s-text>
        We&apos;re finishing setting up your store. Please wait a moment and
        reopen the app.
      </s-text>
    </s-banner>
  );
}
