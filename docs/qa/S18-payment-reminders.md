# S18 Acceptance Test Plan: Payment reminders (gated on the Resend API key)

**Status:** Built and tested in [PR #234](https://github.com/raghavkhanna268/net-terms-receivables/pull/234). Full implementation in `app/services/reminders.server.ts` with:
- Atomic cap enforcement via `pg_advisory_xact_lock` (fixes race condition from original CTE approach)
- Daily cap: 100/day, Monthly cap: 3,000/month (per Resend free tier)
- Idempotency via `ReminderLog` unique index on `(ruleId, invoiceId)`
- Send window: 09:00-19:00 in shop's local timezone

**The Resend key stays unset until Raghav accepts Resend's DPA**, so the unset-key path (section A) is the **release-blocking** path. Everything below is **required behaviour**.

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
- [x] **S18-01 through S18-07 pass.** This is the release gate while the DPA is pending.
  - S18-01: `app/services/__tests__/reminders.test.ts:234` - no fetch when key unset
  - S18-02: `app/services/__tests__/reminders.test.ts:167-177` - empty/whitespace treated as unset
  - S18-05: `app/services/__tests__/reminders.test.ts:252-256` - logs "reminders_disabled"
- [x] S18-10 through S18-17 pass with a mocked provider.
  - S18-10: `app/services/__tests__/reminders-cap-db.test.ts:218-273` - two different invoices both send
  - S18-11: `app/services/__tests__/reminders-cap-db.test.ts:275-326` - concurrent calls give exactly 1 send
  - S18-12: `app/services/__tests__/reminders.test.ts:399-419` - skips paid/cancelled invoices
  - S18-14: `app/services/__tests__/reminders.test.ts:562-589` - 429/5xx retryable
  - S18-15: `app/services/__tests__/reminders.test.ts:592-627` - 401 non-retryable, releases cap
  - S18-16: `app/services/__tests__/reminders.test.ts:999-1008` - timezone day boundary handling
- [x] S18-20 passes. Prod `PLAN_GATING_ENFORCED` is still `"false"`.
  - `app/services/__tests__/plan-gating-actions-db.test.ts:342-403` - gated account sends when gating OFF
- [x] PCD-1/2, SCOPE-1 and DPDP-1 through DPDP-3 pass.
  - PCD-1: `app/services/__tests__/reminders.test.ts:445-466` - skips when no email
- [x] CI is green on PR #234. No real network in tests. No placebo assertions.
- [x] **Cap enforcement is atomic.** 
  - Daily cap: `app/services/__tests__/reminders-cap-db.test.ts:112-156` - 100 sequential succeed, 101st returns daily_cap; concurrent at 99 gives exactly 1
  - Monthly cap: `app/services/__tests__/reminders-cap-db.test.ts:158-216` - reservations 2996..3000 succeed, 3001 returns monthly_cap; concurrent at boundary gives exactly remaining count
- [ ] DevOps confirms the `RESEND_API_KEY` secret is **absent** in the prod Worker (`wrangler secret list`) until Raghav confirms the DPA.

## 7. Resend Free Tier Limits

**Source:** https://resend.com/pricing (verified 2026-10-25)

| Limit | Value | Notes |
|-------|-------|-------|
| Daily | 100 emails/day | "The Free plan is limited to 100 emails per day." |
| Monthly | 3,000 emails/month | Free tier transactional email quota |

The code constants (`DAILY_SEND_CAP=100`, `MONTHLY_SEND_CAP=3000` in `app/services/reminders.server.ts:62-68`) match these limits exactly.

## 8. Catch-up for Capped Reminders (#230)

**Status:** Implemented in this PR. When daily/monthly cap is reached, reminders are deferred instead of being silently dropped.

### 8.1 Behavior
| # | Steps | Expected |
|---|---|---|
| S18-30 | Send hits daily/monthly cap. | Reminder is stored as `status='delayed'` with `firstCappedAt` timestamp. Not deleted. |
| S18-31 | Catch-up window: D+1 to D+3 (shop-local days). | `s18_enqueue_reminders()` enqueues `REMINDER_CATCHUP` for delayed rows in window. |
| S18-32 | Past D+3 window. | Delayed rows become `status='skipped_daily_limit'`. |
| S18-33 | Multiple stages delayed for same invoice. | Latest stage (highest offsetDays) stays delayed; older stages become skipped. |
| S18-34 | Oldest-first ordering. | Catch-up messages enqueued by oldest reminder date first within each batch. |
| S18-35 | At most one per invoice per day. | Per-invoice advisory lock (`s18_invoice_<id>`) prevents multiple sends. |
| S18-36 | Invoice paid mid-window. | Delayed row deleted silently on eligibility re-check. |
| S18-37 | Shop disables reminders mid-window. | Delayed row deleted silently on eligibility re-check. |
| S18-38 | Rule disabled mid-window. | Delayed row deleted silently on eligibility re-check. |
| S18-39 | Account gated mid-window. | Delayed row deleted silently on eligibility re-check. |

### 8.2 Migration `20261112000000_s18_reminder_catchup`
- Purely additive: no drops, no destructive UPDATE/DELETE
- Adds enum `ReminderLogStatus` (sent, delayed, skipped_daily_limit)
- Adds `ReminderLog.status` NOT NULL DEFAULT 'sent'
- Adds `ReminderLog.firstCappedAt` (nullable timestamp)
- Makes `ReminderLog.sentAt` nullable
- CHECK constraints tie sentAt/firstCappedAt to status
- Partial index on delayed rows
- Updates `s18_enqueue_reminders()` with catch-up logic

### 8.3 UI
- Reminder log table on settings page: invoice name, stage, status, date
- No buyer name or email displayed

### 8.4 Done criteria (catch-up)
- [x] S18-30: `app/services/__tests__/reminders-catchup-db.test.ts` - cap boundary upserts as delayed
- [x] S18-31-32: `app/services/__tests__/reminders-catchup-db.test.ts` - expiry after D+3
- [x] S18-33: `app/services/__tests__/reminders-catchup-db.test.ts` - stage collapse
- [x] S18-34: `app/services/__tests__/reminders-catchup-db.test.ts` - oldest-first ordering
- [x] S18-35: `app/services/__tests__/reminders-catchup-db.test.ts` - at most one per day
- [x] S18-36: `app/services/__tests__/reminders-catchup-db.test.ts` - payment mid-window deletion
- [x] Migration backfill: existing rows remain status='sent' with unchanged count

## 9. update_rule Duplicate Offset Fix

**Status:** Implemented in separate commit. Previously `create_rule` blocked duplicate offsets but `update_rule` did not.

### 9.1 Done criteria
- [x] `app/routes/__tests__/app.settings.reminders.test.ts` - rejects duplicate offset when updating

## 10. Partly Paid Invoices

**Status:** Implemented. Reminders show outstanding balance instead of original total.

### 10.1 Behavior
| # | Steps | Expected |
|---|---|---|
| S18-40 | Invoice partly paid (outstanding > 0, outstanding < total). | Reminder is sent with the **outstanding** balance displayed, not the original total. |
| S18-41 | Invoice fully paid (outstanding = 0) but status still 'open'. | Reminder is **skipped**. No email sent, no ReminderLog created. |
| S18-42 | Email content for partly paid invoice. | Shows "₹3,000.00" (outstanding), not "₹10,000.00" (total). |

### 10.2 Implementation
- `getInvoiceForReminder` fetches `outstanding` field
- Gate added: skip if `outstanding <= 0` (before cap reservation)
- `renderPaymentReminderEmail` receives `outstanding`, not `total`
- No amount logged (DPDP compliance)

### 10.3 Done criteria
- [x] S18-40: `app/services/__tests__/reminders-catchup-db.test.ts` - partly paid invoice sends
- [x] S18-41: `app/services/__tests__/reminders-catchup-db.test.ts` - zero outstanding skipped
- [x] S18-42: `app/services/__tests__/reminders.test.ts` - email shows outstanding amount

## 11. Uninstalled Shop Handling

**Status:** Implemented. Pre-send eligibility checks prevent reminders to uninstalled shops.

### 11.1 Behavior
| # | Steps | Expected |
|---|---|---|
| S18-50 | REMINDER_SEND message processed after shop uninstalled. | Reminder is **skipped**. No email sent, no ReminderLog 'sent' row created. |
| S18-51 | REMINDER_CATCHUP for delayed row after shop uninstalled. | Delayed row is **deleted silently**. No email sent. |

### 11.2 Implementation
- `getInvoiceForReminder` fetches `Shop.uninstalledAt`
- Gate added in both `sendPaymentReminder` and `sendCatchupReminder`
- SQL enqueue already filters uninstalled shops, but queued messages need the check
- For catch-up, failed eligibility deletes the delayed row (same as other eligibility failures)

### 11.3 Done criteria
- [x] S18-50: `app/services/__tests__/reminders-uninstalled-db.test.ts` - uninstalled shop skips send
- [x] S18-51: `app/services/__tests__/reminders-uninstalled-db.test.ts` - catch-up deletes delayed row
