# S7 Acceptance Test Plan: Per-buyer ledger and aging buckets

**Status:** S7 is not built yet. As of `main` the schema has the Invoice table with `outstanding`, `dueAt`, and `status` columns but no ledger aggregation or aging view exists. Everything below is **required behaviour**. The plan is grounded in:
- `prisma/schema.prisma` and `20261022000001_s5_data_model`:
  - `Invoice.outstanding` with CHECK `0 ≤ outstanding ≤ total`
  - `Invoice.dueAt` computed from S9 inference or Shopify schedule
  - `Invoice.status` is `open | paid | cancelled`
  - `BuyerAccount` has `shopId`, `kind`, `creditLimit`, `holdState`
  - `Payment` has `amount`, `status`, `valueDate`
  - `Match` links Payment to Invoice with `amount`, `state`
- `Shop.currency` defaults to `INR` and `Shop.timezone` defaults to `Asia/Kolkata`
- PR #28 (S6): Orders with payment terms become `Invoice` rows
- PR #32 (S8): Tagged customers become `BuyerAccount(kind=TAGGED_CUSTOMER)` with draft order exposure

> **Assumptions (no spec in repo):**
> - The ledger is a per-buyer aggregation of open invoices grouped by aging bucket
> - Aging buckets are: Current (not yet due), 1-30, 31-60, 61-90, 90+ days past due
> - Day boundaries use `Shop.timezone` (Asia/Kolkata) for IST-aware date arithmetic
> - Partial payments reduce `Invoice.outstanding` via confirmed `Match` rows
> - Refunds (negative adjustments) increase `Invoice.outstanding` or create credit
> - The ledger is recomputed idempotently on demand (no caching race conditions)

## 1. Purpose
This plan verifies that:
- the per-buyer ledger shows accurate aggregated outstanding amounts by aging bucket
- partial payments and refunds are correctly reflected in outstanding balances
- currency is consistently INR and timezone uses Asia/Kolkata day boundaries
- ledger computation is idempotent and safe under concurrent access
- multi-tenant isolation ensures shops never see each other's data
- performance stays within Workers Free 10 ms CPU limit

## 2. Preconditions and fixtures (synthetic data only)
- **Shop:** `qa-shop-a.myshopify.com` (primary) and `qa-shop-b.myshopify.com` (isolation tests) in `"Shop"` with `currency='INR'` and `timezone='Asia/Kolkata'`.
- **Buyer accounts:** 
  - C1: `BuyerAccount(kind=COMPANY)` with `companyLocationId=gid://shopify/CompanyLocation/7101`
  - T1: `BuyerAccount(kind=TAGGED_CUSTOMER)` with `customerId=gid://shopify/Customer/8001`
- **Invoices:** synthetic `Invoice` rows with:
  - Various `dueAt` values spanning all aging buckets (current, 1-30, 31-60, 61-90, 90+ days past due)
  - `total` in INR (e.g., ₹10,000.00, ₹25,000.00, ₹50,000.00)
  - `outstanding` values matching `total` initially, reduced by test payments
  - `status=open` for active invoices, `status=paid` and `status=cancelled` for edge cases
- **Payments and Matches:** synthetic `Payment` rows with `Match` allocations for partial payment tests
- **Timezone edge cases:** invoices with `dueAt` crossing IST midnight boundaries (IST = UTC+5:30)

## 3. Test cases

### A. Aging bucket calculation
| # | Steps | Expected |
|---|---|---|
| S7-01 | Invoice with `dueAt` tomorrow (shop timezone). | Bucket: **Current**. |
| S7-02 | Invoice with `dueAt` today at 23:59:59 IST. | Bucket: **Current** (not yet past due). |
| S7-03 | Invoice with `dueAt` yesterday. | Bucket: **1-30 days past due**. |
| S7-04 | Invoice with `dueAt` 15 days ago. | Bucket: **1-30 days past due**. |
| S7-05 | Invoice with `dueAt` 30 days ago. | Bucket: **1-30 days past due** (boundary). |
| S7-06 | Invoice with `dueAt` 31 days ago. | Bucket: **31-60 days past due**. |
| S7-07 | Invoice with `dueAt` 60 days ago. | Bucket: **31-60 days past due** (boundary). |
| S7-08 | Invoice with `dueAt` 61 days ago. | Bucket: **61-90 days past due**. |
| S7-09 | Invoice with `dueAt` 90 days ago. | Bucket: **61-90 days past due** (boundary). |
| S7-10 | Invoice with `dueAt` 91 days ago. | Bucket: **90+ days past due**. |
| S7-11 | Invoice with `dueAt` 180 days ago. | Bucket: **90+ days past due**. |
| S7-12 | Invoice with `dueAt=NULL` (no due date). | Bucket: **Current** or a distinct "No due date" category. Document the chosen behaviour. |

### B. Timezone handling (Asia/Kolkata day boundaries)
| # | Steps | Expected |
|---|---|---|
| S7-20 | Invoice due at 2026-10-23T00:00:00+05:30 (IST midnight). Query ledger at 2026-10-23T23:59:59+05:30. | Bucket: **Current** (same calendar day in IST). |
| S7-21 | Same invoice, query ledger at 2026-10-24T00:00:01+05:30. | Bucket: **1-30 days past due** (next IST day). |
| S7-22 | Invoice due at UTC midnight (2026-10-22T18:30:00Z = 2026-10-23T00:00:00+05:30). Verify IST day is used. | Bucket computed using IST, not UTC. |
| S7-23 | Shop with a different timezone (for future multi-region support). | Uses `Shop.timezone`, not hardcoded IST. |

