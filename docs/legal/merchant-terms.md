# Merchant Terms of Service & Data Processing Addendum

**⚠️ DRAFT — NOT IN EFFECT**

**This document is a draft that requires review by Raghav or a qualified lawyer before publishing. It is not legally binding and is not in effect.**

---

**Legal Entity:** [Raghav to confirm]  
**Address:** [Raghav to confirm]  
**Governing Law:** [Raghav to confirm]  
**Jurisdiction:** [Raghav to confirm]

**Effective Date:** [TBD]  
**Last Updated:** 2026-10-25

---

## Part 1: Merchant Terms of Service

### 1. Introduction

These Terms of Service ("Terms") govern the use of Net Terms Receivables ("the App", "we", "us") by merchants ("you", "Merchant") who install the App through the Shopify App Store.

By installing or using the App, you agree to these Terms.

### 2. Service Description

The App provides:
- B2B invoice tracking and credit management
- Bank payment reconciliation for matching bank transfers to invoices
- Payment reminder emails to buyers
- Checkout validation for credit limits and holds

### 3. Merchant Responsibilities

You agree to:
- Provide accurate business information
- Comply with applicable laws regarding invoicing and collections
- Obtain necessary consents from your buyers for payment reminders
- Review and deliver data exports requested by your customers under GDPR/CCPA

### 4. Data Handling

See Part 2 (Data Processing Addendum) for data handling terms.

### 5. Payment

Subscription fees are handled through Shopify's billing system per the Shopify App Store terms.

### 6. Limitation of Liability

TO THE MAXIMUM EXTENT PERMITTED BY LAW, THE APP IS PROVIDED "AS IS" WITHOUT WARRANTY. [Raghav to confirm — standard limitation of liability clause required]

### 7. Termination

You may uninstall the App at any time through Shopify. Upon uninstallation:
- Sessions and webhook receipts are deleted immediately
- Remaining shop data is deleted when Shopify sends `shop/redact` (48 hours after uninstall)

### 8. Governing Law

These Terms are governed by the laws of [Raghav to confirm].

---

## Part 2: Data Processing Addendum

This Data Processing Addendum ("DPA") forms part of the Terms of Service.

### 1. Definitions

- **Controller:** The Merchant (you) who determines the purposes and means of processing buyer personal data
- **Processor:** The App (we/us) who processes personal data on behalf of the Controller
- **Data Subjects:** Your buyers whose personal data is processed
- **Personal Data:** Information relating to identified or identifiable natural persons
- **Processing:** Any operation performed on personal data

### 2. Roles and Responsibilities

**You (the Merchant) are the Controller** for all buyer personal data processed through the App.

**We (the App) act as Processor** and process personal data only:
- On your behalf and per your instructions
- To provide the App's functionality
- As required by applicable law

### 3. Categories of Personal Data Processed

The App processes the following categories of buyer personal data:

| Category | Fields | Purpose | Source |
|----------|--------|---------|--------|
| Buyer Identity | Name, email address | Payment reminders, account identification | Shopify Customer/Company sync (`app/services/sync/customer.server.ts`) |
| Financial Data | Invoice amounts, outstanding balances, payment terms | Credit management, invoice tracking | Shopify Order sync (`app/services/sync/order.server.ts`) |
| Payment Data | Bank transfer details (payer name, narration, UTR) | Payment reconciliation | Merchant-uploaded bank statements (`app/routes/app.imports.tsx`) |

**Note:** The App does NOT process or store:
- Phone numbers
- Physical addresses
- Payment card data

...except as incidentally present in uploaded bank-statement narration (`Payment.narration`/`payerText`, `prisma/schema.prisma:434-436`).

### 4. Sub-Processors

We use the following sub-processors to provide the App:

| Sub-Processor | Service | Data Processed | Location | DPA |
|---------------|---------|----------------|----------|-----|
| **Cloudflare, Inc.** | Application hosting (Workers), connection pooling (Hyperdrive) | All App data in transit; edge processing | Global (Worker placed ap-south-1 via region hint) | [Raghav to confirm] |
| **Supabase, Inc.** | Database hosting (Postgres) | All App data at rest | [Raghav to confirm region] | [Raghav to confirm] |
| **Plus Five Five, Inc. (Resend)** | Email delivery | Buyer name and email, merchant name (`app/services/reminders.server.ts:949-956`), shop-owner email (data-request notice) | US | [Resend DPA](https://resend.com/legal/dpa) (DPA §6.1) |
| **Functional Software, Inc. d/b/a Sentry** | Error monitoring | Scrubbed error events only (no PII by design — see `app/lib/sentry.ts:83-137`) | Sentry (Functional Software, Inc.), EU data region (Germany) | [Sentry DPA](https://sentry.io/legal/dpa/) |

**Note:** Shopify is the platform and data source, not our sub-processor. Shopify's DPA governs your relationship with Shopify: [Shopify DPA](https://www.shopify.com/legal/dpa).

**Sub-processor code references:**
- Cloudflare Workers entry: `workers/app.ts`
- Supabase connection: `app/lib/db-light.server.ts`
- Resend email sending: `app/services/compliance/compliance.server.ts:837-920` (data request notification), `app/services/reminders.server.ts` (payment reminders)
- Sentry initialization: `app/lib/sentry.ts:173-199`

### 5. Data Subject Rights

We support your compliance with data subject requests:

| Right | Implementation |
|-------|----------------|
| Access | `customers/data_request` webhook generates JSON export (`app/services/compliance/compliance.server.ts:490-648`) |
| Erasure | `customers/redact` webhook deletes/anonymizes buyer data (`app/services/compliance/compliance.server.ts:314-425`) |
| Portability | Export available via data requests page in JSON format |

### 6. Security Measures

We implement appropriate technical and organizational measures:

- **Encryption in transit:** TLS for all communications
- **Encryption at rest:** Supabase-managed (provider-controlled)
- **Access control:** OAuth 2.0 with shop-scoped sessions
- **PII redaction in logs:** `safeLog()` with allowlist (`app/lib/log.server.ts`)
- **Error monitoring scrubbing:** Sentry `beforeSend` hooks (`app/lib/sentry.ts:83-137`)

### 7. Data Retention

See `docs/security/data-retention.md` for retention schedule.

Key retention periods:
- Unmatched payment narrations: 180 days, then purged
- Data request exports: 30 days, then deleted
- All shop data: Deleted 48 hours after uninstall via `shop/redact`

### 8. Data Breach Notification

In the event of a personal data breach affecting your data:
- We will notify you without undue delay
- We will provide information to assist with your regulatory notification obligations
- See `docs/security/incident-response.md` for incident response procedures

### 9. Audit Rights

[Raghav to confirm — standard audit rights clause required]

### 10. Cross-Border Transfers

Personal data may be transferred to:
- **US:** Resend (email delivery)
- **EU (Germany):** Sentry (error monitoring)
- **EU/other:** Cloudflare edge nodes (transient processing only)

Transfer mechanisms: [Raghav to confirm — SCCs, adequacy decisions, or other]

### 11. Term and Termination

This DPA remains in effect as long as the App processes personal data on your behalf.

Upon termination:
- We delete your data per Section 7 above
- No personal data is retained beyond the stated retention periods, except copies in provider-managed backups and logs for the provider retention windows listed in `docs/security/data-retention.md`
- Deletion is automatic via Shopify compliance webhooks

---

## Signatures

**Merchant:** By installing the App, you agree to these Terms and this DPA.

**App Provider:**

[Raghav to confirm]  
[Title]  
[Date]
