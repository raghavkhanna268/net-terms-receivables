# Payment Matching (S16)

This document describes the payment matching algorithm for matching Indian bank transfer payments (NEFT/RTGS/IMPS/UPI) to customer invoices.

## Overview

The matcher is **confirm-only** (v1). It produces match suggestions but does NOT apply any changes to orders or invoices. Confirmed matches are stored with `state: 'confirmed'` for S17 to apply later via `orderMarkAsPaid`.

## Scoring Weights

Each potential match is scored 0-100 based on these factors:

| Factor | Points | Description |
|--------|--------|-------------|
| UTR/Reference match | +40 | UTR found in payment matches narration |
| Invoice/Order ref | +30 | Invoice name or order number in narration |
| Exact amount match | +20 | Payment amount equals outstanding |
| Partial amount | +10 | Payment < outstanding (partial payment) |
| Overpayment | +20 | Payment > outstanding (flags excess) |
| Payer alias match | +10 | Normalized payer matches stored alias |
| Payer name match | +8 | Fuzzy match on buyer company name |
| Email match | +6 | Email prefix found in payer text |

**Score capped at 100.**

## Confidence Thresholds

- **High confidence (≥80)**: UTR match OR invoice ref + amount match. Can be auto-confirmed if enabled.
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

The matcher extracts potential invoice references from payment narrations:

| Pattern | Example | Extracted |
|---------|---------|-----------|
| `#<number>` | `#1001` | `1001` |
| `INV-<number>` | `INV-1001` | `1001` |
| `D<number>` | `D1001` | `1001` |
| `ORDER-<number>` | `ORDER-1001` | `1001` |
| 4-10 digit number | `12345678` | `12345678` |

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

## Gated Account Exclusion

When `PLAN_GATING_ENFORCED=true`:
- Invoices for gated buyer accounts are excluded from matching
- Gated buyers are excluded from `getBuyersWithAliases`
- Uses `activeAccountFragment(sql)` consistently

## Payer Aliases

The `PayerAlias` table stores normalized payer keys mapped to buyer accounts:
- Created manually by merchant or auto-generated on high-confidence name match
- Used for future lookups to bypass fuzzy matching
- Key format: normalized payer name (lowercase, suffixes stripped)

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
4. **Batch processing**: Default 50 payments per matcher run
5. **Heavy matching via pgmq**: For large imports, run via job queue

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
