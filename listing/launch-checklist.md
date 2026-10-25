# Launch Checklist — Net Terms Receivables

> **Status:** Pre-launch checklist for App Store review and production readiness.
> Items marked ⚠️ are blocking. Items marked **TBD** require decisions.
> These are gates before App Store submission or the first real merchant, whichever comes first.
> Step-by-step guides: [docs/launch-checklist/README.md](../docs/launch-checklist/README.md). Operations: [docs/ops.md](../docs/ops.md).

---

## Infrastructure

### Cloudflare Workers

- [ ] **⚠️ Upgrade to Cloudflare Workers Paid ($5/month)** — Before App Store review or first real merchant, whichever comes first
  - Free tier: 100k requests/day, 10 ms CPU limit
  - Paid tier: 10M requests/month, 30 seconds default CPU limit (max 5 min configurable)
  - **Why:** Production traffic may exceed free tier; paid tier provides significantly better CPU headroom
  - **Reference:** [Cloudflare Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)
  - **Owner:** Raghav (paid upgrade); DevOps redeploys after
  - **Steps:** [docs/launch-checklist/workers-paid-upgrade.md](../docs/launch-checklist/workers-paid-upgrade.md)

### Supabase

- [ ] **⚠️ Supabase Free tier pausing risk** — Free projects pause after 1 week of inactivity
  - [ ] Implement keep-alive cron job (S10 tracker item)
  - [ ] **TBD:** Consider upgrading to Supabase Pro ($25/month) for SLA and no pausing
  
