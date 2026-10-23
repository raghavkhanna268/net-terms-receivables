# S17 Acceptance Test Plan: Apply matched payment to order

**Status:** S17 is not built yet. As of `main` the schema has `Match`, `Invoice`, and `AuditEvent` tables, and `write_orders` scope is granted, but no apply logic exists. Everything below is **required behaviour**. The plan is grounded in:
- `prisma/schema.prisma` and `20261022000001_s5_data_model`:
  - `Match.state`: `suggested → confirmed → pushed`
  - `Invoice.outstanding` with CHECK `0 ≤ outstanding ≤ total`
  - `Invoice.status`: `open → paid`
  - `AuditEvent(shopId, actor, type, data, at)` for audit trail
  - `BuyerAccount.holdState` for credit hold (S11/S12)
- `shopify.app.toml` scopes: `write_orders` grants `orderMarkAsPaid`, `tagsAdd`, `tagsRemove`
- `docs/scopes.md`: S17 uses `orderMarkAsPaid` and order tagging
- `docs/metafields-contract.md`: Credit status metafields on Company/CompanyLocation and Customer

> **Assumptions (no spec in repo):**
> - Apply means: reduce `Invoice.outstanding`, mark `Match.state=pushed`, call `orderMarkAsPaid` if fully paid
> - Partial apply: reduces `outstanding` by match amount without marking order as paid
> - Idempotency: re-applying the same Match is a no-op
> - Undo: reverses the apply by restoring `outstanding` and Match state (if not yet pushed to Shopify)
> - Credit-hold release: when a HELD buyer pays down to below the limit, `holdState` transitions per S11/S12

## 1. Purpose
This plan verifies that:
- confirmed matches are correctly applied to invoices, reducing outstanding and updating Shopify orders
- partial applications work correctly without prematurely marking orders as paid
- apply operations are idempotent on retry
- credit holds are released when payments bring exposure below the limit
- a complete audit trail is maintained for compliance
- undo functionality works before the push is final
- no PII leaks into logs or audit data

## 2. Preconditions and fixtures (synthetic data only)
- **Shop:** `qa-shop-a.myshopify.com` with `currency='INR'`.
- **Buyer accounts:**
  - C1: `BuyerAccount(kind=COMPANY, holdState=HELD, creditLimit=₹50,000)`
  - T1: `BuyerAccount(kind=TAGGED_CUSTOMER, holdState=OK)`
- **Invoices:**
  - INV-001: `orderId=gid://shopify/Order/9001`, `total=₹10,000`, `outstanding=₹10,000`, `status=open`, `buyerAccountId=C1`
  - INV-002: `orderId=gid://shopify/Order/9002`, `total=₹25,000`, `outstanding=₹25,000`, `status=open`, `buyerAccountId=C1`
  - INV-003: `orderId=gid://shopify/Order/9003`, `total=₹15,000`, `outstanding=₹15,000`, `status=open`, `buyerAccountId=T1`
- **Payments and Matches:**
  - P1: `amount=₹10,000` with Match M1 to INV-001, `state=confirmed`, `score=100`
  - P2: `amount=₹5,000` with Match M2 to INV-002 (partial), `state=confirmed`, `score=90`
  - P3: `amount=₹15,000` with Match M3 to INV-003, `state=confirmed`, `score=95`
- **Shopify mock:** Mock `orderMarkAsPaid`, `tagsAdd`, `tagsRemove` mutations. Track calls for assertions.

## 3. Test cases

