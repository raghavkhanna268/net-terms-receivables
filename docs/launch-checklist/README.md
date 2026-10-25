# Launch Checklist

Step-by-step checklists for launch prerequisites. Complete these before Shopify App Store review or first real merchant install.

## Checklists

| Document | Owner | Status |
|----------|-------|--------|
| [Sentry Setup](./sentry-setup.md) | Raghav | Pending |
| [Workers Paid Upgrade](./workers-paid-upgrade.md) | Raghav | Pending |
| [Request `read_all_orders` Scope](./read-all-orders-request.md) | Raghav | Pending |
| [Privacy Policy](/privacy) — Fill in `[TBD: ...]` placeholders in [docs/privacy.md](../privacy.md) and verify route is accessible | Raghav | Pending |
| `PLAN_GATING_ENFORCED` stays `"false"` in every environment until Raghav decides pricing and the Shopify plans are created. The go comes from Raghav via Wholesale Terms Builder. Enabling it gates new over-limit accounts and skips reminders for gated accounts (holds and aging are unaffected). | Raghav (decision), then DevOps | Holding |
| `RESEND_API_KEY` + `RESEND_FROM` set as Worker secrets and Resend DPA accepted, before any shop enables reminders | Raghav | Pending |
| Remove the pre-launch recipient allowlist guard (code change: Gates 10d/11c in reminders.server.ts, the check in resend-client.server.ts and compliance.server.ts). When set, RESEND_TEST_RECIPIENTS sends only to listed addresses; when empty or unset, it blocks ALL emails (fail-closed). Do NOT just unset or empty the var — that blocks everything. | Dev | Pending |

## Order of Operations

1. **Sentry Setup** — Create account, project, and submit DSN via secure channel. DevOps stores secrets.
2. **Workers Paid Upgrade** — Raghav upgrades the Cloudflare account ($5/month). DevOps redeploys after.
3. **`read_all_orders` Request** — Submit in Partner Dashboard. After approval, a separate PR adds the scope.
4. **Resend (S18 reminders)** — Raghav accepts the Resend DPA and supplies `RESEND_API_KEY` / `RESEND_FROM` via secure channel; DevOps sets them as Worker secrets. Only then may any shop enable reminders.

**Standing gate:** `PLAN_GATING_ENFORCED` remains `"false"` everywhere until Raghav decides pricing and the Shopify plans are created. The go comes from Raghav via Wholesale Terms Builder. Enabling it gates new over-limit accounts and skips reminders for gated accounts (holds and aging are unaffected).

## Related Documentation

- [listing/launch-checklist.md](../../listing/launch-checklist.md) — Full pre-launch checklist (all gates)

- [docs/scopes.md](../scopes.md) — OAuth scope audit with API call references
- [docs/privacy.md](../privacy.md) — Public privacy policy (rendered at `/privacy`)
- [docs/privacy-implementation.md](../privacy-implementation.md) — Internal implementation details and checklist
- [docs/ops.md](../ops.md) — Operations runbook
