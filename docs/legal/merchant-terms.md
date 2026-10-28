# Merchant Terms of Service & Data Processing Addendum — Termwise: Net Terms & Credit

**Owner/Operator:** Raghav Khanna, individual developer, India

**Contact:** support@termwiseapp.com

**Governing Law:** Laws of India  
**Jurisdiction:** Courts at Delhi (New Delhi), India (exclusive)

**Effective Date:** 2026-10-25  
**Last Updated:** 2026-10-26

---

## Part 1: Merchant Terms of Service

### 1. Introduction

These Terms of Service ("Terms") govern the use of Termwise: Net Terms & Credit ("the App", "we", "us") by merchants ("you", "Merchant") who install the App through the Shopify App Store.

The App is built for Indian merchants with INR (Indian rupee) stores.

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

TO THE MAXIMUM EXTENT PERMITTED BY LAW, THE APP IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED. IN NO EVENT SHALL THE APP PROVIDER'S TOTAL LIABILITY EXCEED THE FEES PAID BY YOU IN THE TWELVE (12) MONTHS IMMEDIATELY PRECEDING THE CLAIM.

### 7. Termination

You may uninstall the App at any time through Shopify. Upon uninstallation:
- Sessions and webhook receipts are deleted immediately
- Remaining shop data is deleted when Shopify sends `shop/redact` (48 hours after uninstall)

### 8. Governing Law

These Terms are governed by the laws of India. Any disputes arising under these Terms shall be subject to the exclusive jurisdiction of the courts at Delhi (New Delhi), India.

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
| Buyer Identity | Name, email address | Payment reminders, account identification | Shopify Customer/Company sync |
| Financial Data | Invoice amounts, outstanding balances, payment terms | Credit management, invoice tracking | Shopify Order sync |
| Payment Data | Bank transfer details (payer name, narration, UTR) | Payment reconciliation | Merchant-uploaded bank statements |

**Note:** The App does not request or store:
- Phone numbers
- Physical addresses
- Payment card data

...except as incidentally present in uploaded bank-statement narration.

### 4. Sub-Processors

We use the following sub-processors to provide the App:

| Sub-Processor | Service | Data Processed | Location |
|---------------|---------|----------------|----------|
| Cloudflare, Inc. | Application hosting (Workers), connection pooling (Hyperdrive), encrypted database backups (R2), observability logs | All App data in transit; encrypted database backups | Global (Worker placed near ap-south-1); R2 bucket in Asia-Pacific region |
| Supabase, Inc. | Database hosting (Postgres), encrypted at rest (AES-256) and in transit (TLS) | All stored App data | AWS ap-south-1 (Mumbai, India) |
| Resend, Inc., Tokyo, Japan (ap-northeast-1) data region | Sending payment-reminder emails and data-request notifications | Recipient email address, buyer name, shop name, invoice number, outstanding amount and due date, unsubscribe link, merchant contact email (as Reply-To), shop owner email (for data-request notices) | Japan (ap-northeast-1) |
| Functional Software, Inc. (Sentry) | Error monitoring (used only when configured). Data is stored in Sentry's EU data region (Germany). It receives only sanitized error and performance events, with no buyer contact details, bank remitter names or narrations, and no payment amounts. | Sanitized error and performance events | EU (Germany) |
| GitHub, Inc. | Source code hosting and CI. The nightly backup job runs on GitHub-hosted runners; database contents are processed transiently in runner memory, encrypted before leaving the runner, and not stored by GitHub. | Source code; database contents in transit during the encrypted backup job | Global |

**Note:** Shopify is the platform and data source, not our sub-processor. Shopify's DPA governs your relationship with Shopify: [Shopify DPA](https://www.shopify.com/legal/dpa)

### 5. Data Subject Rights

We support your compliance with data subject requests:

| Right | Implementation |
|-------|----------------|
| Access | `customers/data_request` webhook generates JSON export |
| Erasure | `customers/redact` webhook deletes/anonymizes buyer data |
| Portability | Export available via data requests page in JSON format |

### 6. Security Measures

We implement appropriate technical and organizational measures:

- **Encryption in transit:** TLS for all communications
- **Encryption at rest:** Supabase encrypts data at rest with AES-256; database backups are encrypted with age (public-key encryption)
- **Access control:** OAuth 2.0 with shop-scoped sessions; a single person (the developer/operator) has access to production systems and data
- **Authentication:** Password manager with unique passwords and 2FA on all accounts used to run the App
- **Log data:** Application logs carry only IDs, counts, enums, booleans, timestamps, and error codes; Sentry scrubbing is described in Part 2, section 4 (Sub-Processors)

### 7. Data Retention

Key retention periods:
- Unmatched payment narrations: 180 days, then purged
- Data request exports: 30 days, then deleted
- All shop data: Deleted 48 hours after uninstall via `shop/redact`. If the shop reinstalls before the shop/redact webhook arrives, deletion is skipped to preserve the reinstalled shop's data.
- Database backups: The newest 7 backups are always kept, and older ones are deleted after 30 days on the next successful backup run. Backups are stored encrypted in Cloudflare R2.

### 8. Data Breach Notification

In the event of a personal data breach affecting your data:
- Contain the incident first; then notify affected merchants and Shopify within 72 hours of becoming aware of a breach involving personal data, and, where it applies, report to CERT-In within the timelines required by Indian law (currently 6 hours under CERT-In's April 2022 directions)
- We will provide information to assist with your regulatory notification obligations

### 9. Information Requests

We do not provide audit rights. Upon written request, we will provide reasonable written information about our data protection practices to help you verify compliance with applicable data protection laws.

### 10. Cross-Border Transfers

Personal data may be transferred to:
- **Japan:** Resend (ap-northeast-1 data region) for email delivery
- **EU (Germany):** Sentry for error monitoring (when configured)
- **Global:** Cloudflare edge nodes (request processing) and Cloudflare observability logs
- **Asia-Pacific:** Cloudflare R2 (encrypted database backups, Asia-Pacific region)
- **Global:** GitHub (source code and CI; database contents processed transiently in runner memory during encrypted backup job, not stored by GitHub)

### 11. Term and Termination

This DPA remains in effect as long as the App processes personal data on your behalf.

Upon termination:
- We delete your data per Section 7 above
- No personal data is retained beyond the stated retention periods, except copies in encrypted backups (the newest 7 are always kept, older ones deleted after 30 days on the next successful backup run)
- Deletion is automatic via Shopify compliance webhooks

---

## Signatures

**Merchant:** By installing the App, you agree to these Terms and this DPA.

**App Provider:**

Raghav Khanna  
Individual Developer, India  
2026-10-25
