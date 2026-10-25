# Data Retention Schedule — Net Terms Receivables

**Owner:** Raghav  
**Audited Commit:** `df77eae4f4abe0caf3fec2a94d339f83cc458403`  
**Last Updated:** 2026-10-25

---

## Retention Table

| Data | Where Stored | Retention / Trigger | Mechanism | Source |
|------|--------------|---------------------|-----------|--------|
| Unmatched bank-statement narrations | `Payment.narration`, `Payment.payerText` | 180 days from `valueDate` | pg_cron job `s22_purge_unmatched_narration` at 04:00 UTC daily; sets `narration='[RETENTION_PURGED]'`, `payerText=NULL` | `prisma/migrations/20261101000000_s22_followups/migration.sql:20-77`, `app/services/compliance/compliance.server.ts:40` |
| `customers/redact` (customer erasure) | `s8_tagged_customers`, `s8_draft_orders`, `s22_data_requests`, `Payment` (matched), `PayerAlias`, `BuyerAccount` | On Shopify webhook | Transaction in `redactCustomer()`: deletes tagged data, redacts matched payments (`narration='[REDACTED]'`), anonymizes BuyerAccount | `app/services/compliance/compliance.server.ts:314-425` |
| `customers/data_request` exports | `s22_data_requests.export_data` | 30 days from creation | pg_cron job `s22_purge_data_requests_cleanup` nightly + in-app purge on access via `purgeExpiredDataRequests()` | `prisma/migrations/20261024020000_s22_compliance/migration.sql:143-150`, `app/services/compliance/compliance.server.ts:699-710` |
| `shop/redact` (shop erasure) | All shop data | On Shopify webhook (48h after uninstall) | Transaction in `deleteShop()`: CASCADE deletes from `Shop` row plus explicit deletes for non-FK tables | `app/services/compliance/compliance.server.ts:126-250`, `app/routes/webhooks.compliance.tsx:211-250` |
| Processed webhooks | `s6_processed_webhooks` | 7 days | pg_cron job `s10_processed_webhooks_cleanup` at 04:00 UTC daily | `prisma/migrations/20261024010000_s10_drain_cron/migration.sql:183-189` |
| Webhook receipts | `webhook_receipts` | 30 days | pg_cron job `s20_webhook_receipts_cleanup` at 04:30 UTC daily | `prisma/migrations/20261025010000_s20_webhook_receipts/migration.sql:69-75` |
| ReminderLog entries | `ReminderLog` | Until shop/redact | CASCADE delete via `Shop` FK | `prisma/schema.prisma:192` (relation), no separate purge |
| Dead-letter queue | `s6_dead_letter` | 30 days | pg_cron job `s10_dlq_cleanup_weekly` at 03:00 UTC Sundays | `prisma/migrations/20261024010000_s10_drain_cron/migration.sql:176-180` |
| Order refetch null counts | `s10b_order_refetch_null` | 90 days | pg_cron job (see migration) + `deleteShop()` explicit delete | `prisma/migrations/20261024030000_s10b_nightly_reconcile/migration.sql` (purge), `app/services/compliance/compliance.server.ts:137-140` (shop delete) |
| Global email send counts | `s18_global_sends` | 35 days | pg_cron job `s18_global_sends_cleanup` at 05:00 UTC daily | `prisma/migrations/20261030000000_s18_payment_reminders/migration.sql:239-244` |
| Sessions (OAuth) | `Session` | Until logout, expiry, or uninstall | Deleted by `sessionStorage.deleteAllForShop()` on `app/uninstalled` and `shop/redact` webhooks | `app/routes/webhooks.app.uninstalled.tsx`, `app/routes/webhooks.compliance.tsx:217` |
| Offline tokens | `Session.accessToken`, `Session.refreshToken` | Until session deletion | Part of Session table; deleted with sessions | `prisma/schema.prisma:117-132` |
| Database backups | Supabase-managed | [Raghav to confirm] — Provider-controlled; Free tier: up to 7 days, paid tiers vary | Supabase backup retention; not app-controlled | [Supabase Backups docs](https://supabase.com/docs/guides/platform/backups) |
| Sentry error events | Sentry cloud | [Raghav to confirm] — Provider-controlled | Sentry data retention settings | [Sentry Data Retention docs](https://docs.sentry.io/product/accounts/quotas/#data-retention) |
| Worker logs | Cloudflare | [Raghav to confirm] — Provider-controlled | Cloudflare Workers Logpush or dashboard | [Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/) |

---

## Other pg_cron Jobs Found in Migrations

| Job Name | Schedule | Purpose | Migration |
|----------|----------|---------|-----------|
| `s10_drain_minute` | Every minute | Drain queue processing via pg_net | `20261024010000_s10_drain_cron/migration.sql:154-161` |
| `s10b_nightly_reconcile` | Daily 02:00 UTC | Nightly company/order reconciliation | `20261024030000_s10b_nightly_reconcile/migration.sql` |
| `s18_enqueue_reminders_hourly` | Hourly at :15 | Enqueue payment reminder messages | `20261030000000_s18_payment_reminders/migration.sql:229-235` |
| `s18_catchup_reminders` | See migration | Catch-up for delayed reminders | `20261112000000_s18_reminder_catchup/migration.sql` |
| `credit_status_daily_sweep` | Daily | Sweep credit status sync | `20261029010000_credit_status_daily_sweep/migration.sql` |

---

## Notes

1. **Matched payments:** Retain narration until explicitly redacted via `customers/redact` or `shop/redact`. No time-based purge for matched payments.

2. **Invoice records:** Retained for legal/tax compliance (typically 7+ years in India). Customer relationship is anonymized on `customers/redact`, but invoice rows preserved.

3. **pgmq queue tables:** Shop-scoped messages deleted by `deleteShop()` from `pgmq.q_s6_sync`, `pgmq.q_s6_bulk`, `pgmq.a_s6_sync`, `pgmq.a_s6_bulk` (lines 163-187 in `compliance.server.ts`).

4. **AuditEvent:** Deleted via CASCADE on `shop/redact`. No separate retention purge.

5. **S8 tagged customer PII minimisation:** When `tag_active=false` and no open invoices, `email` and `display_name` are nulled by `minimiseCustomerPiiIfInactive()` (`app/services/compliance/compliance.server.ts:970-995`).
