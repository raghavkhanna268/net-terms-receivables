# Privacy Policy — Internal Implementation Details

> **Internal document.** This file contains engineering implementation details that map to the public privacy policy in `docs/privacy.md`. It is NOT rendered on the `/privacy` route.

---

## Database Schema Mapping

This section maps public privacy policy data categories to internal database tables and columns.

### Tagged Customer Data (S8)

| Table | Fields | Policy Section |
|-------|--------|----------------|
| s8_tagged_customers | Customer GID, tags, tag_active, email*, displayName* | 2.3 Tagged Customer Data |
| s8_draft_orders | Draft order GID, buyer account ref, total, status | 2.3 Tagged Customer Data |

*Email and displayName are **gated** by `CUSTOMER_PII_FIELDS=1` env var, which requires Protected Customer Data (PCD) approval. Level 1 + Name and Email fields have been requested in the Partner Dashboard; the fields remain NULL until approval is granted and the flag is enabled.

**PII Minimisation (S22):** When a tagged customer becomes `tag_active=false` and has no open invoices, their email and displayName are automatically nulled.

### Bank Statement Data

| Table | Fields | Policy Section |
|-------|--------|----------------|
| Payment | value_date, amount, rail (NEFT/RTGS/IMPS/UPI), utr | 2.4 Bank Statement Data |
| Payment (PII) | payerText, narration | 2.4 Bank Statement Data |
| PayerAlias | normalized payer key, buyerAccountId | 2.4 Bank Statement Data |

**Implementation notes:**
- `Payment.narration` and `Payment.payerText` may contain personal data from bank statements
- Redacted during customers/redact if the payment is matched to the customer's buyer account: `payerText` becomes `NULL` and `narration` becomes `[REDACTED]`. This happens in a single transaction scoped to the signed shop, ensuring atomicity (if any step fails, the entire redaction rolls back so Shopify's retry can re-execute safely).
- Purged to `[RETENTION_PURGED]` after **180 days** for **unmatched** payments via nightly pg_cron job

**Retention purge implementation:**
- **What is purged:** `narration` → `[RETENTION_PURGED]`, `payerText` → `NULL`
- **What is kept:** `amount`, `utr`, `rail`, `valueDate`, `status`, and match history
- **Age calculation:** From `valueDate` (bank statement date), not import date
- **Schedule:** Daily at 04:00 UTC (09:30 IST) via `s22_purge_unmatched_narration` pg_cron job
- **Scope:** Unmatched payments only; matched payments retain narration until explicitly redacted via customers/redact or shop/redact

**Configuration:** The 180-day retention window is configured in the `s22_unmatched_narration_retention_days()` SQL function in migration `20261101000000_s22_followups`. The TS constant `UNMATCHED_NARRATION_RETENTION_DAYS` in `app/services/compliance/compliance.server.ts` documents the same value for reference.

### Data Request Records (S22)

| Table | Fields | Policy Section |
|-------|--------|----------------|
| s22_data_requests | Shop ID, customer GID, request ID, status, export JSON, expires_at | 2.5 Data Request Records |

### Operational Data

| Table | Fields | Policy Section |
|-------|--------|----------------|
| AuditEvent | Actor, action type, timestamp, event data | 2.6 Operational Data |
| ReminderLog | Rule ID, invoice ID, sent timestamp | 2.6 Operational Data |
| s6_processed_webhooks | Webhook ID, topic, resource GID | 2.6 Operational Data |
| s6_dead_letter | Queue, message, error | 2.6 Operational Data |
| s6_bulk_operations | Bulk operation ID, shop, type, byte offset | 2.6 Operational Data |
| s10b_order_refetch_null | Shop domain, date, count | 2.6 Operational Data |

---

## Compliance Webhook Handlers

### `app/uninstalled` Handler

**Handler:** `app/routes/webhooks.app.uninstalled.tsx`

When a merchant uninstalls the app:
1. All OAuth sessions for the shop are **immediately deleted** (`Session` table)
2. The shop is marked as uninstalled (`Shop.uninstalledAt` timestamp)
3. Shop configuration and business data remain until `shop/redact`

### `customers/data_request` Handler

**Handler:** `app/routes/webhooks.compliance.tsx`

