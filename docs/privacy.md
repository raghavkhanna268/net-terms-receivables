# Privacy Policy — Net Terms Receivables

**Effective Date:** [TBD: effective date]

**Last Updated:** [TBD: effective date]

---

## 1. Introduction

Net Terms Receivables ("the App", "we", "us") is a Shopify app that helps B2B wholesale merchants manage net-terms invoices, track credit limits, and match bank transfer payments. This Privacy Policy describes what data we collect, why we collect it, how we use it, and your rights.

**Legal Entity and Contact:**
- [TBD: legal entity] — Company name, address, and registration details
- **Contact Email:** [TBD: contact email]
- **Data Protection Officer:** [TBD: legal entity] (if applicable)

---

## 2. Data We Collect

### 2.1 Merchant (Shop) Data

| Data Category | Purpose | Source |
|---------------|---------|--------|
| Shop Configuration | App functionality (domain, currency, timezone, default terms) | Shopify OAuth / Admin API |
| OAuth Sessions | Authentication | Shopify OAuth |
| Online Session User Info | Session context for logged-in staff (first name, last name, email) | Shopify OAuth (online sessions) |

**Note:** Online session user info (staff first name, last name, email) is populated only for online sessions when a staff member is logged in. Offline sessions (used for background jobs) do not contain this user PII.

### 2.2 Buyer Account Data

| Data Category | Purpose | Source |
|---------------|---------|--------|
| Buyer Account | Credit management (account kind, display name, credit limit, terms, hold state) | Synced from Shopify |
| B2B Main Contact | Payment reminders for B2B accounts (email, display name, customer ID) | Synced from Shopify CompanyLocation mainContact |
| Reminder Opt-Out | Payment reminder preference (opt-out timestamp, opt-out source) | Buyer unsubscribe link or merchant toggle |
| Invoice | Receivables tracking (invoice name, amounts, due date, status) | Synced from Shopify orders |
| Payer Alias | Payment matching (normalized payer key) | Derived from bank statements |

**Note on B2B Main Contact:** For B2B (COMPANY) buyer accounts, the main contact's email and display name are stored for payment reminder emails. These fields require Shopify's Protected Customer Data (PCD) approval. The mainContactCustomerId links to the Shopify Customer GID for customers/redact matching.

**Note on Reminder Opt-Out:** When a buyer opts out of payment reminders (via unsubscribe link in email or merchant toggle), the opt-out record stores only a timestamp and a source ('link' or 'merchant'), linked to the buyer account. Opted-out buyers receive no reminder emails until a merchant re-enables reminders.

### 2.3 Tagged Customer Data

| Data Category | Purpose | Retention |
|---------------|---------|-----------|
| Tagged Customers | Tag-based buyer accounts (customer ID, tags, status, email, display name) | Until customer erasure or shop uninstall |
| Draft Orders | Pending credit exposure (draft order ID, buyer account, total, status) | Until draft completed/deleted |

**Note:** Email and display name fields require Shopify's Protected Customer Data (PCD) approval. These fields remain empty until approval is granted and the feature is enabled.

**PII Minimisation:** When a tagged customer becomes inactive and has no open invoices, their email and display name are automatically cleared.

### 2.4 Bank Statement Data

| Data Category | Purpose | Retention |
|---------------|---------|-----------|
| Payment | Payment reconciliation (value date, amount, rail, UTR) | Until shop uninstall |
| Payment (PII) | Payment matching (payer name, narration) | Until erasure or retention purge |
| Payer Alias | Payment matching (normalized payer key, buyer account link) | Until customer erasure or shop uninstall |

**Note:** Payment narration and payer text may contain personal data from bank statements. These fields are:
- Redacted during customer erasure requests if the payment is matched to the customer's buyer account
- Purged after **180 days** for **unmatched** payments via nightly automated job

**Retention purge details:**
- **What is purged:** Narration and payer text fields
- **What is kept:** Amount, UTR, rail, value date, and match history
- **Age calculation:** From bank statement date (value date), not import date
- **Schedule:** Daily at 04:00 UTC
- **Scope:** Unmatched payments only; matched payments retain narration until explicitly redacted via erasure request

### 2.5 Data Request Records

| Data Category | Purpose | Retention |
|---------------|---------|-----------|
| Data Requests | GDPR/CCPA compliance (shop ID, customer ID, request status, export data) | 30 days (data minimisation), then auto-purged |

### 2.6 Operational Data

| Data Category | Purpose |
|---------------|---------|
| Audit Events | Compliance and debugging (actor, action type, timestamp) |
| Reminder Logs | Prevent duplicate reminders (rule ID, invoice ID, sent timestamp, opt-out status) |
| Webhook Processing Records | Idempotent webhook processing |
| Failed Message Tracking | Error recovery |

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
- **Payload Shop Verification:** Compliance webhooks verify payload shop matches header shop to prevent forged deletions
- **TLS Encryption:** All data in transit uses TLS
- **OAuth 2.0:** Authentication with Shopify uses OAuth 2.0 with secure token storage
- **Session Isolation:** Sessions are isolated per shop with proper scoping
- **Input Validation:** Shop domain format validation on all webhook handlers
- **No PII in Logs:** Compliance webhook handlers do not log customer identifiers or personal data

