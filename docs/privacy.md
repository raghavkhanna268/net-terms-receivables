# Privacy Policy — Net Terms Receivables

**Effective Date:** **TBD**

**Last Updated:** **TBD**

---

## 1. Introduction

Net Terms Receivables ("the App", "we", "us") is a Shopify app that helps B2B wholesale merchants manage net-terms invoices, track credit limits, and match bank transfer payments. This Privacy Policy describes what data we collect, why we collect it, how we use it, and your rights.

**Legal Entity and Contact:**
- **TBD** — Company name, address, and registration details
- **Contact Email:** **TBD**
- **Data Protection Officer:** **TBD** (if applicable)

---

## 2. Data We Collect

### 2.1 Merchant (Shop) Data

| Data Category | Fields | Purpose | Source |
|---------------|--------|---------|--------|
| Shop Configuration | Domain, currency, timezone, default terms, uninstalled_at | App functionality | Shopify OAuth / Admin API |
| OAuth Sessions | Shop domain, access token, scopes, session state | Authentication | Shopify OAuth |
| Online Session User Info | First name, last name, email (staff user only) | Session context for logged-in staff | Shopify OAuth (online sessions) |

**Note:** Online session user info (staff first name, last name, email) is populated only for online sessions when a staff member is logged in. Offline sessions (used for background jobs) do not contain this user PII.

### 2.2 Buyer Account Data

| Data Category | Fields | Purpose | Source |
|---------------|--------|---------|--------|
| BuyerAccount | Account kind, company/location GID, customer GID, display name, credit limit, terms, hold state | Credit management | Synced from Shopify |
| Invoice | Order/draft order GID, invoice name, amounts, due date, status | Receivables tracking | Synced from Shopify orders |
| PayerAlias | Normalized payer key | Payment matching | Derived from bank statements |

### 2.3 Tagged Customer Data (S8)

| Data Category | Fields | Purpose | Retention |
|---------------|--------|---------|-----------|
| s8_tagged_customers | Customer GID, tags, tag_active, email*, displayName* | Tag-based buyer accounts | Until customers/redact or shop/redact |
| s8_draft_orders | Draft order GID, buyer account ref, total, status | Pending credit exposure | Until draft completed/deleted |

*Email and displayName are **gated** by `CUSTOMER_PII_FIELDS=1` env var, which requires Protected Customer Data (PCD) approval. Level 1 + Name and Email fields have been requested in the Partner Dashboard; the fields remain NULL until approval is granted and the flag is enabled.

**PII Minimisation (S22):** When a tagged customer becomes `tag_active=false` and has no open invoices, their email and displayName are automatically nulled.

### 2.4 Bank Statement Data

| Data Category | Fields | Purpose | Retention |
|---------------|--------|---------|-----------|
| Payment | Value date, amount, rail (NEFT/RTGS/IMPS/UPI), UTR | Payment reconciliation | Until shop/redact |
| Payment (PII) | Payer name/text, narration | Payment matching | Until shop/redact, customers/redact, or retention purge |
| PayerAlias | Normalized payer key, buyer account link | Payment matching | Until customers/redact or shop/redact |

**Note:** `Payment.narration` and `Payment.payerText` may contain personal data from bank statements. These fields are:
- Redacted to `[REDACTED]` during customers/redact if the payment is matched to the customer's buyer account
- Purged to `[RETENTION_PURGED]` after **180 days** (provisional) for **unmatched** payments via nightly pg_cron job

**Retention purge:** The `s22_purge_unmatched_narration` pg_cron job runs daily at 04:00 UTC and clears narration/payerText on unmatched payments older than the retention window. This preserves amounts, UTR, rail, value date, and status for reconciliation purposes while removing potentially PII-bearing text. Matched payments retain their narration until explicitly redacted via customers/redact or shop/redact.

**PROVISIONAL:** The 180-day retention window is provisional, pending product decision. See `UNMATCHED_NARRATION_RETENTION_DAYS` in `app/services/compliance/compliance.server.ts`.

### 2.5 Data Request Records (S22)

| Data Category | Fields | Purpose | Retention |
|---------------|--------|---------|-----------|
| s22_data_requests | Shop ID, customer GID, request ID, status, export JSON, expires_at | GDPR/CCPA compliance | 30 days (DPDP minimisation), then auto-purged |

### 2.6 Operational Data

| Data Category | Fields | Purpose |
|---------------|--------|---------|
| Audit Events | Actor, action type, timestamp, event data | Compliance and debugging |
| Reminder Logs | Rule ID, invoice ID, sent timestamp | Prevent duplicate reminders |
| s6_processed_webhooks | Webhook ID, topic, resource GID | Idempotent webhook processing |
| s6_dead_letter | Queue, message, error | Failed message tracking |
| s6_bulk_operations | Bulk operation ID, shop, type, byte offset | Chunked JSONL download progress |
| s10b_order_refetch_null | Shop domain, date, count | Aggregate null-refetch counter (no PII) |

