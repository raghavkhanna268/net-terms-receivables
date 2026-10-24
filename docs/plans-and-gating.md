# Plans and Gating (S21)

This document describes the plan-based feature gating system implemented in S21.

## Overview

The app uses Shopify App Pricing (managed pricing) where plans are configured in the Partner Dashboard, not in code. This module maps subscription names to feature limits and enforces server-side gating.

**IMPORTANT**: The limits documented here are the **pricing HYPOTHESIS** from the tracker and are **NOT final**. Raghav decides final tier limits and pricing via the Partner Dashboard.

## Plan Tiers (Hypothesis)

| Plan | Companies | Imports/Month | Features |
|------|-----------|---------------|----------|
| **Free** | 3 | 1 | Aging dashboard |
| **Starter** | 25 | Unlimited | + Matching, Reminders |
| **Growth** | 100 | Unlimited | + Credit holds, PDF statements, Payer memory |
| **Scale** | Unlimited | Unlimited | + Audit export |

## Partner Dashboard Configuration

Plans must be configured in the Shopify Partner Dashboard with these exact names (case-insensitive):

- **Free** - The default plan for shops without an active subscription
- **Starter** - Entry-level paid plan
- **Growth** - Mid-tier plan with credit holds
- **Scale** - Enterprise plan with unlimited accounts

The app matches subscription names case-insensitively, so "Growth", "growth", "GROWTH" all map to the growth plan.

## Architecture

### Configuration

- `app/lib/entitlements.ts` - Plan definitions, feature keys, limit helpers
- `app/services/plan.server.ts` - Plan resolution from Shopify Admin API with caching
- `app/services/gating.server.ts` - Limit enforcement and feature checks

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PLAN_GATING_ENFORCED` | `"false"` | Set to `"1"` or `"true"` to enable limit enforcement |
| `APP_HANDLE` | `"net-terms-receivables"` | App handle for upgrade URL (must match Partner Dashboard) |

When `PLAN_GATING_ENFORCED` is OFF (default):
- Plan resolution works (cached from Shopify)
- Plan banner and usage display work
- Limits are NOT enforced (no gating, no blocking)

When `PLAN_GATING_ENFORCED` is ON:
- Over-limit accounts are gated (`gated_at` set)
- Gated accounts are excluded from limit count and enforcement
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
return requestContext.run({ getSql, waitUntil: (p) => ctx.waitUntil(p) }, async () => {
  return requestHandler(request, { ... });
});
```

The plan service retrieves `waitUntil` from the ALS context:

```typescript
// In plan.server.ts:
import { getRequestWaitUntil } from "~/lib/request-context.server";

const waitUntil = getRequestWaitUntil();
if (waitUntil) {
  waitUntil(refreshCacheInBackground());
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
   - Credit-limit edits (returns "Cannot edit gated accounts")
   - Account detail edits (UI shows read-only state)
   - Hold-only updates remain allowed (holds work on all plans)

5. On plan upgrade, gated accounts are reactivated:
   - Up to the new limit
   - Oldest accounts first (by `createdAt`)

### Downgrade Behavior

**Critical**: Downgrades NEVER delete data.

- Existing active accounts remain active
- Only NEW accounts over limit are gated
- Gated accounts preserve all data for potential reactivation

## Server-Side Gating

### Company Limit

Enforced when creating new BuyerAccounts (only when `PLAN_GATING_ENFORCED=true`):

```typescript
// If over limit, account is created with gated_at set
const shouldGate = isGatingEnforced() && !limitCheck.allowed;
```

**Concurrent webhook note**: The count-then-insert pattern in `checkCompanyLimit` can
slightly overshoot the limit under concurrent webhooks. This is acceptable because:
1. Gated accounts don't consume functional capacity
2. The slight overage will be gated by subsequent calls
3. Proper locking would add latency to every webhook

If exact enforcement is needed in the future, use `SELECT ... FOR UPDATE` on the
Shop row, but this is unlikely to be necessary for the current use case.

### Import Limit

The import limit enforcement is fully implemented in `gating.server.ts`:

- `checkImportLimit(sql, shopId)` - Returns whether an import is allowed
- `enforceImportLimit(sql, shopId)` - Throws `UpgradeRequiredError` if limit exceeded

**Already wired**: The import route (`app/routes/app.imports.tsx`) calls `enforceImportLimit()`
before creating a new `BankImport` record:

```typescript
// In app/routes/app.imports.tsx action():
import { enforceImportLimit, UpgradeRequiredError } from "~/services/gating.server";

