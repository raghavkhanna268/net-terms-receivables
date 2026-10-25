# Launch Checklist

These are the gates to clear before Shopify App Store submission or the first real merchant install, whichever comes first. Step-by-step guides for some items live in [docs/launch-checklist/](./launch-checklist/README.md); day-to-day procedures are in the [Operations Runbook](./ops.md).

## Gates

- [ ] **Cloudflare Workers Paid plan** — Owner: Raghav (paid upgrade), then DevOps. Upgrade from the Free plan, which has a 10 ms CPU limit per request; DevOps re-checks CPU usage afterwards.
- [ ] **Shopify protected customer data (PCD) review** — Owner: Raghav (Partner Dashboard). Request the PCD review as part of App Store submission.
- [ ] **`SENTRY_DSN`** — Owner: Raghav, then DevOps. Raghav creates the Sentry project and provides the DSN through a secure secret request, and DevOps stores it as a Worker/Actions secret.
- [ ] **Uninstall/reinstall test** — Owner: Raghav with QA. Run the uninstall/reinstall test, including the `shop/redact` cascade, on a separate throwaway dev store and never on the main dev store, because it destroys data.
- [ ] **Resend transactional email** — Owner: Raghav, then DevOps. Raghav sets up the Resend account, a verified sending domain and an API key, and DevOps sets the secret.
- [ ] **`read_all_orders` scope** — Owner: Raghav. Submit the `read_all_orders` access request in the Partner Dashboard.
- [ ] **Old Seoul Supabase project and old Hyperdrive config** — Owner: Raghav (approval), then DevOps. Delete both only after Raghav gives his explicit OK.
- [ ] **`PLAN_GATING_ENFORCED` stays `"false"`** — Owner: Raghav (decision), then DevOps. It stays `"false"` in every environment until Raghav finalizes pricing and the Shopify plans are created, and DevOps flips it only on Raghav's go.
