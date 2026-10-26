# Payment Matching (S16)

This document describes the payment matching algorithm for matching Indian bank transfer payments (NEFT/RTGS/IMPS/UPI) to customer invoices.

## Overview

The matcher is **confirm-only** (v1). It produces match suggestions but does NOT apply any changes to orders or invoices. Confirmed matches are stored with `state: 'confirmed'` for S17 to apply later via `orderMarkAsPaid`.

## Scoring Weights

Each potential match is scored 0-100 based on these factors:

| Factor | Points | Description |
|--------|--------|-------------|
| Invoice/Order ref | +30 | Invoice name or order number in narration |
| Exact amount match | +20 | Payment amount equals outstanding |
| Partial amount | +10 | Payment < outstanding (partial payment) |
| Overpayment | +10 | Payment > outstanding (reduced, flags excess) |
| Payer alias match | +30 | Normalized payer matches confirmed alias |
| Payer name match | +8 | Fuzzy match on buyer company name |
| Email match | +6 | Email prefix found in payer text |

**Score capped at 100.**

**NOTE**: UTR matching is NOT awarded at the payment-to-candidate level because the UTR is extracted from the payment's own narration and would give the same score to every candidate. UTR is used for deduplication at import time only.

## Confidence Thresholds

- **High confidence (≥80)**: Invoice ref + amount match + name match. Can be auto-confirmed if enabled.
- **Medium confidence (50-79)**: Amount + name match. Requires merchant review.
- **Low confidence (<50)**: Ambiguous. Manual review required.

## Name Normalization

Payer names and buyer names are normalized for matching:

1. Remove prefixes: `M/S`, `M/S.`, `MS`, `SHRI`, `SMT`
2. Remove suffixes: `PVT`, `PRIVATE`, `LTD`, `LIMITED`, `LLC`, `INC`, `CORP`, `LLP`
3. Remove punctuation: `.`, `,`, `-`, `_`, `(`, `)`
4. Normalize whitespace
5. Convert to lowercase

Example: `"M/S. ACME INDUSTRIES PVT. LTD."` → `"acme industries"`

## Invoice Reference Extraction

The matcher extracts potential invoice references from payment narrations using **strict patterns** to avoid false positives from phone numbers, dates, or amounts:

| Pattern | Example | Extracted |
|---------|---------|-----------|
| `#<number>` | `#1001` | `1001` |
| `INV-<number>` | `INV-1001` | `1001` |
| `D<number>` | `D1001` | `1001` |
| `ORDER-<number>` | `ORDER-1001` | `1001` |
| `ORD-<number>` | `ORD-789012` | `789012` |
| `PO-<number>` | `PO-123456` | `123456` |
| `REF-<5+ digits>` | `REF-12345` | `12345` |

**Excluded patterns (false positives)**:
- 10-digit phone numbers (standalone)
- 8-digit date-like sequences (YYYYMMDD, DDMMYYYY starting with 19/20)
- 4-digit year-like numbers (1900-2100)
- Numbers ending in `00` without explicit prefix (amount-like)

## Multi-Invoice Matching

When a payment doesn't match a single invoice exactly, the matcher attempts subset-sum matching:

1. Get all open invoices for the identified buyer (sorted by due date, oldest first)
2. Find combinations that sum to the payment amount
3. Prefer allocating to oldest-due invoices first

**Caps for bounded combinatorics:**
- `MAX_INVOICES_FOR_SUBSET_SUM`: 15 invoices considered per buyer
- `MAX_SUBSET_SUM_ITERATIONS`: 10,000 iterations maximum

If the combination exceeds these limits, the matcher falls back to single-invoice best match.

## Overpayment Handling

When payment exceeds invoice outstanding:
- Allocate full outstanding amount to invoice
- Flag excess as `excessPaise` in match reasons
- Merchant reviews and decides: apply to next invoice, hold as credit, or flag for refund

## Partial Payment Handling

When payment is less than invoice outstanding:
- Allocate full payment amount to invoice
- Mark as `isPartial: true`
- Invoice remains open with reduced outstanding (applied in S17)

## Duplicate Detection

The matcher prevents duplicate imports:
- `Payment.utr` has unique constraint per shop
- Re-importing same UTR is rejected at import time
- Already-matched payments are skipped during matching run

## Idempotent Operations

All matcher actions are idempotent:
- `runMatcher`: Clears existing suggested matches before creating new ones
- `confirmMatch`: Only confirms `state: 'suggested'` matches
- `rejectMatch`: Only rejects `state: 'suggested'` matches

## Over-Allocation Protection

The `confirmMatch` function runs in a **transaction with FOR UPDATE locks** to prevent over-allocation:

1. Locks the payment row and calculates remaining unallocated amount
2. Locks all match rows for this payment (ORDER BY id for consistent lock order)
3. Locks all invoice rows (ORDER BY id for consistent lock order)
4. Queries ALL confirmed matches across ALL payments for the locked invoices
5. Caps the allocation at the smaller of: requested amount, remaining payment, remaining invoice
6. **Drops competing suggestions** for the same payment (other buyers, plus same-buyer suggestions that no longer fit)
7. Updates payment status to `partial` or `matched` based on total allocations
8. Learns PayerAlias from the confirmed match

This ensures that concurrent confirms cannot:
- Allocate more than the payment amount across all invoices
- Allocate more than an invoice's outstanding balance across all payments
- Leave competing suggestions for a fully-allocated payment

## Pushed vs Confirmed Allocation Handling

Match states for allocation tracking:

