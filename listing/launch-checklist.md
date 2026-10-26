# Launch Checklist — Termwise: Net Terms & Credit

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

- [x] **⚠️ App name and tagline finalized** — "Termwise: Net Terms & Credit" (`shopify.app.toml:4`)
- [ ] **⚠️ App description written** — Feature bullets, use cases — Why open: not in Partner Dashboard
- [ ] **TBD** Screenshots (minimum 3) — Why open: not created
- [ ] **TBD** Demo video (recommended) — Why open: not created
- [ ] **TBD** App icon (square, meets Shopify requirements) — Why open: `listing/icon.png` is draft, pending Raghav's approval
- [x] **Support contact email**: set in the privacy policy (`docs/privacy.md:15`, #313)

### Scopes and Permissions

Production scopes (9 total, post scope-reduction):

```
read_draft_orders,read_all_orders,read_payment_terms,write_companies,write_customers,write_merchant_managed_fulfillment_orders,write_orders,write_payment_customizations,write_validations
```

Write scopes include read access to the same resource type. See [Access scopes](https://shopify.dev/docs/api/usage/access-scopes).

- [ ] **⚠️ Request `read_all_orders` scope (if needed)**
  - **Owner:** Raghav (Partner Dashboard). **Steps:** [docs/launch-checklist/read-all-orders-request.md](../docs/launch-checklist/read-all-orders-request.md)
  - Current: `write_orders` limited to 60-day order window for reads
  - **Justification:** Historical invoice backfill for existing merchants
  - **Decision needed:** Is 60-day window sufficient for launch?

- [ ] **⚠️ Protected Customer Data (PCD) Access Request**
  - Required for: `write_customers`, `write_orders` scopes (write grants read)
  - **Status:** Level 2 (Name, Email): request complete (16/16), in Draft until App Store listing submission; Shopify reviews it with the listing. As of 26 Oct. (see [docs/privacy.md](../docs/privacy.md), Protected Customer Data note)
  - **Owner:** Raghav (Partner Dashboard) — cite [docs/privacy.md Section 2.3](../docs/privacy.md#23-tagged-customer-data) and [Appendix A](../docs/privacy.md#appendix-a-shopify-oauth-scopes)
  - [ ] **PCD Level 1** — Customer data excluding name, address, phone, and email fields
  - [ ] **Protected Customer Fields (Level 2)** — Name and Email fields only (no phone, no address)
    - Phone, addresses, and other PII fields are never stored (blocked by code)
    - When `CUSTOMER_PII_FIELDS=1` is enabled, only `email` and `displayName` are persisted
  - **Reference:** [Shopify Protected Customer Data](https://shopify.dev/docs/apps/launch/protected-customer-data)

### Privacy Policy

- [x] **⚠️ Privacy policy URL hosted and accessible** (#162, #313, #357 merged)
  - Draft: `docs/privacy.md`
  - [x] **Host on public URL** — `/privacy` route renders `docs/privacy.md` (`app/routes/privacy.tsx`, #162)
  - [x] **Raghav: fill privacy.md TBDs** — legal entity, contact email, effective date, DPA links, Sentry data region filled (#313, #357)
  - [ ] Legal review of privacy policy — Why open: no legal review conducted

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
- [x] **Pricing decided** (product-owner ruling): Starter $9/mo or $90/yr, Growth $19/mo or $190/yr, Unlimited $29/mo or $290/yr; 30-day free trial; all features on every plan (`listing/app-store-listing.md:45-49`, `app/lib/entitlements.ts`).
- [ ] **Plans created in Partner Dashboard** — Why open: Plans reported configured in Partner Dashboard (Starter, Growth, Unlimited; no Scale); to be confirmed by the QA billing test.
- [ ] **QA billing test** — Why open: QA billing test pending
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
  - [ ] `RESEND_FROM` set as a plain (non-secret) var in `wrangler.jsonc`: `reminders@mail.termwiseapp.com`
  - **Owner:** Raghav (DPA, values via secure secret request), then DevOps sets the secrets
  - **Why:** without both secrets reminder sends are acked as "disabled" (safe no-op); once set, real emails go to buyers of any shop with reminders enabled, so the DPA must be in place first

---

## Error Monitoring

- [ ] **⚠️ Wire Sentry error monitoring** — Why open: Worker-side capture pending
  - Package installed: `@sentry/cloudflare`
  - Wrapper implemented: `app/lib/sentry.ts`
  - [x] Create Sentry project (Raghav), DSN provided through a secure secret request (#390)
  - [x] Set `SENTRY_DSN` secret in Cloudflare Workers (DevOps names-only wrangler secret list, 2026-10-26 19:44 IST)
  - **Steps:** [docs/launch-checklist/sentry-setup.md](../docs/launch-checklist/sentry-setup.md)
  - [x] Sentry ingest accepted a synthetic event (HTTP 200 + event id) in the manual sentry-smoke.yml run on main, 26 Oct (#390); arrival not confirmed via Sentry API
  - [ ] Release tags and source maps — Why open: in open PR #323

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
- [ ] Sentry wired and receiving errors — Why open: Sentry wired in code (`workers/app.ts`, `app/lib/sentry.ts`); ingest smoke passed (#390); Worker-side capture pending
- [ ] CI/CD pipeline green
- [ ] PCD request is reviewed with the listing; confirm the selected fields are Name and Email only before submitting (no changes allowed during review).

---

## App Store Review Reference

- [App Store listing requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements)
- [Protected Customer Data requirements](https://shopify.dev/docs/apps/launch/protected-customer-data)
- [Privacy law compliance (GDPR)](https://shopify.dev/docs/apps/build/privacy-law-compliance)
- [App requirements checklist](https://shopify.dev/docs/apps/launch/app-requirements-checklist)
- [App pricing / billing](https://shopify.dev/docs/apps/launch/billing)

---

*This checklist reflects the state of the codebase as of main branch. Update as PRs merge and decisions are made.*