Implementation details for data export:
1. **Verify** payload `shop_domain` matches header shop (returns 401 on mismatch)
2. **Look up** all customer data scoped to that shop:
   - `s8_tagged_customers`: GID, tags, tag_active, email, displayName
   - `s8_draft_orders`: Draft orders linked to customer's buyer account
   - `BuyerAccount`: Account details (kind=TAGGED_CUSTOMER)
   - `Invoice`: Invoice history linked to buyer account (no LIMIT)
3. **Generate** JSON export with all found data
4. **Persist** `s22_data_requests` record with status, export data, and 30-day expiration
5. **Notify** shop owner via email (if configured)
6. **Return** 200 (export available for merchant download)

**Data delivery implementation:**
- **Primary:** In-admin download via `/app/data-requests` route (fetches resource route, creates Blob, marks downloaded on success)
- **Notification:** Email to shop owner via Resend API (gated on `RESEND_API_KEY` and `RESEND_FROM` env vars)
- **Retention:** Exports are retained for **30 days** (DPDP minimisation), purged on next access and nightly where pg_cron is enabled

**Email notification implementation:**
- Email contains ONLY a notice and link to the in-admin download page
- **NO customer PII** is included in the email (no GID, email, name, or tags)
- Shop owner email is fetched via Admin API (`shop { email contactEmail }`) using the app's offline session at send time and **never stored or logged**
- If `RESEND_API_KEY` or `RESEND_FROM` is not set, email is skipped and logged as `data_request_email_skipped`
- Resend API failures do not fail the webhook (still returns 200, logs status code only, export still available)

### `customers/redact` Handler

**Handler:** `app/routes/webhooks.compliance.tsx`

Implementation details for customer erasure:
1. **Verify** payload `shop_domain` matches header shop (returns 401 on mismatch)
2. **All operations run in a single database transaction** for atomicity. If any step fails, the entire redaction rolls back, allowing Shopify's retry mechanism to safely re-execute.
3. **Delete** `s8_tagged_customers` row for the customer
4. **Delete** `s8_draft_orders` linked to customer's buyer account
5. **Delete** `s22_data_requests` for the customer (contains PII in export)
6. **Redact** `Payment` fields for payments linked via Match→Invoice→BuyerAccount:
   - `payerText` → `NULL`
   - `narration` → `[REDACTED]`
   - Preserved: `amount`, `utr`, `rail`, `valueDate`, and all Match/RejectedMatch rows and AuditEvent history
   - Shop-scoped: queries include `p."shopId"`, `m."shopId"`, and `i."shopId"` predicates
7. **Delete** `PayerAlias` rows for the customer's buyer account (learned payer keys)
8. **Anonymize** `BuyerAccount`:
   - Set `name` to "Redacted Customer"
   - Append timestamp to `customerId` to prevent FK conflicts
9. **Preserve** `Invoice` records for legal/tax compliance (Invoice has no customer-identifying fields; buyer relationship is through BuyerAccount which is anonymized)

### `shop/redact` Handler

**Handler:** `app/routes/webhooks.compliance.tsx`

Implementation details for shop data deletion:
1. **Verify** payload `shop_domain` matches header shop (returns 401 on mismatch)
2. **Delete** all OAuth sessions for the shop
3. **Delete** `Shop` row — **all shop data cascades via ON DELETE CASCADE FKs**:
   - `AccountSource`, `BuyerAccount`, `BankImport`, `ReminderRule`, `AuditEvent`
   - `Invoice`, `Payment`, `Match`, `ReminderLog` (direct Shop FKs)
   - `s8_tagged_customers`, `s8_draft_orders` (S8 FKs)
   - `s22_data_requests` (S22 FK — exports purged even if not yet expired)

**pgmq messages:** Cannot be purged per-shop (documented limitation). Messages for deleted shops are safely ignored by the drain processor.

---

## Data Retention After Deletion — Known Limitations

### pgmq Message Queue

pgmq does not support per-shop message deletion. The `purgePgmqMessages` function in `app/services/compliance/compliance.server.ts` (lines 85–113) documents this limitation and returns a no-op:

```typescript
return {
  purged: false,
  reason:
    "pgmq does not support per-shop message deletion. Messages for deleted shops " +
    "are safely ignored by the drain processor which checks shop existence. " +
    "Messages expire naturally based on queue visibility timeout.",
};
```

