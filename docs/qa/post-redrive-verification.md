# Post-redrive verification: S9 / S7 / S16 / S20 (DRAFT, not committed)

**Target:** `raghavkhanna268/net-terms-receivables` `main` @ `c11ed11` (c11ed11847bba5aa94bfa0ffb1747cf89a14bd23)
**When to run:** after DevOps phase 2 finishes, in this order: (1) ORDERS DLQ redrive, (2) reconcile (companies, then orders), (3) drains of `s6_sync` and `s6_bulk` until the queues settle.
**Script:** `scripts/post-redrive-verify.sql`. It is read-only and psql-driven. It prints counts, booleans and enum labels only.

> **Rules this plan follows**
> - SELECT-only, inside `BEGIN TRANSACTION READ ONLY … ROLLBACK`. Run it with `PGOPTIONS="-c default_transaction_read_only=on"` too, the same as #75.
> - Every query is scoped to one shop (`:'shop'` domain, resolved to `:'shop_id'`). The one exception is `pgmq.metrics_all()` in the manual step M3, which is global by design.
> - **No customer PII (DPDP minimisation).** The script never selects `email`, `display_name`, `BuyerAccount.name`, `Invoice.name`, `Payment.payerText`, `Payment.narration`, `PayerAlias.payerKey`, DLQ `error` text or message bodies. Error text is only classified with `LIKE` into fixed labels. The seed company names appear only in `WHERE` clauses, to find seeded rows. They are synthetic business names from `scripts/seed.ts`, and they are never output.
> - PCD policy is Level 1 plus email and name. Nothing here reads phone or address, and none of it is echoed.
> - All fixtures referenced here are **synthetic**: seed `.example` contacts, `ntr-seed-net*` tags, and `tests/fixtures/banks/synthetic/*.csv`.
> - **Placeholders** look like `<LIKE_THIS>`. They mark values that can't be read from the code. Fill them in from DevOps logs or the pre-redrive diagnostics. Don't guess them.

## 0. How to run

```bash
# Locally (DevOps), using the same read-only URL that #75 uses
PGOPTIONS="-c default_transaction_read_only=on" \
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v shop="$SHOP_DOMAIN" \
  -v redrive_started_at='<REDRIVE_STARTED_AT_UTC>' \
  -f scripts/post-redrive-verify.sql
# optional: -v as_of='2026-10-25T12:00:00+05:30'   (default now())
```