### A. orderMarkAsPaid and transaction semantics
| # | Steps | Expected |
|---|---|---|
| S17-01 | Apply M1 (full match) to INV-001. | `Invoice.outstanding=₹0`, `Invoice.status=paid`. `orderMarkAsPaid` called for Order 9001. `Match.state=pushed`. |
| S17-02 | Verify `orderMarkAsPaid` mutation payload. | Contains `id=gid://shopify/Order/9001`. Optional: `reason` or `note` field if API supports. |
| S17-03 | Shopify returns success for `orderMarkAsPaid`. | Transaction commits. DB and Shopify are consistent. |
| S17-04 | `orderMarkAsPaid` returns a userError because the order is **already paid** in Shopify (for example the merchant marked it paid by hand, or a retry after a lost response). | Treat as **idempotent success, not a failure**. Mark the invoice paid: `Invoice.outstanding = 0` and `status = 'paid'`. `Match.state` moves to the applied/pushed state. Write one `AuditEvent` (actor, matchId, invoiceId, and a reason code such as `ALREADY_PAID_IN_SHOPIFY`, with no PII). The apply is **not** undone or rolled back. Re-running produces no second AuditEvent and no double reduction. |
| S17-04b | `orderMarkAsPaid` returns any **other** error (for example ACCESS_DENIED, order not found, throttled after retries, or 5xx). | Transaction rolls back. `Invoice.outstanding` is unchanged. `Match.state` stays `confirmed`. The error is logged with codes and GIDs only. |
| S17-05 | Shopify returns error but partial DB write committed (split-brain). | **Must not happen.** Verify DB write is inside a transaction that commits only after Shopify success, OR apply is retryable/idempotent. |

### B. Partial apply
| # | Steps | Expected |
|---|---|---|
| S17-10 | Apply M2 (₹5,000) to INV-002 (₹25,000 outstanding). | `Invoice.outstanding=₹20,000`. `Invoice.status=open` (not fully paid). `Match.state=pushed`. `orderMarkAsPaid` NOT called. |
| S17-11 | Apply a second match (₹20,000) to INV-002. | `Invoice.outstanding=₹0`, `Invoice.status=paid`. `orderMarkAsPaid` called. |
| S17-12 | Multiple partial matches applied in one batch. | Each reduces `outstanding`. Final state is correct. Order marked paid only when `outstanding=0`. |
| S17-13 | Partial match amount exceeds remaining `outstanding`. | Rejected. CHECK constraint `outstanding >= 0` prevents negative. Error returned. |

### C. Idempotency on retry
| # | Steps | Expected |
|---|---|---|
| S17-20 | Apply M1. Then apply M1 again (retry). | Second apply is a no-op. `outstanding` unchanged. No duplicate `orderMarkAsPaid` call. No duplicate `AuditEvent`. |
| S17-21 | Match already in `pushed` state. Apply called. | No-op. Returns success (idempotent). |
| S17-22 | Network failure during first apply. Retry with same Match ID. | Safe retry. Exactly-once semantics. Document the idempotency key (Match ID or a dedicated column). |
| S17-23 | Concurrent apply calls for the same Match. | One succeeds, the other is a no-op. No double deduction. Use row lock or `UPDATE ... WHERE state='confirmed'`. |

### D. Credit-hold release (S11 metafields)
| # | Steps | Expected |
|---|---|---|
| S17-30 | C1 has `holdState=HELD`, exposure=₹55,000 (over ₹50,000 limit). Apply ₹10,000 payment. | Exposure drops to ₹45,000. `holdState` transitions to `OK` (or `NEAR_LIMIT` if configured). `AuditEvent(type='hold.released')` written. |
| S17-31 | After hold release, metafield on CompanyLocation is updated. | `credit_status.hold=false` (per `docs/metafields-contract.md`). Metafield write via `metafieldsSet`. |
| S17-32 | T1 is a TAGGED_CUSTOMER. Payment applied. T1 was HELD. | `holdState` checked and released if exposure is now below limit. Metafield on Customer updated. |
| S17-33 | Payment applied but exposure still over limit. | `holdState` stays `HELD`. No release event. |
| S17-34 | Buyer was on BYPASS. Payment applied. | `holdState` unchanged (BYPASS is manual override). Payment still applies normally. |

### E. Audit trail
| # | Steps | Expected |
|---|---|---|
| S17-40 | Apply M1. | `AuditEvent` written: `type='payment.applied'`, `actor='system'` or staff ID, `data` includes `{matchId, invoiceId, paymentId, amount, previousOutstanding, newOutstanding}`. |
| S17-41 | `orderMarkAsPaid` succeeds. | `AuditEvent` written: `type='order.marked_paid'`, `data` includes `{orderId, shopifyResponse}`. |
| S17-42 | Hold released due to payment. | `AuditEvent` written: `type='hold.released'`, `data` includes `{buyerAccountId, previousState, newState, reason:'payment'}`. |
| S17-43 | Audit events are immutable. | No `UPDATE` or `DELETE` on `AuditEvent` rows except S22 shop purge. |