---

## 3. How We Use Data

| Purpose | Legal Basis |
|---------|-------------|
| Provide core app functionality (invoicing, credit management, payment matching) | Contract performance |
| Send payment reminders to buyers | Contract performance |
| Error monitoring and debugging | Legitimate interest |
| Comply with Shopify App Store requirements | Legal obligation |
| Respond to GDPR/CCPA data requests | Legal obligation |

---

## 4. Data Storage and Security

### 4.1 Infrastructure

| Component | Provider | Location |
|-----------|----------|----------|
| Application Runtime | Cloudflare Workers | Edge (placed near AWS ap-south-1 Mumbai via region hint) |
| Database | Supabase Postgres | AWS ap-south-1 (Mumbai, India) |
| Database Connection | Cloudflare Hyperdrive | Pooled connection to Supabase |

### 4.2 Security Measures

- **HMAC-SHA256 Webhook Verification:** All Shopify webhooks are verified using HMAC-SHA256 with constant-time comparison
- **Payload Shop Verification:** Compliance webhooks verify payload `shop_domain` matches header shop to prevent forged deletions
- **TLS Encryption:** All data in transit uses TLS
- **OAuth 2.0:** Authentication with Shopify uses OAuth 2.0 with secure token storage
- **Session Isolation:** Sessions are isolated per shop with proper scoping
- **Input Validation:** Shop domain format validation on all webhook handlers
- **No PII in Logs:** Compliance webhook handlers do not log customer identifiers or personal data

---

## 5. Subprocessors