**Fit with the prod-diagnostics workflow (#75):**
- **What fits:** the script uses the same conventions as the workflow: `psql -v ON_ERROR_STOP=1 -v shop=…`, `:'shop'` variables, `SELECT id FROM "Shop" WHERE domain = :'shop'`, and the `DATABASE_URL_MIGRATIONS` plus read-only `PGOPTIONS` env.
- **What's missing:** `prod-diagnostics.yml` doesn't run any `.sql` file today. It uses inline heredocs. Running the script from the workflow needs a new step after `Checkout`, with the existing read-only env:
  ```yaml
  - name: Post-redrive verification (read-only)
    run: psql -v ON_ERROR_STOP=1 -v shop="$SHOP_DOMAIN" -f scripts/post-redrive-verify.sql
  ```
  That is a workflow code change. It is **not made and not committed.** Until someone adds it, DevOps can run the script locally as shown above.
- **Difference from the existing steps:** the workflow's current DLQ, receipt and processed queries are **global**. Every query in this script is shop-scoped. `s6_processed_webhooks` has no shop column, so the script scopes it through a `webhook_receipts` join, the shop's `Invoice.orderId`, or the `reconcile:<shop>:` id prefix.
- **Tested locally:** I ran the script under `default_transaction_read_only=on` against a throwaway Postgres 17 instance. It had a hand-built mock of the relevant tables, loaded with synthetic seed-shaped data. It completed end to end with no errors, and the aging numbers matched the table in §2. This checks the syntax and logic only. It is not a prod run.

## 1. Preflight (P0)

| ID | Check | Pass criterion |
|---|---|---|
| P0-1 | Shop is installed and its timezone is valid in `pg_timezone_names` | `pass = t`. If `tz_valid_in_pg = f`, **S7 parity is at risk**: TS falls back to Asia/Kolkata, but the SQL parity query uses the raw tz. Treat that as a blocker for S7. |
| P0-2 / P0-2-summary | Messages still pending in `pgmq.q_s6_sync` and `q_s6_bulk` for this shop, by topic | `pending_not_held = 0`. CUSTOMERS_* and DRAFT_ORDERS_* rows may stay because they are held. |
| P0-3 | Reconcile bulk ops (`origin='reconcile'`) after the redrive started, for both stages: `companies` and `orders` | Both stages are present with `completed > 0`. Investigate if `max_failure_count > 0`. |
| P0-3b | Reconcile message ids `reconcile:<shop>:<YYYY-MM-DD UTC>:companies\|orders` are in `s6_processed_webhooks` | Both counts are ≥ 1 and `todays_orders_reconcile_processed = t`. If reconcile ran on a different UTC date than `as_of`, check by hand. |
| P0-4 | Rows in `s10b_order_refetch_null` | Informational. Orders older than 60 days come back null without `read_all_orders`. Seeded Net60 orders backdated 45–49 days pass 60 days around **2026-11-03 to 07 IST**. A null refetch keeps the ledger unchanged for CREATE/UPDATED. |

**Manual steps (M), as in `docs/runbooks/dlq-redrive.md`:**
- M1: Re-run prod-diagnostics with no actions.
- M2: Check the drain logs for "Non-retryable" and "No handler registered".
- M3: Run `SELECT * FROM pgmq.metrics_all();`. This one is global, not shop-scoped. Pass: `queue_length` is 0 for `s6_bulk`, and only held topics remain for `s6_sync`.

## 2. S9: invoice counts by eligibility path and dueBasis

The eligibility path is **not persisted**. The script infers it from `dueSource`, `dueBasis` and `BuyerAccount.kind`, based on `invoice-eligibility.ts` and `due-date.ts`:

| Path | Inferred from |
|---|---|
| (a) Shopify payment terms | `dueSource='schedule'`, `dueBasis` NULL (schedule `dueAt`) or `'paymentTermsDueInDays'` |
| (b) Company explicit terms | `kind=COMPANY`, `dueSource='inferred'`, `dueBasis='accountDefault'` |
| (c) Tagged customer | `kind=TAGGED_CUSTOMER`. `dueBasis='tagRule'` when the account has `defaultTermsSource='tag'`, which is what `customer.server.ts` sets. `'accountDefault'` when the terms are explicit. |
| Other | `shopDefault`, `override`, `none` |

**Seed assumptions** (`scripts/seed.ts` @ c11ed11; **#77 is reworking the seed, so re-check before relying on these**):
- 5 companies × 3 locations (Net15/30/60) = **15 COMPANY accounts**.
- 2 PENDING orders per location = **30 B2B orders**, so 10 per Net term.
- 5 tagged PENDING orders (Net15 ×2, Net30 ×2, Net60 ×1).
- **No** retail, PAID, terminal or draft orders.
- Orders are backdated through `processedAt`, so `issuedAt = now − daysAgo`.
- The seed upserts the shop with `ON CONFLICT (domain)`, so an existing shop keeps its timezone and terms.
- The seed upserts the BuyerAccount with `ON CONFLICT (shopId, companyLocationId)`. If company sync created the account first, its id is not `seed-account-*`. The script also matches on the seed company-name prefix (WHERE clause only).
- Assumption: S21 gating uses `gated_at IS NULL` as the active-account filter (`activeAccountFragment`). A gated account produces `no_buyer_account`.

| ID | Check | Pass criterion |
|---|---|---|
| S9-1 | All invoices for the shop by inferred path × kind × dueSource × dueBasis × status | Informational. Basis is `other` only for invoices that aren't seeded. Expected non-seed totals: `<NON_SEED_INVOICES_EXPECTED>` (placeholder). |
| S9-2 | Seed COMPANY accounts found | `= 15` (5 each Net15/30/60) and `gated = 0`. If this is < 15, reconcile companies didn't create or match the locations, so S9-3 and later can't pass. |
| S9-3 | Seed B2B invoices per Net term | **10 per term, 30 in total**. The split between `paymentTermsDueInDays`/schedule (path a) and `accountDefault` (path b) is a **placeholder**: `<B2B_WITH_SHOPIFY_TERMS>` uses path a, and `30 − <B2B_WITH_SHOPIFY_TERMS>` use `accountDefault`. It depends on whether Shopify attached payment terms to each order at seed time. Pass also needs `basis_unexpected = 0`. |
| S9-4 | Due date: local(`dueAt`) = local(`issuedAt`) + N days, at local end of day (23:59:59.999 in the shop tz) | For `inferred` rows, `pass = t`, meaning all of them match. For `schedule` rows, Shopify computes `dueAt`, so `pass` is NULL. Expect `due_date_matches_terms = invoices` if the Shopify terms equal the location terms. Check by hand. |
| S9-5 | Tagged prerequisites: `s8_tagged_customers` rows with `ntr-seed-net*` tags, active count, TAGGED_CUSTOMER accounts, gated count | Decides which S9-6 row applies. **CUSTOMERS_* is held, and reconcile doesn't sync customers**, so these rows can only exist from earlier syncs. |
| S9-6 | Tagged invoices by terms source and dueBasis | Expected count `<TAGGED_INVOICES_EXPECTED>` (placeholder), chosen from S9-5 below. Every invoice should have `due_date_matches_terms = invoices` and `due_basis = 'tagRule'` when `terms_source = 'tag'`. |
| S9-7 | Processed ORDERS_* webhooks with **no** invoice: retail, ineligible or terminal status, null refetch, or PAID/CANCELLED on an unknown order | `<RETAIL_AND_TERMINAL_SKIPS_EXPECTED>` (placeholder). The seed creates none, so a non-zero count comes from real or manual orders. These are permanent skips: they are marked processed and never go to the DLQ. |
| S9-8 | Outstanding is within `[0, total]` for every status. The script also counts open invoices with zero outstanding. | `outstanding_out_of_range = 0`. `open_with_zero_outstanding` should be 0. Investigate if it isn't. |

**Choosing the S9-6 expectation from S9-5:**

| S9-5 state | Tagged-order outcome after redrive | Expected tagged invoices | Expected DLQ (S20-5 `orders_rows_tag_rule_nba`) |
|---|---|---|---|
| No seed `s8_tagged_customers` rows | **`retail_order`**: permanent skip, marked processed. It is **not** repaired later unless the order is re-processed after CUSTOMERS_* is released. | 0 | 0 |
| s8 rows exist, but no active (non-gated) TAGGED account | **`no_buyer_account`** (retryable): skipped without being marked processed. After 5 reads it goes back to the DLQ with "Customer matches tag rule … but no BuyerAccount found". | 0 | number of tagged messages redriven, `<TAGGED_NBA_EXPECTED>` (≤ 5 seed orders × topics delivered) |
| Both exist and are active | `tagged_customer` | up to 5 | 0 |

Note: bulk reconcile of orders skips retryable cases and doesn't create invoices for them. It also always updates existing invoices.

## 3. S7: aging buckets in the shop timezone, and SQL vs TS parity

Logic (`aging.ts`, `aging-dates.server.ts`, `aging-queries.server.ts`):
- `dpd = local(asOf) date − local(dueAt) date` in the shop's IANA tz. A NULL `dueAt` counts as current.
- Buckets: `current` is ≤ 0, then `1-30`, `31-60`, `61-90`, and `90+` (≥ 91).
- Only `status='open' AND outstanding > 0` is included.

| ID | Check | Pass criterion |
|---|---|---|
| S7-1 | Bucket distribution using the **verbatim** `getAgingBucketsForParity` expression | For the seeded B2B set only, compare with the table below. For the whole shop: `<AGING_BUCKETS_EXPECTED_NON_SEED>` (placeholder). |
| S7-2 | Parity: SQL parity dpd and bucket vs. an independent mirror of the TS logic (validated tz with Asia/Kolkata fallback, `::date` difference) | `dpd_mismatches = 0` and `bucket_mismatches = 0`. |
| S7-3 | Invoices whose dpd differs between shop tz and UTC | Informational. A non-zero value proves the shop tz matters, for example when `as_of` falls between 00:00 and 05:30 IST. Re-run with that `as_of` to test the tz edge. |
| S7-4 | Seeded B2B aging vs the seed design: dpd from stored `dueAt` = (local asOf − local issuedAt) − N | `mismatches = 0`. This doesn't depend on the run date, so it's the main S7 check. |

**CI parity test:** `app/lib/__tests__/aging-reconcile.test.ts` needs `TEST_DATABASE_URL` and writes fixtures. It is **CI only and must never run against prod.** S7-2 is the read-only stand-in for prod.

**Expected seeded B2B distribution (S7-1 / S7-4 `design_*` columns), 30 open invoices:**
- This assumes the invoices come from the seed run at **2026-10-23 16:10 IST**: run `39940796127`, success, sha `9e189f5`.
- **Placeholder `<SEED_RUN_CONFIRMED>`:** that run's `dry_run` input and its "Orders with payment terms" log line are **not verified**. Earlier runs on the same day failed.
- If a different run created the orders, shift the dates.

| as_of (IST date) | current | 1-30 | 31-60+ | Tagged, if invoiced (current / 1-30) |
|---|---|---|---|---|
| 2026-10-24 | 20 | 10 | 0 | 3 / 2 |
| 2026-10-25 | 19 | 11 | 0 | 3 / 2 |
| 2026-10-26 | 18 | 12 | 0 | 3 / 2 |
| 2026-10-27 | 17 | 13 | 0 | 3 / 2 |
| 2026-10-28 | 16 | 14 | 0 | 3 / 2 |
| 2026-10-29 to 2026-10-30 | 15 | 15 | 0 | 2 / 3 |
| 2026-10-31 to 2026-11-01 | 14 | 16 | 0 | 2 / 3 |
| later dates | compute from S7-4 `design_*` | | | |

How the table is derived: per seed order, `dpd = daysAgo + k − N`, where k = (as_of IST date − 2026-10-23). The highest B2B dpd is 17 + k, so `31-60` first appears at k = 14 (2026-11-06). The orders were created around 16:10 IST, far from midnight, so the calendar-day arithmetic holds.

## 4. S16: matcher suggest, confirm and reject on seeded invoices

**Code facts** (`matcher.server.ts`, `matching/queries.server.ts`, S16 migration):
- v1 is **confirm-only**: it never changes `Invoice.outstanding`. S17 applies payments.
- Re-running deletes only `suggested` rows.
- `confirmMatch`:
  - Changes the match from `suggested` to `confirmed`. The amount is capped, and `confirmedBy` and `confirmedAt` are set.
  - Other buyers' suggested siblings become `unmatched`. Same-buyer siblings become `unmatched` only when no room is left.
  - Learns a `PayerAlias`.
  - Sets the payment to `matched` when fully allocated, otherwise `partial`.
- `rejectMatch`:
  - Changes the match from `suggested` to `unmatched` and inserts into **`rejected_matches`**.
  - The table is **not** called `s16_rejected_matches`. That name was in the brief, but the migration and code use `rejected_matches`.
  - The payment becomes `unmatched` when nothing suggested, confirmed or pushed is left.
- Rejected pairs are never suggested again.
- Gated accounts are excluded from candidates.

**Flow (manual, synthetic data only):**
1. Upload `tests/fixtures/banks/synthetic/hdfc-retail-synthetic.csv`, then `icici-retail-synthetic.csv`. The fixtures are synthetic. The malformed and unknown variants should be rejected at parse.
2. Run the matcher.
3. Run the script. Record the S16-1 counts as **baseline B**.
4. Confirm one suggested match. Re-run the script. Expected change from B:
   - `matches_confirmed +1`
   - `matches_suggested −(1 + siblings cleared)`
   - Payment moves to `partial` or `matched`
   - `payer_aliases +0 or +1`
5. Reject one suggested match on a different payment. Re-run the script. Expected change:
   - `rejected_pairs +1`
   - `matches_unmatched +1`
6. Run the matcher again. Expected: `rejected_pair_still_suggested = 0`.

| ID | Check | Pass criterion |
|---|---|---|
| S16-1 | Counts of BankImport, Payment by status, Match by state, `rejected_matches` and PayerAlias | The seed creates **no** payments. Expected counts after upload are placeholders: `<S16_PAYMENTS_EXPECTED>` and `<S16_SUGGESTED_EXPECTED>`. They depend on the CSV credits and matcher scoring against the seeded invoices. The deltas follow steps 4–5. |
| S16-2 | Invariants | Every row has `violations = 0`: `confirmed_missing_confirmedBy_or_At`, `rejected_pair_still_suggested`, `rejected_pair_without_unmatched_match_row`, `payment_confirmed_alloc_exceeds_amount`, `invoice_confirmed_alloc_exceeds_total`, `payment_status_inconsistent_with_confirmed_alloc`, `match_cross_shop`, `match_amount_non_positive`. |
| S16-3 | `suggested` matches on invoices that are no longer open, for example ones the redrive closed with ORDERS_PAID or CANCELLED | **WARN**, not fail. Report the count. The matcher only filters for open invoices when it suggests, so suggestions can go stale. |

## 5. S20: webhook_receipts, dedup, and DLQ after the redrive

**Code facts:**
- The edge inserts a `webhook_receipts` row (PK `(shop, webhook_id)`) with `ON CONFLICT DO NOTHING`, in **one transaction** with the enqueue. Duplicates aren't enqueued.
- Receipts are purged after 30 days.
- The redrive re-sends DLQ messages directly, so it doesn't create new receipts.
- The drain dedups through `s6_processed_webhooks` on `webhook_id`.
- Drain DLQ rules:

  | Case | Goes to the DLQ |
  |---|---|
  | `retryable === false` | immediately, as "Non-retryable error: …" |
  | Retryable failure | at `read_ct ≥ 5`, with the eligibility explanation as the error |
  | No handler | after 48 reads, as "No handler registered for topic after N reads" |

| ID | Check | Pass criterion |
|---|---|---|
| S20-1 | Receipts by topic: total, received since the redrive, duplicate ids | `duplicate_webhook_ids = 0` (`pass = t`). `receipts_since_redrive_start` should be live traffic only: `<LIVE_RECEIPTS_DURING_WINDOW>` (placeholder). A jump the size of the redrive means redrive went through the edge, which would be unexpected. |
| S20-2 | Shop's ORDERS_* processed rows with receipts; order-topic pairs seen under more than one webhook id (info); duplicate invoices per order | `duplicate_invoices_per_order = 0` (`pass = t`). |
| S20-3 | Conservation: every ORDERS_* receipt is processed, in the DLQ, or still queued | `unaccounted = 0`. Assumption: the PAID and CANCELLED handlers mark their webhooks processed. |
| S20-4 | DLQ rows for the shop by queue × topic × **error class**: `nba_payment_terms`, `nba_tag_rule`, `nba_company_location`, `no_handler`, `non_retryable`, `other`. Error text is never printed. | Informational breakdown for S20-5. |
| S20-5 | DLQ pass criteria (see below) | `pass_code_derived = t` covers the three code-derived rules. Compare the other columns with the placeholders. |
| S20-6 | ORDERS_* rows dead-lettered again since the redrive started, and whether any of them were already processed | `dlq_rows_already_processed = 0`. Every re-DLQ'd row should be one of the retryable `nba_*` classes in S20-4. |

**S20-5 pass criteria in detail:**
- `orders_rows_not_no_buyer_account = 0`: no schema, auth, non-retryable or other ORDERS_* failures. *(Code-derived.)*
- `orders_rows_company_nba = 0`: reconcile companies should have created every location account. *(Code-derived.)*
- `reconcile_rows = 0`. *(Code-derived.)*
- `orders_rows_tag_rule_nba = <TAGGED_NBA_EXPECTED>` (placeholder). See the S9-5 decision table.
- `customers_rows_held ≥ <DLQ_CUSTOMERS_BASELINE>` and `draft_orders_rows_held ≥ <DLQ_DRAFT_ORDERS_BASELINE>`. Take the baselines from the pre-redrive diagnostics. These topics are **held and must not drop** during an ORDERS-only redrive. They may grow with live traffic.
- `other_topic_rows`: compare with `<DLQ_OTHER_BASELINE>` (placeholder).

## 6. Placeholders to fill in before sign-off

| Placeholder | Source |
|---|---|
| `<REDRIVE_STARTED_AT_UTC>` | DevOps redrive workflow run start time. The script defaults to now − 24h. |
| `<SEED_RUN_CONFIRMED>` | Confirm that seed run `39940796127` (2026-10-23 16:10 IST) was not a dry run, and that it created the orders. |
| `<B2B_WITH_SHOPIFY_TERMS>` | Seed log "Orders with payment terms", or Shopify admin |
| `<NON_SEED_INVOICES_EXPECTED>`, `<AGING_BUCKETS_EXPECTED_NON_SEED>` | Real or manual orders on the store |
| `<TAGGED_INVOICES_EXPECTED>`, `<TAGGED_NBA_EXPECTED>` | Choose from S9-5 using the decision table in §2 |
| `<RETAIL_AND_TERMINAL_SKIPS_EXPECTED>` | Real or manual orders. The seed creates 0. |
| `<S16_PAYMENTS_EXPECTED>`, `<S16_SUGGESTED_EXPECTED>` | Synthetic CSV credit count, and the matcher output after upload |
| `<LIVE_RECEIPTS_DURING_WINDOW>` | Shopify webhook delivery logs |
| `<DLQ_CUSTOMERS_BASELINE>`, `<DLQ_DRAFT_ORDERS_BASELINE>`, `<DLQ_OTHER_BASELINE>` | Pre-redrive prod-diagnostics output, per shop |

## 7. Known risks and notes
- **Tagged orders may be lost permanently.** CUSTOMERS_* is held and reconcile has no customers stage. If `s8_tagged_customers` rows are missing, tagged ORDERS_* messages resolve as **retail** and are marked processed. Releasing CUSTOMERS_* later won't create those invoices without an orders re-process. Flag this to DevOps before the redrive if S9-5 shows 0.
- **SQL parity skips timezone validation.** An invalid `Shop.timezone` gives a different result in SQL than in TS, which falls back to Asia/Kolkata. P0-1 guards this.
- **Seeded Net60 orders reach the 60-day window around 2026-11-03 to 07 IST.** After that, ORDERS_* refetches return null without `read_all_orders`, as P0-4 tracks.
- **Table name mismatch.** The brief's `s16_rejected_matches` is actually `rejected_matches`.
- **Seed rework.** #77 is reworking the seed. The 15/30/5 seed numbers and the `seed-account-*` ids come from `seed.ts` @ c11ed11.