### C. Partial payments
| # | Steps | Expected |
|---|---|---|
| S7-30 | Invoice total=₹10,000. No payments. | `outstanding=₹10,000`. Ledger shows ₹10,000 in the invoice's bucket. |
| S7-31 | Add confirmed Match for ₹3,000. | `outstanding=₹7,000`. Ledger shows ₹7,000. |
| S7-32 | Add second confirmed Match for ₹4,000. | `outstanding=₹3,000`. Ledger shows ₹3,000. |
| S7-33 | Add confirmed Match for ₹3,000 (fully paid). | `outstanding=₹0`. Invoice `status=paid`. Excluded from open ledger. |
| S7-34 | Overpayment: Match amount exceeds outstanding. | Rejected or creates credit. Document behaviour. `outstanding` never goes negative (CHECK constraint). |
| S7-35 | Suggested Match (not confirmed) for ₹5,000. | `outstanding` unchanged. Suggested matches do NOT reduce outstanding. |
| S7-36 | Match state transitions: suggested → confirmed → pushed. | Only `confirmed` and `pushed` reduce outstanding. |

### D. Refunds
| # | Steps | Expected |
|---|---|---|
| S7-40 | Invoice paid in full (`outstanding=₹0`, `status=paid`). Refund issued for ₹2,000. | `outstanding=₹2,000` or credit created. Document the refund model. |
| S7-41 | Partial refund on partially paid invoice. | `outstanding` increases by refund amount, up to `total`. |
| S7-42 | Refund exceeds original invoice total. | Rejected or handled as merchant credit. Document. |

### E. Currency (INR)
| # | Steps | Expected |
|---|---|---|
| S7-50 | All Invoice totals use INR (Decimal(14,2)). | Amounts display with ₹ symbol and 2 decimal places. |
| S7-51 | Ledger aggregation sums correctly across many invoices. | No floating-point errors. Use Decimal arithmetic. |
| S7-52 | Edge case: ₹0.01 outstanding amounts. | Displays correctly, rounds properly. |

### F. Idempotent recomputation
| # | Steps | Expected |
|---|---|---|
| S7-60 | Compute ledger twice with no changes. | Identical results. No side effects. |
| S7-61 | Concurrent ledger queries (two requests race). | Both return consistent results. No phantom reads. |
| S7-62 | Invoice updated between two ledger queries. | Second query reflects the update. No stale data returned after committed write. |
| S7-63 | Ledger query during a Match insert transaction. | Either sees the Match or not (serializable read), never partial state. |

### G. Multi-tenant isolation
| # | Steps | Expected |
|---|---|---|
| S7-70 | Shop A has invoices; Shop B queries ledger. | Shop B sees only its own data. Shop A's invoices are never visible. |
| S7-71 | Same buyer GID exists in both shops. | Each shop's ledger shows only its own Invoice rows. |
| S7-72 | SQL injection attempt in shop parameter. | Parameterised query prevents injection. 400 or empty result. |
| S7-73 | Authenticated session for Shop A spoofed to request Shop B data. | 403 or scoped to session's shop. |

### H. Performance (Workers Free 10 ms CPU)
| # | Steps | Expected |
|---|---|---|
| S7-80 | Ledger for buyer with 10 open invoices. | CPU < 5 ms. |
| S7-81 | Ledger for buyer with 100 open invoices. | CPU < 10 ms. |
| S7-82 | Ledger for buyer with 1,000 open invoices. | CPU < 10 ms or batched response. Document limit. |
| S7-83 | Full shop ledger (all buyers). | Query uses indexes. CPU within budget or paginated. |

## 4. Data-minimization checks
Only **Level 1 plus email and name** may be stored. **Phone and address are a fail.**
- **DM-1:** Ledger responses contain only: buyer account ID/name, bucket totals, invoice IDs, amounts, due dates. No customer email, phone, or address.
- **DM-2:** Ledger queries do not join to `s8_tagged_customers.email` or `display_name` unless explicitly needed for display and `CUSTOMER_PII_FIELDS=1`.
- **DM-3:** Audit logs for ledger access (if any) contain only shop ID, buyer account ID, timestamp. No PII.
- **DM-4:** Global schema scan finds no phone or address columns.

## 5. Vitest automation hints
- Unit-test `computeAgingBucket(dueAt, now, timezone)` with `it.each` over boundary cases.
- Mock `new Date()` or inject `now` parameter for deterministic timezone tests.
- Integration tests against CI Postgres: seed invoices with varied `dueAt`, call ledger endpoint, assert bucket assignments.
- For partial payment tests: create Invoice, insert Match rows, assert `outstanding` via `SELECT`.
- For concurrency: use `Promise.all` with two `postgres()` clients updating and reading simultaneously.
- For performance: use `performance.now()` around the handler's non-I/O work. Gate on `!process.env.CPU_BENCH` to avoid CI flakiness.

## 6. Done criteria
- [ ] S7-01 through S7-12 pass. All aging buckets are correctly assigned.
- [ ] S7-20 through S7-23 pass. Timezone handling uses `Shop.timezone` for IST day boundaries.
- [ ] S7-30 through S7-36 pass. Partial payments reduce outstanding correctly; only confirmed/pushed matches count.
- [ ] S7-40 through S7-42 pass. Refund model is documented and tested.
- [ ] S7-50 through S7-52 pass. INR currency with Decimal arithmetic.
- [ ] S7-60 through S7-63 pass. Ledger is idempotent and concurrent-safe.
- [ ] S7-70 through S7-73 pass. Multi-tenant isolation enforced.
- [ ] S7-80 through S7-83 pass. Performance within Workers Free limits.
- [ ] DM-1 through DM-4 pass.