- [ ] **⚠️ Configure Supabase backups**
  - Free tier: No automatic backups ([source: Supabase pricing](https://supabase.com/pricing))
  - Pro tier: Daily backups, 7-day retention
  - **Decision needed:** Upgrade to Pro for backups, or implement manual backup strategy
  - **TBD:** Test backup restoration procedure

- [ ] Verify database is in Mumbai region (ap-south-1)
  - **Current:** Confirmed in wrangler.jsonc and README

- [ ] **Delete the old Seoul Supabase project and the old Hyperdrive config that points at the Seoul project**
  - **Status:** Pending Raghav's decision; nothing is deleted without his explicit OK
  - **Owner:** Raghav (decision), then DevOps

---

## Shopify App Store Requirements

### App Listing

- [ ] **⚠️ App name and tagline finalized** — See `listing/app-store-listing.md`
- [ ] **⚠️ App description written** — Feature bullets, use cases
- [ ] **TBD** Screenshots (minimum 3)
- [ ] **TBD** Demo video (recommended)
- [ ] **TBD** App icon (square, meets Shopify requirements)
- [ ] **TBD** Support contact email

### Scopes and Permissions

Production scopes (8 total, post scope-reduction):

```
read_draft_orders,read_payment_terms,write_companies,write_customers,write_merchant_managed_fulfillment_orders,write_orders,write_payment_customizations,write_validations
```

Write scopes include read access to the same resource type. See [Access scopes](https://shopify.dev/docs/api/usage/access-scopes).

- [ ] **⚠️ Request `read_all_orders` scope (if needed)**
  - **Owner:** Raghav (Partner Dashboard). **Steps:** [docs/launch-checklist/read-all-orders-request.md](../docs/launch-checklist/read-all-orders-request.md)
  - Current: `write_orders` limited to 60-day order window for reads
  - **Justification:** Historical invoice backfill for existing merchants
  - **Decision needed:** Is 60-day window sufficient for launch?

- [ ] **⚠️ Protected Customer Data (PCD) Access Request**
  - Required for: `write_customers`, `write_orders` scopes (write grants read)
  - **Status:** Level 1 plus Name and Email fields already requested in the Partner Dashboard (see [docs/privacy.md](../docs/privacy.md), Protected Customer Data note)
  - **Owner:** Raghav (Partner Dashboard) — cite [docs/privacy.md Section 2.3](../docs/privacy.md#23-tagged-customer-data) and [Appendix A](../docs/privacy.md#appendix-a-shopify-oauth-scopes)
  - [ ] **PCD Level 1** — Customer data excluding name, address, phone, and email fields
    - [ ] File PCD access request form in Partner Dashboard
    - [ ] Justify data access requirements
  - [ ] **Protected Customer Fields (Level 2)** — Name and Email fields only (no phone, no address)
    - Request per-field access for Name and Email in Partner Dashboard
    - Phone, addresses, and other PII fields are never stored (blocked by code)
    - When `CUSTOMER_PII_FIELDS=1` is enabled, only `email` and `displayName` are persisted
  - **Reference:** [Shopify Protected Customer Data](https://shopify.dev/docs/apps/launch/protected-customer-data)

### Privacy Policy

- [ ] **⚠️ Privacy policy URL hosted and accessible**
  - Draft: `docs/privacy.md`
  - [ ] **TBD:** Host on public URL (e.g., /privacy route in app, or external URL)
  - [ ] **Raghav: fill privacy.md TBDs** (legal entity, contact email, DPO, effective date, DPA links for Cloudflare and Supabase, Sentry data region)
  - [ ] Legal review of privacy policy

### GDPR Webhooks

- [ ] **⚠️ GDPR webhooks verified with real Shopify deliveries**
  - Webhooks registered: `customers/data_request`, `customers/redact`, `shop/redact`
  - [ ] Verify `app/uninstalled` webhook works in test store
  - [ ] Verify `shop/redact` deletes all shop data (cascade)
  - [ ] Verify `customers/redact` returns 200 (no customer data stored yet)
  - [ ] Verify `customers/redact` deletes tagged customer buyer accounts
- [ ] **⚠️ Uninstall/reinstall test (including the `shop/redact` cascade)**
  - Runs only on a separate throwaway dev store, never on the main dev store, because it destroys data
  - Needs Raghav's explicit approval before it runs
  - **Owner:** Raghav (approval)

### Embedded App Requirements

- [x] App uses session tokens (no third-party cookies)
- [x] App is embedded (`embedded = true` in shopify.app.toml)
- [ ] **TBD** Verify App Bridge integration works across all routes
- [ ] **TBD** Test on mobile (responsive design)

### Performance

- [ ] **⚠️ Lighthouse/Web Vitals audit**
  - [ ] Target: LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1
  - [ ] Run Lighthouse on embedded app pages
  - **Note:** INP (Interaction to Next Paint) replaced FID as a Core Web Vital in March 2024
  - **Reference:** [Shopify App Store Requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements), [Core Web Vitals](https://web.dev/articles/vitals)

- [ ] Verify Worker CPU time stays under limits
  - Current estimates: 2-3ms per webhook (well under 10ms)
  - [ ] Test with `wrangler tail` in production

### Billing (if paid app)

- [x] **Billing mechanism is correct:** Uses Shopify Managed App Pricing (reads `currentAppInstallation.activeSubscriptions`, links to Shopify's hosted pricing page for upgrades). No custom charge flow or hardcoded prices in code.
- [ ] **TBD: Awaiting Raghav's decision** on final prices and tier limits (see `docs/plans-and-gating.md`)
- [ ] **⚠️ Create plans in Partner Dashboard** with names matching `docs/plans-and-gating.md:22-29` (free, starter, growth, scale)
- [ ] **TBD** Test billing flow in dev store after plans are created
- **Reference:** [Shopify App Pricing](https://shopify.dev/docs/apps/launch/billing)

---

## Feature Gates (must hold until conditions are met)

- [ ] **⚠️ `PLAN_GATING_ENFORCED` stays `"false"` in every environment** (`wrangler.jsonc` `[vars]` and any env sections)
  - **Until:** Raghav decides pricing and the Shopify plans are created (the `activeAccountFragment` condition was satisfied by #127)
  - **Go:** comes from Raghav via Wholesale Terms Builder
  - **Owner:** Raghav (decision), then DevOps flips it
  - **Why:** enabling it gates new over-limit accounts and skips reminders for gated accounts (holds and aging are unaffected)
  - **Check before every deploy:** the deployed value is `"false"`; if not, do not deploy and escalate

- [ ] **⚠️ Payment reminders (S18): Resend prerequisites before any shop enables reminders**
  - [ ] Resend Data Processing Agreement (DPA) accepted by Raghav (first)
  - [ ] Then `RESEND_API_KEY` set as a Worker secret (names only in tickets and logs; never paste values)
  - [ ] Then `RESEND_FROM` set as a Worker secret
  - **Owner:** Raghav (DPA, values via secure secret request), then DevOps sets the secrets
  - **Why:** without both secrets reminder sends are acked as "disabled" (safe no-op); once set, real emails go to buyers of any shop with reminders enabled, so the DPA must be in place first

---

## Error Monitoring

- [ ] **⚠️ Wire Sentry error monitoring**
  - Package installed: `@sentry/cloudflare`
  - Wrapper implemented: `app/lib/sentry.ts`
  - [ ] Create Sentry project (Raghav), DSN provided through a secure secret request
  - [ ] Set `SENTRY_DSN` secret in Cloudflare Workers (DevOps)
  - **Steps:** [docs/launch-checklist/sentry-setup.md](../docs/launch-checklist/sentry-setup.md)
  - [ ] Verify errors are captured in dev store testing

---

## Data Retention (Issue #22)

- [ ] **TBD** Define retention policy for Payment.narration/payerText
  - Contains raw bank statement data with potential PII
  - Options:
    - [ ] Retain indefinitely (document in privacy policy)
    - [ ] Purge after X days via pg_cron job
    - [ ] Redact PII but keep match-relevant tokens
  - [ ] Implement pg_cron retention job (if applicable)
  - [ ] Document retention period in privacy policy

---

## Security

- [x] HMAC-SHA256 webhook verification with constant-time comparison
- [x] TLS for all connections (Cloudflare + Supabase enforce)
- [x] OAuth 2.0 for Shopify authentication
- [x] Shop domain validation on webhooks
- [ ] **⚠️ Secrets rotation plan**
  - [ ] Document rotation procedure for SHOPIFY_API_SECRET
  - [ ] Document rotation procedure for database credentials
  - [ ] **TBD:** Schedule first rotation
- [ ] **TBD** Security audit / penetration testing

---

## Pre-Submission Checklist

- [ ] All ⚠️ blocking items resolved
- [ ] All **TBD** items have decisions
- [ ] Privacy policy hosted at public URL
- [ ] App tested on dev store with real Shopify data
- [ ] GDPR webhooks tested with Shopify's test tool
- [ ] Lighthouse audit passing
- [ ] Sentry wired and receiving errors
- [ ] CI/CD pipeline green

---

## App Store Review Reference

- [App Store listing requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements)
- [Protected Customer Data requirements](https://shopify.dev/docs/apps/launch/protected-customer-data)
- [Privacy law compliance (GDPR)](https://shopify.dev/docs/apps/build/privacy-law-compliance)
- [App requirements checklist](https://shopify.dev/docs/apps/launch/app-requirements-checklist)
- [App pricing / billing](https://shopify.dev/docs/apps/launch/billing)

---

*This checklist reflects the state of the codebase as of main branch. Update as PRs merge and decisions are made.*