| State | Payment-side | Invoice-side | Description |
|-------|--------------|--------------|-------------|
| `confirmed` | ✓ Counted | ✓ Counted | Merchant confirmed, awaiting S17 push |
| `pushed` | ✓ Counted | ✗ Not counted | S17 applied, Invoice.outstanding already reduced |

**Why the difference?**

- **Payment-side**: The payment amount is fixed. Both `confirmed` and `pushed` allocations consume the payment, so we count both to calculate remaining payment capacity.

- **Invoice-side**: When S17 pushes a match, it calls `orderMarkAsPaid` which reduces `Invoice.outstanding`. Counting `pushed` allocations again would double-count because the outstanding is already lowered. We only count `confirmed` allocations that haven't yet been applied to the invoice balance.

This ensures accurate cap calculations when:
1. Multiple payments target the same invoice
2. Some matches are pushed while others are still confirmed

## Gated Account Handling

Gated accounts (`gated_at IS NOT NULL`) are **not excluded** from matching, confirm, apply, or unmatch.
The `activeAccountFragment` helper must NOT be used in matching or apply queries.

Per `gating.server.ts:51-56`, gating applies only to these 3 actions:

| Action | File:Line | Effect |
|--------|-----------|--------|
| Reminders | `reminders.server.ts:528` | `isAccountActive()` skips gated accounts |
| Credit-limit edits | `app.accounts.$id.tsx:299` | Rejects non-hold edits on gated accounts |
| Account editing | `app.accounts.$id.tsx:299` | Same guard as credit-limit |

New accounts exceeding the plan limit are created with `gated_at` set:
- `sync/company-location.server.ts:255-259`
- `sync/customer.server.ts:412-414`

## Payer Aliases

The `PayerAlias` table stores normalized payer keys mapped to buyer accounts:
- **Created ONLY on merchant confirm** - never from unconfirmed fuzzy matches
- Used for future lookups to bypass fuzzy matching
- Key format: normalized payer name (lowercase, suffixes stripped, min 3 characters)

## Rejected Pairs

The `rejected_matches` table persists merchant rejections:
- When a merchant rejects a suggested match, the payment-invoice pair is recorded
- Rejected pairs are **never re-suggested** by subsequent matcher runs
- Prevents the same bad suggestion from reappearing after re-import or matcher re-run
- Uses UPSERT semantics (rejecting the same pair twice just updates the rejector)

## Rail-Specific Parsing

Payment rails have different narration formats:

### NEFT
- UTR: `[A-Z]{4}N\d{11,17}` (e.g., `HDFCN26296123456`)
- Format: `NEFT CR-<PAYER>-<REF>` or `NEFT/<UTR>/<PAYER>/<REF>`

### RTGS
- UTR: `[A-Z]{4}R\d{11,17}` (e.g., `HDFCR26296123456`)
- Format: Similar to NEFT with `R` prefix

### IMPS
- RRN: 12 digits (e.g., `123456789012`)
- Format: `IMPS-<RRN>-<PAYER>-<BANK>`

### UPI
- RRN: 12 digits
- VPA: `user@handle` (e.g., `merchant@upi`)
- Format: `UPI-<MERCHANT>-<VPA>-<IFSC>-<RRN>-UPI`

### Cheque/CLG
- No UTR (cheque numbers go in `refNo`, not matched as UTR)
- Format: `CHQ <NUMBER> <DESCRIPTION>` or `CLG-<NUMBER>-<DESCRIPTION>`

### ACH/NACH
- No UTR (ACH reference numbers not globally unique)
- Format: `ACH D- TP ACH <COMPANY>-<REF>`

## S17 Handoff

When S17 applies confirmed matches:

1. Read `Match` rows with `state: 'confirmed'`
2. Call Shopify `orderMarkAsPaid` for matched orders
3. Update `Invoice.outstanding` and `Invoice.status`
4. Update `Match.state` to `'pushed'`
5. Create audit event for compliance

## Review Queue UI

The reconciliation UI (`/app/reconcile`) provides:

1. **Suggested matches**: List of pending matches for review
2. **Unmatched payments**: Payments with no suggestions
3. **Payment detail view**: All suggestions for one payment
4. **Actions**: Confirm / Reject / Edit allocation

All actions are POST requests (idempotent, shop-scoped).

## Runtime Considerations

For Cloudflare Workers Free tier (10ms CPU budget):

1. **SQL-prefiltered batches**: Candidate invoices filtered by shop + amount window + open status in SQL
2. **Amount window**: 0.5x to 2x payment amount
3. **Bounded combinatorics**: MAX_INVOICES_FOR_SUBSET_SUM and MAX_SUBSET_SUM_ITERATIONS
4. **Batch processing**: **MAX_PAYMENTS_PER_REQUEST = 10** (hard cap per request)
5. **Heavy matching via pgmq**: For large imports, run via job queue
6. **hasMore flag**: Returns true when more payments await processing (use offset for pagination)

## Data Privacy

- No PII beyond PCD Level 1 (customer name and email only)
- `narration` and `payerText` contain raw bank statement data (payer names only)
- Match `reasons` contain only match types, amounts, and normalized tokens
- No customer phone or address extracted or stored
- `CUSTOMER_PII_FIELDS` controls whether email/name fields are used for matching

## Configuration

Environment variables:
- `PLAN_GATING_ENFORCED`: Exclude gated accounts from matching
- `CUSTOMER_PII_FIELDS`: Enable email/name matching from s8_tagged_customers

Scoring constants (in `app/lib/matching/score.ts`):
- `CONFIDENCE_THRESHOLD`: 80 (high confidence threshold)
- `MAX_INVOICES_FOR_SUBSET_SUM`: 15
- `MAX_SUBSET_SUM_ITERATIONS`: 10000