await enforceImportLimit(sql, shopId);
// Creates BankImport and Payments...
```

When `PLAN_GATING_ENFORCED` is OFF, `enforceImportLimit()` is a no-op and always allows.

**Note**: Unlike company limits which gate accounts (persist but mark as inactive),
import limits simply block the operation since there's no persistent state to preserve.

**Important**: Import limits are a PLAN FEATURE, not a gated-account restriction. Even
shops with gated accounts can still import (up to their plan limit). Imports help with
payment matching which still works for gated accounts.

### Feature Checks

For features not yet implemented, export the feature key for later use:

```typescript
// Check if shop has a feature
const canUseCreditHolds = await checkFeature(sql, shopId, "credit_holds");
```

## Credit Holds on Downgrade

**TODO (S13)**: The `hasFeature('credit_holds')` check is exported but the Validation Function fail-open/fail-closed behavior on downgrade needs to be decided in S13.

This PR does NOT:
- Disable the Validation Function when credit_holds is unavailable
- Change any fail-open/fail-closed rules

## Bulk Ingestion

S10b reconcile/bulk ingestion applies the same gating as the webhook sync path:

- `bulkUpsertBuyerAccounts()` in `company-location.server.ts` checks `checkCompanyLimit()`
  for each new account and sets `gated_at` if over limit
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

All items from issue #57 have been addressed. Status summary:

| Item | Description | Status | Evidence |
|------|-------------|--------|----------|
| 1 | Background plan refresh wiring | Done on main | `workers/app.ts` passes `waitUntil` via ALS; `plan.server.ts` uses `getRequestWaitUntil()`. PRs #67, #149. Tests: `plan.test.ts`, `als-request-isolation.test.ts`. |
| 2 | Gated accounts exclusion from queries | Revised on main | Product decision (#127): gated accounts stay VISIBLE in ledger/UI, holds, aging. Only gated ACTIONS blocked. Tests: `gated-account-db.test.ts`, `plan-gating-actions-db.test.ts`. |
| 3 | S10b bulk/reconcile gating | Done on main | `bulkUpsertBuyerAccounts()` checks `checkCompanyLimit()` per-batch. PR #67. Tests: `company-location.test.ts`. |
| 4 | Import limit wiring | Done on main | `app/routes/app.imports.tsx:355` calls `enforceImportLimit()`. PR #69 tests. Tests: `gating.test.ts` (enforceImportLimit tests). |
| 5 | Migration hygiene (index drift) | Done on main | Migration `20261025000001_s21_fix_gated_at_index` creates regular index; schema uses `@@index([gatedAt], map: "BuyerAccount_gated_at_idx")`. PR #67. |
| 6 | Count-then-insert concurrency | Documented as acceptable | See "Concurrent webhook note" in Company Limit section above. Slight overshoot is acceptable; gated accounts don't consume functional capacity. |

**Scheduled reminders path**: The `s18_enqueue_reminders()` PL/pgSQL function includes
`ba.gated_at IS NULL` in its WHERE clause (migration `20261106000000_s18_enqueue_skip_gated`),
so gated accounts are skipped at enqueue time, not just at send time.
Tests: `s18-enqueue-skip-gated-db.test.ts`.

## Testing

Run tests with:
```bash
npm test -- --filter plan
npm test -- --filter gating
npm test -- --filter subscriptions_update
```

Test coverage includes:
- Plan resolution (no sub, active sub, unknown name, API error)
- Fail-to-cached behavior (use cached plan on error)
- Stale cache triggers background refresh via ALS `waitUntil`
- Cache TTL and webhook refresh
- Limit enforcement at boundaries (3rd vs 4th company on free)
- Gated account creation and reactivation on upgrade
- PLAN_GATING_ENFORCED on/off modes
- Feature checks per plan tier
- **Gated account visibility** (aging, ledger, invoices - `gated-account-db.test.ts`)
- **Gated action blocking** (reminders, credit edits - `plan-gating-actions-db.test.ts`)
- **Scheduled reminder filtering** (enqueue skips gated - `s18-enqueue-skip-gated-db.test.ts`)
- **Import limit enforcement** (`gating.test.ts`, `plan-gating-actions-db.test.ts`)
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

## Files Changed

- `app/lib/entitlements.ts` - Plan configuration
- `app/services/plan.server.ts` - Plan resolution service with fail-to-cached
- `app/services/gating.server.ts` - Limit enforcement with gating
- `app/routes/webhooks.app.subscriptions_update.tsx` - Webhook handler with reactivation
- `app/routes/app._index.tsx` - Plan banner UI
- `app/services/sync/company-location.server.ts` - Company gating on create
- `app/services/sync/customer.server.ts` - Customer gating on create
- `shopify.app.toml` - Webhook registration
- `prisma/schema.prisma` - Plan cache and gated_at columns
- `prisma/migrations/20261025000000_s21_plan_cache/migration.sql`
- `wrangler.jsonc` - PLAN_GATING_ENFORCED and APP_HANDLE env vars
