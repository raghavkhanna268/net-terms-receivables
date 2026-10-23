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
| Shop Configuration | Domain, currency, timezone, default terms | App functionality | Shopify OAuth / Admin API |
| OAuth Sessions | Shop domain, access token, scopes, session state | Authentication | Shopify OAuth |
| Online Session User Info | First name, last name, email (staff user only) | Session context for logged-in staff | Shopify OAuth (online sessions) |

**Note:** Online session user info (staff first name, last name, email) is populated only for online sessions when a staff member is logged in. Offline sessions (used for background jobs) do not contain this user PII.

### 2.2 Buyer Account Data

| Data Category | Fields | Purpose | Source |
|---------------|--------|---------|--------|
| BuyerAccount | Account kind, company/location GID, customer GID, display name, credit limit, terms, hold state | Credit management | Synced from Shopify |
| Invoice | Order/draft order GID, invoice name, amounts, due date, status | Receivables tracking | Synced from Shopify orders |
| PayerAlias | Normalized payer key | Payment matching | Derived from bank statements |

**Protected Customer Data (2026-10-23):** Level 1 + Name + Email fields approved. No phone, no address.

Customer PII stored in `s8_tagged_customers`:
- Customer GID (Shopify identifier)
- Customer tags (for net-terms eligibility matching)
- Email and display name (`CUSTOMER_PII_FIELDS=1` enabled in production)
- **Never stored:** Phone, addresses, firstName, lastName, defaultAddress (blocked in code, regardless of PCD level)

**Uses for PII fields:**
- S8: Labels in buyer account UI
- S16: Payment matching against bank statement payer names
- S18: Payment reminder emails

**Merged (S6/S8):** The app syncs:
- Company and CompanyLocation data (B2B accounts)
- Order data with payment terms for Invoice creation
- Tagged customers with email/displayName for payment matching

### 2.3 Bank Statement Data

| Data Category | Fields | Purpose | Retention |
|---------------|--------|---------|-----------|
| Payment | Value date, amount, rail (NEFT/RTGS/IMPS/UPI), UTR | Payment reconciliation | **TBD** |
| Payment (PII) | Payer name/text, narration | Payment matching | **TBD** — may contain payer names and identifiers |

**Retention Policy:** **TBD** — A retention policy for `Payment.narration` and `Payment.payerText` fields (which may contain personal data from bank statements) is pending.

### 2.4 Operational Data

| Data Category | Fields | Purpose |
|---------------|--------|---------|
| Audit Events | Actor, action type, timestamp, event data | Compliance and debugging |
| Reminder Logs | Rule ID, invoice ID, sent timestamp | Prevent duplicate reminders |

---

## 3. How We Use Data

| Purpose | Legal Basis |
|---------|-------------|
| Provide core app functionality (invoicing, credit management, payment matching) | **TBD** — Contract performance / Legitimate interest |
| Send payment reminders to buyers | **TBD** — Contract performance / Consent |
| Error monitoring and debugging | **TBD** — Legitimate interest |
| Comply with Shopify App Store requirements | **TBD** — Legal obligation |

---

## 4. Data Storage and Security

### 4.1 Infrastructure

| Component | Provider | Location |
|-----------|----------|----------|
| Application Runtime | Cloudflare Workers | Edge (placed near AWS ap-south-1 Mumbai via region hint) |
| Database | Supabase Postgres | AWS ap-south-1 (Mumbai, India) |
| Database Connection | Cloudflare Hyperdrive | Pooled connection to Supabase |

### 4.2 Security Measures In Place

- **HMAC-SHA256 Webhook Verification:** All Shopify webhooks are verified using HMAC-SHA256 with constant-time comparison (see `app/lib/webhook-verify.server.ts`)
- **TLS Encryption:** All data in transit uses TLS (Cloudflare and Supabase enforce HTTPS/TLS)
- **OAuth 2.0:** Authentication with Shopify uses OAuth 2.0 with secure token storage
- **Session Isolation:** Sessions are isolated per shop with proper scoping
- **Input Validation:** Shop domain format validation on all webhook handlers

### 4.3 Planned Security Measures

- **Sentry Error Monitoring:** Package installed (`@sentry/cloudflare`), DSN configuration pending (no-op without DSN)
- **⚠️ Pending:** Supabase keep-alive cron (S10) to prevent Free tier pausing
- **⚠️ Pending:** Supabase backup configuration

---

## 5. Subprocessors

| Subprocessor | Purpose | Location | DPA |
|--------------|---------|----------|-----|
| Cloudflare, Inc. | Application hosting (Workers), connection pooling (Hyperdrive) | Global (Worker placed ap-south-1) | **TBD** |
| Supabase, Inc. | Database hosting (Postgres) | AWS ap-south-1 (Mumbai) | **TBD** |
| Resend, Inc. | Email delivery (payment reminders) | **TBD** | **TBD** — Not wired yet |
| Sentry (Functional Software, Inc.) | Error monitoring | **TBD** | **TBD** — Planned, not wired yet |

---

## 6. Data Retention

| Data Category | Retention Period | Deletion Trigger |
|---------------|------------------|------------------|
| OAuth Sessions | Until logout, expiry, or uninstall | `app/uninstalled` webhook or session expiry |
| Shop and Account Data | Until 48 hours after uninstall | `shop/redact` webhook (sent by Shopify 48h after uninstall) |
| Invoices and Payments | **TBD** | **TBD** |
| Audit Events | **TBD** | **TBD** |
| Payment narration/payerText (raw bank data) | **TBD** | **TBD** |

---

## 7. Data Deletion and GDPR Webhooks

The app handles Shopify's mandatory compliance webhooks:

### 7.1 `app/uninstalled`

When a merchant uninstalls the app:
- All OAuth sessions for the shop are deleted (`Session` table)
- Shop configuration and business data (accounts, invoices, payments) remain until `shop/redact`
- **Verified:** Handler in `app/routes/webhooks.app.uninstalled.tsx`

### 7.2 `customers/data_request`

When a customer requests their data:
- Returns HTTP 200 with customer GID, tags, email, and displayName from `s8_tagged_customers`
- Exports only the S8 record; no other customer data is stored

### 7.3 `customers/redact`

When a customer must be deleted (GDPR/CCPA request):
- Deletes the `s8_tagged_customers` row for the affected customer (including email and displayName)
- Deletes any `s8_draft_orders` linked to that customer's BuyerAccount
- **Pending:** Payment.narration/payerText redaction for matched payments

### 7.4 `shop/redact`

When 48 hours have passed after uninstall and shop data must be fully purged:
- All OAuth sessions for the shop are deleted
- All Shop-related data cascades on delete (Shop → BuyerAccount, Invoice, Payment, etc.)
- **Verified:** Handler in `app/routes/webhooks.compliance.tsx`

---

## 8. Data Subject Rights

Merchants and their customers have the following rights:

| Right | How to Exercise |
|-------|-----------------|
| Access | Contact **TBD** |
| Rectification | Contact **TBD** |
| Erasure | Uninstall the app, or contact **TBD** |
| Portability | Contact **TBD** |
| Objection | Contact **TBD** |

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

## Appendix: Shopify OAuth Scopes

**Current scopes:** `read_companies`, `read_orders`, `read_payment_terms`, `read_customers`, `read_draft_orders`, `write_companies`, `write_customers`, `write_orders`, `write_validations`, `write_payment_customizations`, `write_merchant_managed_fulfillment_orders`

**Protected Customer Data (2026-10-23):** Level 1 + Name + Email approved. No phone, no address.

---

*This privacy policy draft is generated from code inspection. All **TBD** items require product/legal decisions before publication.*
