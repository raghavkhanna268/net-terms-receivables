# Launch Checklist

Step-by-step checklists for launch prerequisites. Complete these before Shopify App Store review or first real merchant install.

## Checklists

| Document | Owner | Status |
|----------|-------|--------|
| [Sentry Setup](./sentry-setup.md) | Raghav | Pending |
| [Workers Paid Upgrade](./workers-paid-upgrade.md) | Raghav | Pending |
| [Request `read_all_orders` Scope](./read-all-orders-request.md) | Raghav | Pending |

## Order of Operations

1. **Sentry Setup** — Create account, project, and submit DSN via secure channel. DevOps stores secrets.
2. **Workers Paid Upgrade** — Raghav upgrades the Cloudflare account ($5/month). DevOps redeploys after.
3. **`read_all_orders` Request** — Submit in Partner Dashboard. After approval, a separate PR adds the scope.

## Related Documentation

- [docs/scopes.md](../scopes.md) — OAuth scope audit with API call references
- [docs/privacy.md](../privacy.md) — Privacy policy and data handling
- [docs/ops.md](../ops.md) — Operations runbook