Messages for deleted shops are safely ignored by the drain processor (which verifies shop existence before processing) and expire naturally based on queue visibility timeout.

### Supabase Database Backups

Supabase-managed database backups may retain deleted data for the provider's backup retention window:
- Pro Plan: 7 days of daily backups
- Team Plan: 14 days of daily backups
- Enterprise Plan: up to 30 days of daily backups

See [Supabase Backups documentation](https://supabase.com/docs/guides/platform/backups).

### Shopify App-Owned Metafields

The app's `credit_status` metafield (namespace `$app`, key `credit_status`) on Shopify Company records is not explicitly cleared by the app on uninstall or shop/redact.

Per [Shopify metafield documentation](https://shopify.dev/docs/apps/build/metafields/definitions):
> "When a user uninstalls your app, Shopify deletes its app-owned metafield definitions and temporarily retains the metafields and their values without a definition. This applies to any app-owned definition, whether declared in `shopify.app.toml` or created with the GraphQL Admin API. Cleanup of the retained data runs asynchronously."

**Impact:** Uninstalling the app removes the app's Shopify Functions (payment customization, checkout validation), so the `credit_status` metafield value cannot affect checkout behaviour even if it persists temporarily before Shopify's asynchronous cleanup removes it.

---

## S10b Nightly Reconcile (Operational)

The app performs nightly reconciliation to ensure local ledger consistency with Shopify:

1. **pg_cron** triggers at 02:00 UTC daily
2. Worker enqueues `RECONCILE_COMPANIES` messages per active shop
3. Bulk export downloads JSONL via HTTP Range chunking (CPU-safe)
4. After companies complete, `RECONCILE_ORDERS` is enqueued
5. Orders are upserted via the same S6 services as webhooks

**Data minimisation:**
- No drift report is generated or stored (removed in QA review)
- `s10b_order_refetch_null` stores only aggregate counts (shop, day, count) — **no order IDs or PII**
- 90-day retention purge via pg_cron job
- All rows deleted on shop/redact

**Order null-refetch handling:**
- Orders >60 days old may return null without `read_all_orders` scope
- These are counted but never marked deleted/paid/cancelled
- Last known invoice state is preserved

---

## Data Retention pg_cron Jobs

| Job Name | Schedule | Purpose |
|----------|----------|---------|
| s22_purge_unmatched_narration | Daily 04:00 UTC | Purge unmatched payment narration after 180 days |
| s22_purge_data_requests_cleanup | Nightly | Purge expired data request records (30-day retention) |
| s10b_refetch_null_cleanup | Nightly | Purge order refetch null counts (90-day rolling) |

---

## Protected Customer Data Configuration

**Environment variable:** `CUSTOMER_PII_FIELDS=1`

When enabled:
- `s8_tagged_customers.email` and `s8_tagged_customers.displayName` are populated from Shopify
- Requires Shopify PCD approval (Level 1 + Name and Email fields)

When disabled or unset:
- Email and displayName fields remain NULL
- Tag-based buyer accounts work without PII

---

## Implementation Checklist

### Pre-Launch

- [ ] Complete Shopify Protected Customer Data (PCD) approval form
- [ ] Fill in `[TBD: ...]` sections in `docs/privacy.md` with actual company details
- [ ] Set up DPAs with Cloudflare and Supabase
- [ ] Accept [Resend DPA](https://resend.com/legal/dpa) before enabling email notifications
- [ ] Configure data retention policies for audit events
- [ ] Decide on email delivery for data requests (currently in-admin only)
- [ ] Verify CUSTOMER_PII_FIELDS flag is off in production until PCD approval

### Technical Verification

- [ ] Run S22 migration on production database
- [ ] Verify FK constraints are in place (see `s22-compliance.test.ts`)
- [ ] Test all compliance webhooks with Shopify's compliance test tool
- [ ] Verify no PII appears in application logs
- [ ] Confirm pgmq message handling for deleted shops
- [ ] Verify `/privacy` route is accessible without authentication

### Post-Launch Monitoring

- [ ] Monitor compliance webhook success rates
- [ ] Review data request exports for completeness
- [ ] Set up alerts for failed shop/redact operations
- [ ] Periodic audit of data retention compliance