| Subprocessor | Purpose | Location | DPA |
|--------------|---------|----------|-----|
| Cloudflare, Inc. | Application hosting (Workers), connection pooling (Hyperdrive) | Global (Worker placed ap-south-1) | **TBD** |
| Supabase, Inc. | Database hosting (Postgres) | AWS ap-south-1 (Mumbai) | **TBD** |
| Resend, Inc. | Email delivery (data request notifications, payment reminders) | US | [Resend DPA](https://resend.com/legal/dpa) |

**Resend data handling:**
- Data request notification emails contain **no customer PII** — only a notice and download link
- Shop owner email is fetched at send time from Shopify Admin API and passed directly to Resend
- Shop owner email is **never stored** in our database or logged
- Resend setup (secrets) is handled in S18; S22 only uses the API if configured

---

## 6. Data Retention

| Data Category | Retention Period | Deletion Trigger |
|---------------|------------------|------------------|
| OAuth Sessions | Until logout, expiry, or uninstall | `app/uninstalled` webhook or session expiry |
| Shop and Account Data | Until 48 hours after uninstall | `shop/redact` webhook (sent by Shopify 48h after uninstall) |
| Tagged Customer Data | Until customers/redact or shop/redact | Compliance webhooks |
| Invoices | Retained (no customer-identifying fields) | Buyer relationship anonymized on customers/redact |
| Payments (matched) | Until shop/redact | Narration/payerText redacted on customers/redact if linked to customer via Match→Invoice→BuyerAccount |
| Payments (unmatched narration) | **180 days (provisional)** | Narration/payerText cleared nightly via pg_cron `s22_purge_unmatched_narration`; amounts/UTR/status retained |
| PayerAlias | Until customers/redact or shop/redact | Deleted on customers/redact for the customer's buyer account; cascades on shop/redact |
| Data Request Records | 30 days (DPDP minimisation) | Purged on next access, and nightly where pg_cron is enabled; also on customers/redact or shop/redact (CASCADE) |
| Audit Events | Until shop/redact | Automatic cascade |
| Bulk Operation Progress | Until operation completes or shop/redact | Automatic via S6 migration CASCADE |
| Order Refetch Null Counts | 90 days (rolling) | Purged nightly via pg_cron; all rows deleted on shop/redact |

---

## 7. GDPR/CCPA Compliance Webhooks (S22)

The app handles Shopify's mandatory compliance webhooks with full data purge and export capabilities:

### 7.1 `app/uninstalled`

When a merchant uninstalls the app:
1. All OAuth sessions for the shop are **immediately deleted** (`Session` table)
2. The shop is marked as uninstalled (`Shop.uninstalledAt` timestamp)
3. Shop configuration and business data remain until `shop/redact`

**Handler:** `app/routes/webhooks.app.uninstalled.tsx`

**Timing note:** Per [Shopify docs](https://shopify.dev/docs/apps/build/privacy-law-compliance), `shop/redact` is sent 48 hours after uninstall. This grace period allows merchants to reinstall without data loss.

### 7.2 `customers/data_request`

When a customer requests their data:
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

**Data delivery:**
- **Primary:** In-admin download via `/app/data-requests` route (fetches resource route, creates Blob, marks downloaded on success)
- **Notification:** Email to shop owner via Resend API (gated on `RESEND_API_KEY` and `RESEND_FROM` env vars)
- **Retention:** Exports are retained for **30 days** (DPDP minimisation), purged on next access and nightly where pg_cron is enabled

**Shopify compliance deadline:** Per [Shopify compliance webhook documentation](https://shopify.dev/docs/apps/build/privacy-law-compliance#customers-data_request), merchants must provide the customer's data within **30 days** of receiving the request. Our 30-day export retention ensures exports remain available for the full compliance window.

**Email notification details:**
- Email contains ONLY a notice and link to the in-admin download page
- **NO customer PII** is included in the email (no GID, email, name, or tags)
- Shop owner email is fetched via Admin API (`shop { email contactEmail }`) using the app's offline session at send time and **never stored or logged**
- If `RESEND_API_KEY` or `RESEND_FROM` is not set, email is skipped and logged as `data_request_email_skipped`
- Resend API failures do not fail the webhook (still returns 200, logs status code only, export still available)

**Handler:** `app/routes/webhooks.compliance.tsx`

### 7.3 `customers/redact`

When a customer must be deleted (GDPR/CCPA erasure request):
1. **Verify** payload `shop_domain` matches header shop (returns 401 on mismatch)
2. **Delete** `s8_tagged_customers` row for the customer
3. **Delete** `s8_draft_orders` linked to customer's buyer account
4. **Delete** `s22_data_requests` for the customer (contains PII in export)
5. **Delete** `PayerAlias` rows for the customer's buyer account (learned payer keys)
6. **Anonymize** `BuyerAccount`:
   - Set `name` to "Redacted Customer"
   - Append timestamp to `customerId` to prevent FK conflicts
7. **Redact** `Payment` fields (`payerText`, `narration`) for payments linked via Match→Invoice→BuyerAccount relationship (not pattern matching on customer ID)
8. **Preserve** `Invoice` records for legal/tax compliance (Invoice has no customer-identifying fields; buyer relationship is through BuyerAccount which is anonymized)

**Legal retention reasoning:** Invoices must be retained for tax compliance (typically 7+ years in India). The invoice itself is a business record; the buyer link is anonymized.

**Handler:** `app/routes/webhooks.compliance.tsx`

### 7.4 `shop/redact`

When 48 hours have passed after uninstall:
1. **Verify** payload `shop_domain` matches header shop (returns 401 on mismatch)
2. **Delete** all OAuth sessions for the shop
3. **Delete** `Shop` row — **all shop data cascades via ON DELETE CASCADE FKs**:
   - `AccountSource`, `BuyerAccount`, `BankImport`, `ReminderRule`, `AuditEvent`
   - `Invoice`, `Payment`, `Match`, `ReminderLog` (direct Shop FKs)
   - `s8_tagged_customers`, `s8_draft_orders` (S8 FKs)
   - `s22_data_requests` (S22 FK — exports purged even if not yet expired)

**pgmq messages:** Cannot be purged per-shop (documented limitation). Messages for deleted shops are safely ignored by the drain processor.

**Handler:** `app/routes/webhooks.compliance.tsx`

---

## 7.5 S10b Nightly Reconcile (Operational)

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

## 8. Data Subject Rights

Merchants and their customers have the following rights:

| Right | How to Exercise |
|-------|-----------------|
| Access | Customers: via Shopify's data request flow → merchants download from `/app/data-requests`. Merchants: contact support. |
| Rectification | Contact support |
| Erasure | Customers: via Shopify's erasure request flow. Merchants: uninstall the app. |
| Portability | Download via data request export (JSON format) |
| Objection | Contact support |

---

## 9. Third-Party Data Sharing

We do not sell personal data. Data is shared with subprocessors listed in Section 5 solely for providing the service.

---

## 10. Changes to This Policy

We may update this Privacy Policy from time to time. Material changes will be communicated through the app or via email to the merchant's registered contact.

---

## 11. Contact

For privacy inquiries:
- **Email:** **TBD**
- **Address:** **TBD**

---

## Appendix A: Shopify OAuth Scopes

**Current scopes:** `read_companies`, `read_orders`, `read_payment_terms`, `read_customers`, `read_draft_orders`

**Protected Customer Data:** The `read_customers` scope requires Shopify's Protected Customer Data (PCD) approval. Level 1 access plus Name and Email fields have been requested in the Partner Dashboard. Until approval is granted and `CUSTOMER_PII_FIELDS=1` is set, the email and displayName fields in `s8_tagged_customers` remain NULL.

---

## Appendix B: Launch Checklist

### Pre-Launch

- [ ] Complete Shopify Protected Customer Data (PCD) approval form
- [ ] Fill in **TBD** sections with actual company details
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

### Post-Launch Monitoring

- [ ] Monitor compliance webhook success rates
- [ ] Review data request exports for completeness
- [ ] Set up alerts for failed shop/redact operations
- [ ] Periodic audit of data retention compliance

---

*This privacy policy reflects the implemented S22 compliance code. All **TBD** items require product/legal decisions before publication.*
