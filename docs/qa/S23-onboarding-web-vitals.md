# S23 Acceptance Test Plan: Onboarding flow and Web Vitals / Built for Shopify readiness

**Status:** not built on `main` @ `51d2266` (2026-10-23). The existing embedded routes are `app._index.tsx` (S7 aging), `app.data-requests*` (S22) and `app.tsx`. There is no onboarding or setup-guide route and no Web Vitals reporting. `listing/launch-checklist.md` exists for listing work. Everything below is **required behaviour**.

> **Assumptions (no spec in repo):**
> - Onboarding is a Polaris web-components setup guide on the home page that is shown until it is complete or dismissed. It has these steps:
>   - (1) app installed and metafield definitions + validation registered (S11/S12, automatic)
>   - (2) add net-terms tag rules / confirm B2B company sync (S8/S6)
>   - (3) initial sync done (bulk operation finished)
>   - (4) review checkout protection (S12 validation enabled, S13 customization)
>   - (5) optional: reminders (S18, disabled while the Resend key is unset)
> - Progress is derived from DB and Shopify state, not only from clicks. A `ShopOnboarding` row stores dismissed and completed flags only.
> - Built for Shopify (BFS) performance targets, at p75 over 28 days in the admin: **LCP ≤ 2.5 s, CLS ≤ 0.1, INP ≤ 200 ms**. They are measured with App Bridge Web Vitals and must be met with at least the minimum sample of real admin loads before BFS review.

## 1. Purpose
This plan verifies that:
- a new merchant can get from install to first useful aging view without docs
- every step reflects real state and is idempotent
- the embedded app meets BFS Web Vitals and design and behaviour requirements without new scopes or PII

## 2. Preconditions and fixtures (synthetic data only)
- Fresh synthetic shop `qa-shop-new.myshopify.com` (no BuyerAccounts, no invoices), plus `qa-shop-a` (fully set up).
- CI Postgres. Admin client mocked for the `validations`, `metafieldDefinitions` and `currentBulkOperation` reads.
- For Web Vitals: a dev store with the app installed (DevOps). Chrome with a CPU 4x slowdown and Fast 4G profile, for a lab pre-check.

## 3. Test cases

### A. Onboarding flow
| # | Steps | Expected |
|---|---|---|
| S23-01 | First open after install on the fresh shop. | The setup guide is shown with step 1 auto-complete if the afterAuth registration succeeded. Other steps are pending. There is no blank aging table (an empty-state card links to the guide instead). |
| S23-02 | afterAuth registration failed (mocked userErrors). | Step 1 shows "Needs attention" with a retry button. Retry is idempotent (TAKEN counts as success). |
| S23-03 | Add a tag rule (step 2). | The step completes after save. The rule is validated (no empty or duplicate tag, max length). |
| S23-04 | Initial bulk sync running, then finished. | The step shows progress, then completes when `bulk_operations/finish` has been processed. A failed bulk op shows a retry. |
| S23-05 | Step 4 when S12 validation is not deployed or disabled (the current prod state per Prod Diagnostics run 39980626029: `exists: false`). | Shows "Checkout protection not active" with a link to the admin Checkout settings. It never claims to be protected. |
| S23-06 | Step 5 with `RESEND_API_KEY` unset. | Shown as "Coming soon" / not required. It does not block completion. |
| S23-07 | Dismiss, then reload. Then re-open from the help menu. | It stays dismissed. It can be re-opened. Progress is preserved. |
| S23-08 | Two admins act concurrently, or a step is completed twice. | No duplicate rows or errors (upsert on `shopId`). |
| S23-09 | Uninstall, then reinstall. | Onboarding state is reset or purged (with `shop/redact` and `app/uninstalled`). |
| S23-10 | Accessibility. | Keyboard-navigable. Polaris components only. Labels and headings are correct. axe-core has no serious violations. |

### B. Built for Shopify behaviour and design
| # | Steps | Expected |
|---|---|---|
| S23-20 | The app is embedded and uses session-token auth (App Bridge). | No third-party cookies and no full-page redirects out of the admin, except to the OAuth or billing flows. |
| S23-21 | Polaris / App Bridge UI. | Uses the `s-page`, `s-section` and title bar patterns. The primary action is in the title bar. Nav uses the App Bridge `ui-nav-menu`. |
| S23-22 | Error and empty states. | Every route has a Polaris error boundary and helpful empty states. There are no raw stack traces. |
| S23-23 | Plan gating. | `PLAN_GATING_ENFORCED` is off in prod. Onboarding does not show upgrade walls. Any billing UI uses the Shopify Billing API only. |

### C. Web Vitals
| # | Steps | Expected |
|---|---|---|
| S23-30 | Web Vitals collection. | App Bridge is loaded from the Shopify CDN as the first script, so the admin collects LCP, CLS and INP. Optionally, `shopify.webVitals.onReport` sends metric name, value, rating and route only to our endpoint. No PII. |
| S23-31 | Lab pre-check on home (aging) and onboarding, with 35 synthetic invoices and 4x CPU. | LCP ≤ 2.5 s, CLS ≤ 0.1, INP ≤ 200 ms for filter and sort and page change. |
| S23-32 | Large shop: 5,000 open invoices. | The loader stays paginated (PAGE_SIZE 20) and there is no client-side full list. TTFB is within the Worker CPU budget. LCP is still ≤ 2.5 s. |
| S23-33 | Layout stability. | Skeletons reserve space for the aging cards and table. There are no late banners pushing content (CLS ≤ 0.1). |
| S23-34 | Bundle. | The route JS is within the agreed budget. The Wrangler size check in CI passes. No heavy client libraries are added for onboarding. |
| S23-35 | Field data (DevOps / Partner Dashboard). | p75 over 28 days meets all three targets, with enough samples, before BFS submission. |

## 4. Protected customer data, scopes and data minimization (DPDP)
- **PCD-1:** Onboarding shows counts and statuses only. Where buyer names appear, they are customer **Name/Email** gated by `CUSTOMER_PII_FIELDS=1`. **Phone and address are a fail.**
- **PCD-2:** Web Vitals payloads contain no PII, shop-owner email, buyer data or full URLs with query strings.
- **SCOPE-1:** Exactly the 11 production scopes. **No `write_payment_terms`, no `write_draft_orders`.** Onboarding must not trigger a scope re-approval. The scope-sync check passes.
- **DPDP-1:** `ShopOnboarding` stores flags and timestamps only. It is purged on `shop/redact`.
- **DPDP-2:** Any analytics or Web Vitals endpoint data is kept ≤ 30 days (pg_cron purge, like `s20_webhook_receipts_cleanup`) and is documented in `docs/privacy.md`.

## 5. Vitest automation hints
- Loader tests for step-state derivation with mocked Admin responses (`it.each` over the step states).
- Action tests for dismiss and re-open and tag-rule validation, against CI Postgres.
- Component tests with `@testing-library/react` + `vitest-axe` for accessibility.
- A Web Vitals reporter unit test asserts that the payload keys are only `{name, value, rating, route}`.
- Lab perf: optional Lighthouse CI against a preview. It must not call the real admin in CI.

## 6. Done criteria
- [ ] S23-01 through S23-10 pass.
- [ ] S23-20 through S23-23 pass.
- [ ] S23-30 through S23-34 pass in the lab. S23-35 is confirmed from field data before BFS review.
- [ ] PCD-1/2, SCOPE-1 and DPDP-1/2 pass.
- [ ] CI is green on the PR head (lint, scope-sync, typecheck, vitest, build, Wrangler size, Worker boot). No placebo tests.
