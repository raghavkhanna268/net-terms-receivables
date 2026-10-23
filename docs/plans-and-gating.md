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

## Architecture

### Configuration

- `app/lib/entitlements.ts` - Plan definitions, feature keys, limit helpers
- `app/services/plan.server.ts` - Plan resolution from Shopify Admin API with caching
- `app/services/gating.server.ts` - Limit enforcement and feature checks

### Cache Strategy

Plans are cached in Postgres (`Shop.plan_key`, `Shop.plan_cached_at`) with a ~6 hour TTL:

1. On request, check if cache is fresh (< 6 hours old)
2. If fresh, use cached plan (no Shopify API call)
3. If stale or missing, fetch from `currentAppInstallation.activeSubscriptions`
4. Update cache after successful fetch

### Webhook Refresh

The `APP_SUBSCRIPTIONS_UPDATE` webhook triggers immediate cache refresh:

- Registered in `shopify.app.toml`
- Handled by `app/routes/webhooks.app.subscriptions_update.tsx`
- Uses `ctx.waitUntil()` for background refresh (respects 10ms CPU budget)
- Idempotent: safe to replay

## Fail-to-Free Design

Any error or unknown state defaults to the 'free' plan:

- Shop not found → free
- No active subscription → free
- Unknown subscription name → free (logged to Sentry)
- API error → free (logged to Sentry)

This ensures shops are never locked out but may have reduced features until resolved.

## Server-Side Gating

### Company Limit

Enforced when creating new BuyerAccounts:

```typescript
// In company-location.server.ts and customer.server.ts
const limitCheck = await checkCompanyLimit(sql, shopId);
if (!limitCheck.allowed) {
  return {
    success: false,
    error: `Upgrade required: company limit reached (${limitCheck.currentUsage}/${limitCheck.limit})`,
  };
}
```

### Import Limit

Enforced when creating new BankImports (per calendar month in IST):

```typescript
const limitCheck = await checkImportLimit(sql, shopId);
if (!limitCheck.allowed) {
  throw new UpgradeRequiredError("importsPerMonth", limitCheck.currentUsage, limitCheck.limit);
}
```

### Feature Checks

For features not yet implemented, export the feature key for later use:

```typescript
// Check if shop has a feature
const canUseCreditHolds = await checkFeature(sql, shopId, "credit_holds");
```

## Downgrade Behavior

**Critical**: Downgrades NEVER delete data.

- Over-limit shops keep read access to all existing records
- Only blocked from creating NEW records that exceed the limit
- Existing BuyerAccounts, Invoices, Payments all preserved

Example: A shop with 50 companies downgrades from Growth to Free:
- ❌ Cannot create company #51 (limit is 3)
- ✅ Can still view and manage all 50 existing companies
- ✅ Can still create invoices for existing companies

## Credit Holds on Downgrade

**TODO (S13)**: The `hasFeature('credit_holds')` check is exported but the Validation Function fail-open/fail-closed behavior on downgrade needs to be decided in S13.

This PR does NOT:
- Disable the Validation Function when credit_holds is unavailable
- Change any fail-open/fail-closed rules

The decision of what happens to active credit holds when a shop downgrades from Growth to Starter/Free is deferred to S13.

## UI Components

### Plan Banner

The app home page displays a plan banner showing:
- Current plan name and badge
- Company usage (current / limit)
- Upgrade button (links to managed pricing page)

### Upgrade URL

The managed pricing page URL format:
```
https://admin.shopify.com/store/{store_handle}/charges/{app_handle}/pricing_plans
```

The `app_handle` comes from `APP_HANDLE` env var (defaults to `net-terms-receivables`).

## Testing

Run tests with:
```bash
npm test -- --filter plan
npm test -- --filter gating
npm test -- --filter subscriptions_update
```

Test coverage includes:
- Plan resolution (no sub, active sub, unknown name, API error)
- Cache TTL and webhook refresh
- Limit enforcement at boundaries (3rd vs 4th company on free)
- Downgrade-keeps-data behavior
- Feature checks per plan tier

## Database Schema

S21 adds these columns to the `Shop` table:

| Column | Type | Description |
|--------|------|-------------|
| `plan_key` | TEXT | Cached plan key (free, starter, growth, scale) |
| `subscription_id` | TEXT | Shopify subscription GID |
| `subscription_name` | TEXT | Raw subscription name from Shopify |
| `is_test` | BOOLEAN | Whether this is a test subscription |
| `plan_cached_at` | TIMESTAMPTZ | When the cache was last refreshed |

Migration: `prisma/migrations/20261025000000_s21_plan_cache/migration.sql`

## Scopes

App Pricing requires no additional OAuth scopes. The 11 production scopes remain unchanged.

## Files Changed

- `app/lib/entitlements.ts` - Plan configuration
- `app/services/plan.server.ts` - Plan resolution service
- `app/services/gating.server.ts` - Limit enforcement
- `app/routes/webhooks.app.subscriptions_update.tsx` - Webhook handler
- `app/routes/app._index.tsx` - Plan banner UI
- `app/services/sync/company-location.server.ts` - Company limit check
- `app/services/sync/customer.server.ts` - Company limit check
- `shopify.app.toml` - Webhook registration
- `prisma/schema.prisma` - Plan cache columns
- `prisma/migrations/20261025000000_s21_plan_cache/migration.sql`
