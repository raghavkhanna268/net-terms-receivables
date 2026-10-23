# Aging Dashboard (S7)

This document describes the receivables aging dashboard implemented in S7.

## Overview

The aging dashboard shows outstanding invoices grouped by how long they've been past due. It provides:

1. **Shop-level summary**: Total outstanding and overdue amounts per currency, broken down by aging bucket
2. **Buyer ledger**: Per-buyer outstanding amounts with credit limit, hold status, and overdue totals
3. **Invoice drill-down**: Individual invoices for a selected buyer with order links

## Aging Buckets

Invoices are categorized into these buckets based on days past due:

| Bucket | Days Past Due | Description |
|--------|---------------|-------------|
| **Current** | ≤ 0 | Not yet due (due date is today or in the future) |
| **1-30** | 1-30 | 1 to 30 days past due |
| **31-60** | 31-60 | 31 to 60 days past due |
| **61-90** | 61-90 | 61 to 90 days past due |
| **90+** | ≥ 91 | Over 90 days past due |

### Boundary Rules

- **Due today = Current**: An invoice due on the "as of" date has 0 days past due and is in the Current bucket
- **1 day after due = 1-30**: An invoice 1 day past its due date is in the 1-30 bucket
- **Null due date = Current**: Invoices without a due date are treated as not yet due

### Timezone

All date calculations use the **Asia/Kolkata** timezone. The "as of" date is determined by the start of the current day in IST. This ensures consistent bucket assignment regardless of the server's local time.

## Amount Handling

All amounts are stored and calculated in **integer minor units** (paise for INR, cents for USD, etc.) to avoid floating-point precision issues.

- Database: `outstanding` column is `DECIMAL(14, 2)`
- SQL queries: Convert to paise with `(ROUND(outstanding * 100))::bigint`
- TypeScript: Use `bigint` for all arithmetic
- Display: Convert back to major units for formatting

### Shop Currency

Each shop has a single currency configured at setup. All invoices for a shop are in that currency. The dashboard displays amounts in the shop's configured currency.

### Multi-Currency Support

The data model supports multiple currencies in case a shop changes currency or for future multi-currency features. Amounts are **never summed across currencies** - each currency is tracked separately in all totals:

```typescript
interface AgingTotals {
  totalByCurrency: Map<string, bigint>;  // { INR: 10000000n, USD: 5000000n }
  overdueByCurrency: Map<string, bigint>;
  buckets: Record<AgingBucketKey, { byCurrency: Map<string, bigint> }>;
}
```

## SQL Aggregation

To stay within Cloudflare Workers' 10ms CPU budget, aging calculations are done in SQL rather than loading all invoices into JavaScript.

### Query Strategy

1. **Shop totals**: Single query with `GROUP BY currency, bucket`
2. **Buyer ledger**: Query with `GROUP BY buyerAccountId, currency`, paginated
3. **Invoice drill-down**: Simple filtered query, paginated

### Index Usage

The queries use existing indexes:
- `@@index([shopId, status, dueAt])` on Invoice - for filtering open invoices
- `@@index([buyerAccountId, status])` on Invoice - for per-buyer queries

## Gated Accounts (S21)

When plan gating is enforced (`PLAN_GATING_ENFORCED=true`), accounts with `gated_at IS NOT NULL` are:
- Excluded from the buyer ledger
- Excluded from shop totals
- Not counted in totals

When gating is not enforced, all accounts are shown with an `is_gated` flag.

## Reconciliation with Shopify Admin

### Equivalent Admin Filter

To verify our outstanding totals match Shopify's data, use this Admin Orders search query:

```
financial_status:pending OR financial_status:partially_paid
```

Then further filter manually for orders with payment terms (not all orders have net terms).

Or in the Admin UI:
1. Go to Orders
2. Filter by: **Payment status** = "Pending" or "Partially paid"
3. Manually check that orders have **Payment terms** set (Net 15, Net 30, etc.)

### What This Filters

- `financial_status:pending` - Orders awaiting full payment
- `financial_status:partially_paid` - Orders with partial payments received

Note: Shopify Admin search does not have a direct `payment_terms:any` filter. You can add it in GraphQL queries but not in the Admin search bar. The reconciliation helper uses GraphQL with a `paymentTerms` filter.

### Expected Match

Our `Invoice` records with `status = 'open'` and `outstanding > 0` should correspond to orders matching the above filter that have payment terms. The sum of `outstanding` amounts should match.

### Known Differences

1. **Timing**: Our data syncs via webhooks with a small delay
2. **Draft orders**: Not included in the filter (separate `S8DraftOrder` table)
3. **Cancelled orders**: May briefly appear before webhook processing
4. **Rounding**: Shopify shows rounded amounts; we use exact paise

## Dev Reconciliation Check

A reconciliation helper is available for development:

```bash
# Run the reconciliation test against the dev store
npm test -- app/lib/__tests__/aging-reconcile.test.ts
```

This test (requires `SHOPIFY_ADMIN_TOKEN`):
1. Queries Shopify for orders matching the filter above
2. Queries our database for open invoices
3. Compares totals and reports discrepancies

**Note**: This test is skipped in CI (no admin token). Run manually on the dev store to verify.

## Files

| File | Purpose |
|------|---------|
| `app/lib/aging.ts` | Pure bucket calculation functions |
| `app/lib/aging.test.ts` | Unit tests with boundary cases |
| `app/lib/aging-queries.server.ts` | SQL aggregation queries |
| `app/routes/app._index.tsx` | Dashboard UI |
| `app/routes/__tests__/app._index.test.ts` | Loader tests |

## Testing

```bash
# Run all aging tests
npm test -- app/lib/aging

# Run dashboard loader tests
npm test -- app/routes/__tests__/app._index.test.ts
```

### Test Coverage

- **Bucket boundaries**: Tests for exact boundary conditions (0, 1, 30, 31, 60, 61, 90, 91 days)
- **Multi-currency**: Tests that currencies are never mixed
- **Empty state**: Tests for no invoices
- **Pagination**: Tests for page, sortBy, sortOrder parameters
- **Error handling**: Tests for database errors and missing shop
