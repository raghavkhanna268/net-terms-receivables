# Plans and Gating (S21)

This document describes the plan-based account gating system implemented in S21.

## Overview

The app uses Shopify App Pricing (managed pricing) where plans are configured in the Partner Dashboard, not in code. This module maps subscription names to account limits and enforces server-side gating.

**Current State**: No feature gates. All features are available on every plan. The only enforcement is on the number of buyer accounts (companies) per plan. Bank statement imports are unlimited on all plans.

## Plan Tiers

| Plan | Companies | Imports/Month | Features |
|------|-----------|---------------|----------|
| **none** | 0 | Unlimited | All features |
| **starter** | 25 | Unlimited | All features |
| **growth** | 100 | Unlimited | All features |
| **unlimited** | Unlimited | Unlimited | All features |

The only difference between plans is the number of buyer accounts (companies) allowed.

## Partner Dashboard Configuration

Plans are configured in the Shopify Partner Dashboard with these exact names (case-insensitive):

- **Starter** - Entry-level paid plan ($9/mo or $90/yr, up to 25 accounts)
- **Growth** - Mid-tier plan ($19/mo or $190/yr, up to 100 accounts)
- **Unlimited** - Top-tier plan ($29/mo or $290/yr, unlimited accounts)

There is no free plan. Development and partner stores are free. 30-day trial on all plans. (see `listing/app-store-listing.md:45-49`)

The app matches subscription names case-insensitively, so "Growth", "growth", "GROWTH" all map to the growth plan.

## Architecture

### Configuration

- `app/lib/entitlements.ts` - Plan definitions, limit helpers
- `app/services/plan.server.ts` - Plan resolution from Shopify Admin API with caching
- `app/services/gating.server.ts` - Account limit enforcement

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PLAN_GATING_ENFORCED` | `"false"` | Set to `"1"` or `"true"` to enable account limit enforcement |
| `APP_HANDLE` | `"net-terms-receivables-1"` | App handle for upgrade URL (read from `APP_HANDLE` env var; must match Partner Dashboard) |

When `PLAN_GATING_ENFORCED` is OFF (default):
- Plan resolution works (cached from Shopify)
- Plan banner and usage display work
- Limits are NOT enforced (no gating)

When `PLAN_GATING_ENFORCED` is ON:
- Over-limit accounts are gated (`gated_at` set)
- Gated accounts are excluded from limit count
- On upgrade, gated accounts are reactivated (oldest first)

### Cache Strategy

Plans are cached in Postgres (`Shop.plan_key`, `Shop.plan_cached_at`) with a ~6 hour TTL:

1. On request, check if cache exists
2. If cache is fresh (< 6 hours), use cached plan
3. If cache is stale, return cached plan AND trigger background refresh via `ctx.waitUntil()`
4. **Staleness never lowers the tier** - we always return the last known plan

### Background Refresh Wiring

The background refresh uses AsyncLocalStorage (ALS) to access `ctx.waitUntil()` per-request.
This is wired in `workers/app.ts`:

```typescript
// In the fetch handler:
return requestContext.run({ getSql, waitUntil: (p) => ctx.waitUntil(p), env }, async () => {
  return requestHandler(request, { ... });
});
```

The plan service retrieves `waitUntil` from the ALS context:

```typescript
// In plan.server.ts:
import { getRequestWaitUntil } from "~/lib/request-context.server";