---

## 5. Subprocessors

| Subprocessor | Purpose | Location | DPA |
|--------------|---------|----------|-----|
| Cloudflare, Inc. | Application hosting (Workers), connection pooling (Hyperdrive) | Global (Worker placed ap-south-1) | [TBD: DPA] |
| Supabase, Inc. | Database hosting (Postgres) | AWS ap-south-1 (Mumbai) | [TBD: DPA] |
| Resend, Inc. | Email delivery (data request notifications, payment reminders) | US | [Resend DPA](https://resend.com/legal/dpa) |
| Functional Software, Inc. | Error monitoring (Sentry) | [TBD] | [Sentry DPA](https://sentry.io/legal/dpa/) |

**Note:** Sentry is only active when error monitoring is enabled. Error events are scrubbed before transmission: request headers, cookies, query strings, and body data are removed; exception messages are replaced with error codes; breadcrumbs are deleted; and only allowlisted metadata keys (shopId, code, errorCode, requestId, webhookId, jobId, topic, status) are retained.

**Resend data handling:**

Data request notification emails:
- Contain **no customer PII** — only a notice and download link
- Shop owner email is fetched at send time from Shopify Admin API and passed directly to Resend; **never stored** in our database or logged

Payment reminder emails (sent to buyer email address):
- Recipient: buyer email address
  - For B2B (COMPANY) accounts: main contact email from the buyer account
  - For tagged customer accounts: email from the tagged customer record
- Invoice name (e.g. "#1001")
- Invoice total (formatted with shop currency)
- Invoice due date (formatted in shop timezone)
- Buyer display name (mainContactName or displayName, or "Customer" if not available)
- Shop name (derived from shop domain)
- Reminder type label (e.g. "Payment due today")

Resend is only used when email delivery is configured; emails are not sent otherwise

---

## 6. Data Retention

| Data Category | Retention Period | Deletion Trigger |
|---------------|------------------|------------------|
| OAuth Sessions | Until logout, expiry, or uninstall | App uninstall webhook or session expiry |
| Shop and Account Data | Until 48 hours after uninstall | Shop redact webhook (sent by Shopify 48h after uninstall) |
| Tagged Customer Data | Until customer erasure or shop redact | Compliance webhooks |
| B2B Main Contact (email, name, customer ID) | Until customer erasure or shop redact | Nulled on customer erasure when mainContactCustomerId matches; deleted with account on shop redact |
| Invoices | Retained (no customer-identifying fields) | Buyer relationship anonymized on customer erasure |
| Payments (matched) | Until shop redact | Narration/payer text redacted on customer erasure if linked to customer |
| Payments (unmatched narration) | **180 days** | Narration/payer text cleared daily; amounts/UTR/rail retained |
| Payer Alias | Until customer erasure or shop redact | Deleted on customer erasure for the customer's buyer account |
| Data Request Records | 30 days (data minimisation) | Purged automatically; also on customer or shop erasure |
| Audit Events | Until shop redact | Automatic cascade |

### 6.1 Data Retention After Deletion — Known Limitations

**Background job queue:** Background jobs for the shop are deleted when the shop's data is deleted. A job that is being processed at the exact moment of deletion may still be kept in a list of failed jobs afterwards; such leftover entries are purged automatically, up to about 37 days later.

**Database backups:** Supabase-managed database backups may retain deleted data for the provider's backup retention window (7–30 days depending on plan). See [Supabase Backups documentation](https://supabase.com/docs/guides/platform/backups).

**Shopify metafields:** The app's credit status field on Shopify Company records is not explicitly cleared by the app on uninstall or shop/redact. Per [Shopify metafield documentation](https://shopify.dev/docs/apps/build/metafields/definitions), when a user uninstalls an app, Shopify deletes its app-owned metafield definitions and temporarily retains the metafield values without a definition; cleanup of the retained data runs asynchronously (no guaranteed timeframe). Uninstalling the app removes the app's Shopify Functions, so the field value cannot affect checkout even if it persists temporarily.

---

## 7. GDPR/CCPA Compliance Webhooks

The app handles Shopify's mandatory compliance webhooks with full data purge and export capabilities:

### 7.1 App Uninstalled

When a merchant uninstalls the app:
1. All OAuth sessions for the shop are **immediately deleted**
2. The shop is marked as uninstalled (timestamp recorded)
3. Shop configuration and business data remain until shop redact

**Timing note:** Per [Shopify docs](https://shopify.dev/docs/apps/build/privacy-law-compliance), shop redact is sent 48 hours after uninstall. This grace period allows merchants to reinstall without data loss.

### 7.2 Customer Data Request

When a customer requests their data:
1. **Verify** payload shop matches header shop (returns 401 on mismatch)
2. **Look up** all customer data scoped to that shop:
   - Tagged customer data: ID, tags, status, email, display name
   - Draft orders linked to customer's buyer account
   - Buyer account details
   - Invoice history linked to buyer account
3. **Generate** JSON export with all found data
4. **Persist** data request record with status, export data, and 30-day expiration
5. **Notify** shop owner via email (if configured)
6. **Return** 200 (export available for merchant download)

**Data delivery:**
- **Primary:** In-admin download via data requests page (creates download, marks as downloaded on success)
- **Notification:** Email to shop owner via Resend API (if configured)
- **Retention:** Exports are retained for **30 days** (data minimisation), then purged automatically

**Shopify compliance deadline:** Per [Shopify compliance webhook documentation](https://shopify.dev/docs/apps/build/privacy-law-compliance#customers-data_request), merchants must provide the customer's data within **30 days** of receiving the request. Our 30-day export retention ensures exports remain available for the full compliance window.

**Email notification details:**
- Email contains ONLY a notice and link to the in-admin download page
- **NO customer PII** is included in the email (no ID, email, name, or tags)
- Shop owner email is fetched via Admin API at send time and **never stored or logged**
- If email is not configured, it is skipped and logged as skipped
- Email API failures do not fail the webhook (still returns 200, export still available)

### 7.3 Customer Redact

When a customer must be deleted (GDPR/CCPA erasure request):
1. **Verify** payload shop matches header shop (returns 401 on mismatch)
2. **All operations run in a single database transaction** for atomicity. If any step fails, the entire redaction rolls back, allowing Shopify's retry mechanism to safely re-execute.
3. **Delete** tagged customer row for the customer
4. **Null** B2B main contact fields on buyer accounts where mainContactCustomerId matches the customer:
   - mainContactEmail, mainContactName, mainContactCustomerId all set to NULL
   - No reminder emails can be sent to redacted contacts
5. **Delete** draft orders linked to customer's buyer account
6. **Delete** data request records for the customer (contains PII in export)
7. **Redact** payment fields for payments linked to customer:
   - Payer text cleared
   - Narration set to "[REDACTED]"
   - Preserved: amount, UTR, rail, value date, and all match history
   - Queries are shop-scoped for security
8. **Delete** payer alias rows for the customer's buyer account (learned payer keys)
9. **Anonymize** buyer account:
   - Set name to "Redacted Customer"
   - Modify customer ID to prevent FK conflicts
10. **Preserve** invoice records for legal/tax compliance (Invoice has no customer-identifying fields; buyer link is through anonymized buyer account)

**Legal retention reasoning:** Invoices must be retained for tax compliance (typically 7+ years in India). The invoice itself is a business record; the buyer link is anonymized.

### 7.4 Shop Redact

When 48 hours have passed after uninstall:
1. **Verify** payload shop matches header shop (returns 401 on mismatch)
2. **Delete** all OAuth sessions for the shop
3. **Delete** shop row — **all shop data cascades via database foreign key constraints**:
   - All buyer accounts, invoices, payments, matches
   - All tagged customers and draft orders
   - All data request records (exports purged even if not yet expired)
   - All audit events and operational data

**Message queue note:** Queued messages cannot be purged per-shop (documented limitation). Messages for deleted shops are safely ignored by the processor.

---

## 8. Data Subject Rights

Merchants and their customers have the following rights:

| Right | How to Exercise |
|-------|-----------------|
| Access | Customers: via Shopify's data request flow → merchants download from data requests page. Merchants: contact support. |
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
- **Email:** [TBD: contact email]
- **Address:** [TBD: legal entity]

---

## Appendix A: Shopify OAuth Scopes

The app requests the following scopes to provide its core features.

Per [Shopify Access Scopes documentation](https://shopify.dev/docs/api/usage/access-scopes) 'How it works' section: "Any scope that writes a resource also grants read access to it, so request the write scope only when your app needs both." We request only `write_*` scopes for resources we both read and write.

### Read Scopes (2)

| Scope | Purpose |
|-------|---------|
| `read_draft_orders` | View draft orders to calculate pending credit exposure |
| `read_payment_terms` | View payment terms on orders and company locations |

### Write Scopes (6)

| Scope | Purpose |
|-------|---------|
| `write_companies` | View and update B2B companies and locations for buyer account sync and credit status |
| `write_customers` | View and update customers for net-terms eligibility and credit status |
| `write_merchant_managed_fulfillment_orders` | Place fulfillment holds on orders from accounts that are overdue or on credit hold |
| `write_orders` | View orders for invoice tracking, mark as paid after bank payment matching, and add status tags |
| `write_payment_customizations` | Configure payment method visibility based on account status |
| `write_validations` | Configure checkout validation to enforce credit limits and holds |

**Protected Customer Data:** The `write_customers` scope (which implies `read_customers`) requires Shopify's Protected Customer Data (PCD) approval. Level 1 access plus Name and Email fields have been approved. The email and display name fields are fetched for tagged customers.