### F. Undo
| # | Steps | Expected |
|---|---|---|
| S17-50 | Undo a `pushed` match for a NOT fully paid invoice. | `Invoice.outstanding` restored. `Match.state=unmatched` or `confirmed`. `AuditEvent(type='payment.unapplied')` written. |
| S17-51 | Undo a `pushed` match for a fully paid invoice (order already marked paid in Shopify). | Undo is blocked or requires manual Shopify reversal. Document the behaviour. `Invoice.status` cannot return to `open` if Shopify order is already paid. |
| S17-52 | Undo a `confirmed` (not yet pushed) match. | Match returns to `suggested` or is deleted. No Shopify impact. `outstanding` unchanged (was never reduced if apply only happens on push). |
| S17-53 | Concurrent undo and apply on the same Match. | One wins. No inconsistent state. Row lock or optimistic concurrency. |

### G. No PII leakage in logs
| # | Steps | Expected |
|---|---|---|
| S17-60 | Apply payment. Check logs. | Logs contain Match ID, Invoice ID, Payment ID, amounts, timestamps. **No** customer email, name, phone, address. **No** narration text. |
| S17-61 | Error during apply. Check error logs. | Error messages include IDs and error codes only. No PII. |
| S17-62 | Audit `data` JSON for all S17 events. | Contains only IDs, GIDs, amounts, states, reasons. No customer PII. |

### H. Order tagging (optional S17 feature)
| # | Steps | Expected |
|---|---|---|
| S17-70 | Invoice paid in full. | `tagsAdd(id: orderId, tags: ["ntr-paid"])` called. Order is tagged. |
| S17-71 | Invoice was overdue, now paid. | `tagsRemove(id: orderId, tags: ["ntr-overdue"])` called if that tag existed. |
| S17-72 | Partial payment on overdue invoice. | Tag may remain `ntr-overdue` or change to `ntr-partial`. Document the tagging strategy. |
| S17-73 | Tag mutation fails. | Payment apply still succeeds. Tagging is best-effort. Error logged. |

## 4. Data-minimization checks
Only **Level 1 plus email and name** may be stored. **Phone and address are a fail.**
- **DM-1:** `AuditEvent.data` for payment and order events contains only IDs, GIDs, amounts, states. No customer email, phone, address.
- **DM-2:** Apply logs print IDs and amounts only. No `Payment.narration`, no `Payment.payerText`.
- **DM-3:** `orderMarkAsPaid` mutation payload contains only the Order GID and optional reason text. Reason text must not include customer data.
- **DM-4:** Global schema scan finds no phone or address columns.

## 5. Vitest automation hints
- Unit-test `applyMatch(sql, matchId)` with mocked Shopify client. Assert DB state changes and Shopify calls.
- Integration: seed Invoice, Payment, Match; call apply; assert `outstanding`, `status`, `Match.state`, and `AuditEvent` rows.
- Mock `orderMarkAsPaid` to return success, error, or network timeout. Assert idempotency and rollback.
- For concurrency: `Promise.all` with two apply calls on the same Match. Assert exactly one success.
- For credit-hold release: set up HELD buyer with exposure, apply payment, assert `holdState` transition and `AuditEvent`.
- Spy on `console.*` to verify no PII in logs.

## 6. Done criteria
- [ ] S17-01 through S17-05 pass. `orderMarkAsPaid` is called correctly. Transaction semantics prevent split-brain.
- [ ] S17-10 through S17-13 pass. Partial apply reduces outstanding without marking order paid.
- [ ] S17-20 through S17-23 pass. Apply is idempotent on retry and concurrent-safe.
- [ ] S17-30 through S17-34 pass. Credit holds are released when exposure drops below limit. Metafields updated.
- [ ] S17-40 through S17-43 pass. Full audit trail for apply, order paid, and hold release events.
- [ ] S17-50 through S17-53 pass. Undo functionality is documented and tested.
- [ ] S17-60 through S17-62 pass. No PII in logs or audit data.
- [ ] S17-70 through S17-73 pass (if tagging is in scope). Order tags applied correctly.
- [ ] DM-1 through DM-4 pass.