const waitUntil = getRequestWaitUntil();
if (waitUntil) {
  triggerBackgroundRefresh(sql, shopId, shopDomain);
}
```

This approach:
- Isolates each request's background tasks (no cross-request leaks)
- Works correctly with Cloudflare Workers' per-request lifecycle
- Avoids module-global state that could persist across requests in long-lived isolates

### Fail-to-Cached Design

On any error or fetch failure:
1. If a cached plan exists, use it (even if stale)
2. Only default to 'free' when NO plan was ever cached

This ensures shops are never incorrectly downgraded due to transient errors.

### Webhook Refresh

The `APP_SUBSCRIPTIONS_UPDATE` webhook triggers:

1. Immediate cache refresh
2. Reactivation of gated accounts up to the new limit (oldest first)

- Registered in `shopify.app.toml`
- Handled by `app/routes/webhooks.app.subscriptions_update.tsx`
- Uses `ctx.waitUntil()` for background processing
- Idempotent: safe to replay

## Gated Accounts

When `PLAN_GATING_ENFORCED` is ON and a new BuyerAccount would exceed the limit:

1. The account is created with `gated_at = NOW()` (persisted, not lost)
2. Gated accounts are excluded from:
   - Company limit count (for enforcement purposes only)

3. **Product rule: Gated accounts stay VISIBLE everywhere.** They are:
   - Included in ledger/UI display (with `is_gated` flag)
   - Included in aging totals and per-account rows
   - Subject to credit holds and hold recomputation
   - Eligible for invoice creation (orders still sync)
   - Included in payment matching

4. **Gated accounts are blocked from value-add actions only:**
   - Payment reminders (skipped at send time; skipped at enqueue time via `s18_enqueue_reminders`)
   - Credit-limit edits (returns error message about account being added after plan limit)
   - Account detail edits (UI shows read-only state)
   - Hold-only updates remain allowed (holds work on all plans)

5. On plan upgrade, gated accounts are reactivated:
   - Up to the new limit
   - Oldest accounts first (by `createdAt`)

6. **Tag reactivation edge case**: When a removed tag is re-added to a customer,
   the existing TAGGED_CUSTOMER account is reactivated (tag_active=true). This does
   NOT change `gated_at` - the account remains ungated if it was ungated when
   the tag was removed. This can push the active count over the limit because
   reactivation doesn't re-check the limit. This is by design: tag operations
   are controlled by the merchant's Shopify admin, not our app.

### Bank Statement Imports

Bank statement imports are **unlimited on all plans**. There is no import limit enforcement.
Even shops with gated accounts can import statements freely. Imports help with payment
matching which still works for gated accounts.

### Downgrade Behavior

**Critical**: Downgrades NEVER delete data.

- Existing active accounts remain active
- Only NEW accounts over limit are gated
- Gated accounts preserve all data for potential reactivation

## Server-Side Gating

### Company Limit

Enforced when creating new BuyerAccounts (only when `PLAN_GATING_ENFORCED=true`):

```typescript
// Caller looks up limit BEFORE sql.begin() to avoid stale cache refresh inside tx
const plan = await getPlanByShopId(sql, shopId);
const limit = planLimit(plan, "companies");

