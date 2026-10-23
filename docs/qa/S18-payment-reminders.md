# S18 Acceptance Test Plan: Payment reminders (gated on the Resend API key)

**Status:** not built on `main` @ `51d2266` (2026-10-23). `customer-fields.server.ts` lists "S18: Payment reminder emails" as a consumer of the optional `email`/`displayName` fields. There is no reminder code, no Resend client, and no `RESEND_API_KEY` binding. **The Resend key stays unset until Raghav accepts Resend's DPA**, so the unset-key path (section A) is the **release-blocking** path. Everything below is **required behaviour**.

> **Assumptions (no spec in repo):**
> - Reminders are scheduled by pg_cron (for example a daily `s18_payment_reminders` job at a fixed IST hour). The job enqueues per-invoice reminder jobs for open invoices at configured offsets: before due, on due, and N days overdue.
> - Sending happens only when `RESEND_API_KEY` is a non-empty Worker secret **and** the shop has enabled reminders **and** the buyer has an email (`CUSTOMER_PII_FIELDS=1`).
> - The email content has the invoice number (order name), amount, due date, and a merchant contact line. There is no payment link that needs new scopes.

## 1. Purpose
This plan verifies that:
- with no Resend key, nothing is sent, nothing errors, and the merchant sees a clear "Email reminders not yet available" state
- with a key, reminders go once per schedule slot, to the right buyer, with minimal data

## 2. Preconditions and fixtures (synthetic data only)
- CI Postgres. Shop `qa-shop-a` (INR) with:
  - B1: an invoice 5 days before due, an invoice due today, and invoices 1, 15 and 45 days overdue.
  - T1 with `email = qa-buyer@example.test` (synthetic, `example.test` domain only).
  - T2 with no email.
- `RESEND_API_KEY` **unset** (default). A separate test env sets the fake key `re_test_0000`.
- Resend HTTP mocked with `msw` or `vi.spyOn(fetch)`. **Real network calls in CI are a fail.**

## 3. Test cases

### A. Unset key (current production state)
| # | Steps | Expected |
|---|---|---|
| S18-01 | Run the reminder job with `RESEND_API_KEY` unset. | **Zero** outbound HTTP calls to `api.resend.com`. No queue message is left un-ack'd, and nothing is retried or dead-lettered. The job exits successfully. |
| S18-02 | Same, with `RESEND_API_KEY=""` or whitespace. | Treated as unset. |
| S18-03 | Open the reminders settings page. | The toggle is disabled, with text like "Email reminders will be available soon". There is no error banner and no "failed" counts. |
| S18-04 | Try to enable reminders via a crafted POST. | Rejected (400/403) or stored as "pending". It never results in sends. |
| S18-05 | Logs with the key unset. | One info-level line per run at most ("reminders disabled: no provider key"). No buyer email, name or invoice amounts. No stack traces. |
| S18-06 | Worker boot with the key unset. | The CI Worker boot test still passes. No `throw` at module load. |
| S18-07 | Then the key is set. | No backlog blast: reminders for slots that passed while unset are **not** sent retroactively. Only current-slot reminders go. |

### B. Key set (future)
| # | Steps | Expected |
|---|---|---|
| S18-10 | Daily run. | One email per (invoice, offset) slot, to T1's email only. T2 (no email) is skipped and counted. |
| S18-11 | Run twice the same day, or replay a duplicate job. | No second email. Idempotency key `(shop, invoiceId, offset)` with `ON CONFLICT DO NOTHING`. |
| S18-12 | Invoice paid or cancelled before the slot. | No reminder. |
| S18-13 | The shop disables reminders. | No sends from the next run on. |
| S18-14 | Resend returns 429 / 5xx. | Bounded retry. No duplicate on success-after-timeout (send the idempotency key header). |
| S18-15 | Resend returns 401 (revoked key). | Stop the run. Alert via Sentry with no PII. No retry storm. |
| S18-16 | Timezone. | Slots computed in Asia/Kolkata (consistent with S7 `aging-dates.server.ts`). |
| S18-17 | Content. | Order name, amount (en-IN), due date, and the merchant name only. No other buyers' data, no internal ids, and no credit limit unless the merchant opts in. |

### C. Gating
| # | Steps | Expected |
|---|---|---|
| S18-20 | `PLAN_GATING_ENFORCED` off (prod). | Reminders are not plan-restricted. Gated accounts are treated as active (`activeAccountFragment` returns TRUE). |

## 4. Protected customer data, scopes and data minimization (DPDP)
- **PCD-1:** Only customer **Email and Name** (`email`, `displayName`) are used, and only with `CUSTOMER_PII_FIELDS=1`. **Phone and address are a fail.** No new customer fields are fetched.
- **PCD-2:** Email is read from the DB or Shopify at send time. It is not copied into reminder log or idempotency tables (store `invoiceId` and `offset` only).
- **SCOPE-1:** Exactly the 11 production scopes. **No `write_payment_terms`, no `write_draft_orders`.** Sending email needs no Shopify scope. The scope-sync check passes.
- **DPDP-1 (minimization / purpose limitation):** Reminders go only to buyers with an existing net-terms relationship. Data sent to Resend is limited to the recipient email, name and invoice summary.
- **DPDP-2 (processor):** **No data is sent to Resend until the DPA is accepted.** This is enforced by the unset key (section A). Document Resend as a processor in `docs/privacy.md` before the key is set.
- **DPDP-3:** `customers/redact` removes the buyer from future reminders and purges any reminder records keyed to them. Logs contain no email addresses (assert with a regex over the `console.*` spy).

## 5. Vitest automation hints
- Gate helper `isReminderSendingEnabled(env)`: `it.each([undefined, "", "  ", "re_test_0000"])`.
- Spy `globalThis.fetch` and assert `not.toHaveBeenCalled()` for the whole of section A.
- Integration tests against CI Postgres for the idempotency table and slot selection. Freeze time with `vi.setSystemTime` plus `TZ=America/New_York` (reuse the CI non-UTC TZ session).
- Run the Worker boot test with the secret absent.

## 6. Done criteria
- [ ] **S18-01 through S18-07 pass.** This is the release gate while the DPA is pending.
- [ ] S18-10 through S18-17 pass with a mocked provider.
- [ ] S18-20 passes. Prod `PLAN_GATING_ENFORCED` is still `"false"`.
- [ ] PCD-1/2, SCOPE-1 and DPDP-1 through DPDP-3 pass.
- [ ] CI is green on the PR head. No real network in tests. No placebo assertions.
- [ ] DevOps confirms the `RESEND_API_KEY` secret is **absent** in the prod Worker (`wrangler secret list`) until Raghav confirms the DPA.