// decideNewAccountGate() inside sql.begin() takes the lock and decides gating
const decision = await decideNewAccountGate(tx, shopId, limit);
const shouldGate = decision.gate;
```

**T4 Concurrency**: All account creation paths use `pg_advisory_xact_lock` inside
transactions to prevent concurrent creates from overshooting the plan limit:

- Lock key: `hashtextextended('ba_limit:' || shopId, 0)`
- Lock is taken ONLY when `PLAN_GATING_ENFORCED=true` AND limit != -1
- `decideNewAccountGate(tx, shopId, limit)` - called inside `sql.begin()` for single creates
  (caller resolves limit before the transaction to avoid cache refresh on `tx`)
- `reactivateGatedAccounts(sql, shopId)` - uses the same lock for reactivation

Paths using this pattern:
- B2B webhook (`processCompanyLocationWebhook`)
- Bulk company reconcile (`bulkUpsertBuyerAccounts` - one tx per ≤25-row batch)
- Tagged-customer webhook (`syncTaggedCustomerBuyerAccount`)
- Bulk customer sync goes through `processBulkCustomer` → `syncTaggedCustomerBuyerAccount`

**Flag-off behavior**: When `PLAN_GATING_ENFORCED` is turned off:
- `decideNewAccountGate` returns `gate: false` (no new gating)
- `reactivateGatedAccounts` **still runs** and clears `gated_at` on upgrade
- All accounts are treated as active for enforcement purposes

Turning the flag back on re-enables gating: accounts that still have `gated_at` set
(e.g., accounts gated before an upgrade that hasn't been processed) remain gated until
reactivated on upgrade.

This ensures at most the plan's limit of accounts stay ungated under any concurrency scenario.

## Credit Holds

**Credit holds work on all plans.** Hold recomputation, the daily sweep (`enqueue_credit_status_recomputes`), and the checkout Validation Function run unconditionally regardless of plan.

## Bulk Ingestion

S10b reconcile/bulk ingestion applies the same gating as the webhook sync path:

- `bulkUpsertBuyerAccounts()` in `company-location.server.ts` checks `checkCompanyLimit()`
  once per batch (not per account) and sets `gated_at` on accounts that exceed the limit
- Customer bulk processing goes through `processBulkCustomer()` → `syncTaggedCustomerBuyerAccount()`
  which already applies gating

When `PLAN_GATING_ENFORCED` is OFF, bulk operations create all accounts without gating.
When ON, over-limit accounts are persisted with `gated_at` set, maintaining data integrity
while enforcing plan limits.

## UI Components

### Plan Banner

The app home page displays a plan banner showing:
- Current plan name
- Company usage (current / limit)
- Upgrade button (opens in parent frame with `target="_top"`)

### Upgrade URL

The managed pricing page URL format:
```
https://admin.shopify.com/store/{store_handle}/charges/{app_handle}/pricing_plans
```

The `app_handle` comes from `APP_HANDLE` env var.

## Status of #57 Items (Pre-Enable Checklist)

Items 1-6 from issue #57 are complete. Status summary:

| Item | Description | Status | Evidence |
|------|-------------|--------|----------|
| 1 | Background plan refresh wiring | Done on main | `workers/app.ts:44` passes `waitUntil` via ALS `requestContext.run()`; `plan.server.ts:319` uses `getRequestWaitUntil()`. PRs #67, #149. Tests: `plan.test.ts`, `als-request-isolation.test.ts`. |
| 2 | Gated accounts exclusion from queries | Revised on main | Product decision (#127): gated accounts stay VISIBLE in ledger/UI, holds, aging. Only gated ACTIONS blocked. Tests: `gated-account-db.test.ts`, `plan-gating-actions-db.test.ts`. |
| 3 | S10b bulk/reconcile gating | Done on main | `bulk-jsonl-processor.server.ts:420` calls `bulkUpsertBuyerAccounts()`; uses locked tx pattern with `pg_advisory_xact_lock`. PR #67. Tests: `company-location.test.ts`, `t4-account-gating-db.test.ts`. |
| 4 | Import limit wiring | Removed (T5) | Import limits removed; imports unlimited on all plans. |
| 5 | Migration hygiene (index drift) | Done on main | Migration `20261025000001_s21_fix_gated_at_index` creates regular index; `schema.prisma:286` uses `@@index([gatedAt], map: "BuyerAccount_gated_at_idx")`. No drift (`prisma migrate diff` shows "No difference detected"). PR #67. |
| 6 | Count-then-insert concurrency | Done (T4) | All account creation paths use `pg_advisory_xact_lock(hashtextextended('ba_limit:' || shopId, 0))` inside transactions. See "T4 Concurrency" in Company Limit section. Tests: `t4-account-gating-db.test.ts` section (d). |

**Scheduled reminders path**: The `s18_enqueue_reminders()` PL/pgSQL function does NOT
filter gated accounts. SQL enqueues all open due invoices regardless of `ba.gated_at`.
The TS send and catch-up paths (`sendPaymentReminder`, `sendCatchupReminder`) are the
sole gating point, checking `PLAN_GATING_ENFORCED` env var via `isAccountActive()`.

This design prevents SQL and TS from disagreeing on gating policy. The trade-off:
a gated invoice may be re-enqueued on its due day (Part 3) or within D+1..D+3 (Part 4),
but TS drops it before any Resend call, claim, or cap reservation. The re-enqueue is
bounded by the catch-up window.
Tests: `s18-enqueue-skip-gated-db.test.ts`.

## Test Coverage for Gated Account Behavior

Tests proving over-limit (gated) accounts stay visible and only gated actions are blocked:

### Gated Accounts Stay VISIBLE (with `PLAN_GATING_ENFORCED=true`)

| Area | Test File | Test Name |
|------|-----------|-----------|
| Aging totals | `gated-account-db.test.ts` | "getShopAgingTotals includes gated account's invoices" |
| Aging buckets | `gated-account-db.test.ts` | "aging totals include overdue gated account invoices in correct bucket" |
| Aging totals | `aging-reconcile.test.ts` | "shop totals include gated account rows with PLAN_GATING_ENFORCED=true" |
| Buyer ledger | `gated-account-db.test.ts` | "getBuyerLedger includes gated account with is_gated flag" |
| Invoice list | `gated-account-db.test.ts` | "getBuyerInvoices returns invoices for gated account" |
| Invoice eligibility | `gated-account-db.test.ts` | "gated account's order becomes an Invoice through eligibility check" |
| Credit holds | `gated-account-db.test.ts` | "gated account is auto-held when overdue via recompute" |
| Credit holds | `gated-account-db.test.ts` | "gated account hold clears after invoice is paid and recomputed" |
| Credit sweep | `gated-account-db.test.ts` | "gated account is included in sweep function when overdue" |
| Payment matching | `gated-account-db.test.ts` | "matcher suggests match for gated account's invoice" |
| Payment matching | `gated-account-db.test.ts` | "confirmMatch succeeds for gated account" |

### Gated ACTIONS Are Blocked (with `PLAN_GATING_ENFORCED=true`)

| Action | Test File | Test Name |
|--------|-----------|-----------|
| Reminders (send) | `s18-enqueue-skip-gated-db.test.ts` | "flag true skips gated account on send path with no claim/cap" |
| Reminders (catch-up) | `s18-enqueue-skip-gated-db.test.ts` | "flag true skips gated account on catch-up path with no claim/cap" |
| SQL enqueues | `s18-enqueue-skip-gated-db.test.ts` | "SQL enqueues gated account (TS gates)" |
| Credit-limit edit | `plan-gating-actions-db.test.ts` | "rejects credit-limit edit on gated account when gating ON" |
| Hold-only allowed | `plan-gating-actions-db.test.ts` | "allows hold-only update on gated account when gating ON (holds work on all plans)" |

### Gating OFF Behavior (with `PLAN_GATING_ENFORCED=false`)

| Area | Test File | Test Name |
|------|-----------|-----------|
| Reminders (send) | `s18-enqueue-skip-gated-db.test.ts` | "flag false sends to gated account on send path" |
| Reminders (catch-up) | `s18-enqueue-skip-gated-db.test.ts` | "flag false sends to gated account on catch-up path" |
| Credit-limit edit | `plan-gating-actions-db.test.ts` | "allows credit-limit edit on gated account when gating OFF" |
| Company limit | `gating.test.ts` | "checkCompanyLimit with gating OFF" (allows all) |
| Active fragment | `gating.test.ts` | "returns TRUE fragment when gating is OFF" |
| isAccountActive | `gating.test.ts` | "returns true for all accounts when gating is OFF" |
| Bulk gating | `company-location.test.ts` | "does not gate new accounts when PLAN_GATING_ENFORCED=false" |

## Testing

Run tests with:
```bash
npm test -- app/services/__tests__/plan.test.ts
npm test -- app/services/__tests__/gating.test.ts
npm test -- -t "subscriptions_update"
```

Test coverage includes:
- Plan resolution (no sub, active sub, unknown name, API error)
- Fail-to-cached behavior (use cached plan on error)
- Stale cache triggers background refresh via ALS `waitUntil`
- Cache TTL and webhook refresh
- Limit enforcement at boundaries (3rd vs 4th company on free)
- Gated account creation and reactivation on upgrade
- PLAN_GATING_ENFORCED on/off modes
- **Gated account visibility** (aging, ledger, invoices - `gated-account-db.test.ts`)
- **Gated action blocking** (reminders, credit edits - `plan-gating-actions-db.test.ts`)
- **Scheduled reminder filtering** (enqueue skips gated - `s18-enqueue-skip-gated-db.test.ts`)
- **Bulk ingestion gating** (`company-location.test.ts`)

## Database Schema

S21 adds these columns to the `Shop` table:

| Column | Type | Description |
|--------|------|-------------|
| `plan_key` | TEXT NOT NULL DEFAULT 'free' | Cached plan key |
| `subscription_id` | TEXT | Shopify subscription GID |
| `subscription_name` | TEXT | Raw subscription name from Shopify |
| `is_test` | BOOLEAN NOT NULL DEFAULT false | Whether this is a test subscription |
| `plan_cached_at` | TIMESTAMPTZ | When the cache was last refreshed |

S21 adds this column to the `BuyerAccount` table:

| Column | Type | Description |
|--------|------|-------------|
| `gated_at` | TIMESTAMPTZ | When this account was gated. NULL means active. |

Migration: `prisma/migrations/20261025000000_s21_plan_cache/migration.sql`

## Scopes

App Pricing requires no additional OAuth scopes. The 11 production scopes remain unchanged.
