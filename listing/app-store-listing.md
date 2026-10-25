# App Store Listing — Net Terms Receivables

---

## App Name

**Net Terms Receivables**

---

## App Introduction

<!-- 88 characters -->
Track B2B net-terms invoices, manage credit limits and holds, match Indian bank payments

---

## App Details

<!-- 488 characters -->
Net Terms Receivables helps Indian wholesale merchants track outstanding invoices, enforce credit limits, and reconcile bank payments — without spreadsheets. Sync buyer accounts from Shopify B2B Companies or tagged Customers. Track open invoices by aging bucket. Set credit limits and manual holds per buyer. Block checkout or hide payment methods for held accounts. Import Indian bank statements and confirm matches to mark orders paid. Send payment reminders before and after due dates.

**This app does not lend money, provide financing, or purchase/factor receivables.** It helps merchants track payment terms they extend themselves (App Store requirement 1.1.16).

---

## Feature List

<!-- Each feature ≤80 characters -->
- Sync buyer accounts from B2B Companies or tagged Customers <!-- 58 chars -->
- Track invoices with aging buckets (current through 90+ days) <!-- 60 chars -->
- Set credit limits and manual holds per buyer <!-- 44 chars -->
- Block checkout when accounts are on hold or over limit <!-- 54 chars -->
- Hide payment methods for held accounts at checkout <!-- 50 chars -->
- Import HDFC, ICICI, SBI, Axis bank statements (browser-side) <!-- 60 chars -->
- Match payments to invoices; confirm to mark orders paid <!-- 55 chars -->
- Send payment reminders before and after due dates <!-- 49 chars -->

---

## Pricing Details

| Plan | Monthly | Annual | Buyer Accounts | Support |
|------|---------|--------|----------------|---------|
| Starter | $9/month | $90/year | Up to 25 | Standard |
| Growth | $19/month | $190/year | Up to 100 | Standard |
| Unlimited | $29/month | $290/year | Unlimited | Priority |

- **30-day free trial** on all plans
- **Annual billing** at 10× monthly (2 months free)
- **Every feature included** on every plan
- **No free plan**

Spec: Configure these plans in the Partner Dashboard "Pricing" section using Shopify App Pricing (recommended) or Billing API.
Ref: https://shopify.dev/docs/apps/launch/billing

### DRAFT: Top features (per plan, for the Partner Dashboard plan descriptions; final copy owned by Wholesale Terms Builder)

**Starter (up to 25 buyer accounts)**
- Up to 25 buyer accounts · All features included

**Growth (up to 100 buyer accounts)**
- Up to 100 buyer accounts · All features included

**Unlimited**
- Unlimited buyer accounts · Priority support · All features included

**All plans include:**
- Sync buyer accounts from B2B Companies or tagged Customers
- Track invoices with aging buckets (current through 90+ days)
- Set credit limits and manual holds per buyer
- Block checkout when accounts are on hold or over limit
- Hide payment methods for held accounts at checkout
- Import HDFC, ICICI, SBI, Axis bank statements (browser-side)
- Match payments to invoices; confirm to mark orders paid
- Send payment reminders before and after due dates

---

## App Icon

**[OWNER]** Upload a 1200×1200 px square JPEG or PNG.

Spec: Bold colors, simple pattern, no text or Shopify trademarks. Corners are rounded automatically.
Ref: https://shopify.dev/docs/apps/launch/app-requirements-checklist (section 5, "App icon")

---

## Feature Image

**[OWNER]** Upload a 1600×900 px (16:9) image.

Spec: One focal point, solid background with 4.5:1 contrast. No Shopify logos, no pricing, no app card subtitle text.
Ref: https://shopify.dev/docs/apps/launch/app-requirements-checklist (section 5, "Feature media")

---

## Screenshots

**[OWNER]** Upload 3–6 desktop screenshots at 1600×900 px.

Required:
1. Dashboard with aging summary and buyer ledger
2. Buyer account page with credit status and invoices
3. Bank statement import (parsed preview)
4. Payment reconciliation queue
5. Reminder settings
6. (Optional) Tag rules for non-B2B stores

Spec: Crop out browser chrome. No PII (blur customer names/emails). No pricing. Include alt text.
Ref: https://shopify.dev/docs/apps/launch/app-requirements-checklist (section 5, "Screenshots")

---

## Demo Screencast

**[OWNER]** Provide an English screencast URL (2–3 minutes).

Spec: Show onboarding, key features as described in listing. Limit screencasts to 25% of video; keep it promotional. English audio or subtitles required.
Ref: https://shopify.dev/docs/apps/launch/app-requirements-checklist (section 5, "Include a demo screencast")

---

## Demo Store & Test Instructions

**[OWNER]** Provide a demo store URL and reviewer instructions.

Spec: Link directly to the page demonstrating app functionality. Include test credentials if needed. Explain how to trigger key flows (e.g., "Import the sample bank statement at /app/imports").
Ref: https://shopify.dev/docs/apps/launch/app-requirements-checklist (section 5, "Demo store URL" and "Include test credentials")

---

## Support Contact

**[OWNER]** Provide support email (e.g., support@example.com).

Spec: Must be a monitored email. Response time SLA recommended.

---

## Emergency Developer Contact

**[OWNER]** Add to Partner Dashboard: email and phone.

Spec: Partner Dashboard → Account → Emergency developer contact. Required before App Store submission.
Ref: https://shopify.dev/docs/apps/launch/app-requirements-checklist (section 4.5.6)

---

## Privacy Policy URL

**[OWNER]** Host privacy policy at a public URL (the app's `/privacy` route once `docs/privacy.md` TBDs are filled).

Spec: URL must be accessible without authentication. Fill all TBD items in `docs/privacy.md`, then deploy.
Ref: https://shopify.dev/docs/apps/launch/app-requirements-checklist (section 5, "Privacy policy")

---

## Permissions and Data Access

### OAuth Scopes (8 total)

Write scopes imply read access per [Shopify Access Scopes](https://shopify.dev/docs/api/usage/access-scopes).

#### Read Scopes (2)

| Scope | Purpose |
|-------|---------|
| `read_draft_orders` | View draft orders to calculate pending credit exposure |
| `read_payment_terms` | View payment terms on orders and company locations |

#### Write Scopes (6)

| Scope | Purpose |
|-------|---------|
| `write_companies` | View and update B2B companies and locations for buyer account sync and credit status |
| `write_customers` | View and update customers for net-terms eligibility and credit status |
| `write_merchant_managed_fulfillment_orders` | Place fulfillment holds on orders from accounts on credit hold |
| `write_orders` | View orders for invoice tracking, mark as paid after bank payment matching, and add status tags |
| `write_payment_customizations` | Configure payment method visibility based on account status |
| `write_validations` | Configure checkout validation to enforce credit limits and holds |

### Protected Customer Data

The app accesses **Level 1 + Name + Email** protected customer fields.

| Field | Accessed | Purpose |
|-------|----------|---------|
| `id` | Yes | Link customers to buyer accounts |
| `tags` | Yes | Match tag rules for net-terms eligibility |
| `email` | Yes | Payment reminders; payment matching |
| `displayName` | Yes | Display in buyer ledger; payment matching |
| Phone, addresses | **No** | Not requested, blocked in code |

`email` and `displayName` are fetched and stored only when `CUSTOMER_PII_FIELDS=1` (`app/services/sync/customer-fields.server.ts:69`). Phone and address fields are explicitly forbidden and rejected by `validateNoForbiddenFields()`.

### What the App Writes to Shopify

- **Metafields** (`$app:credit_status`): Credit limit, exposure, hold state synced to Company/CompanyLocation/Customer for use by Shopify Functions.
- **Fulfillment holds**: Places holds on merchant-managed fulfillment orders from held accounts (`app/services/backstop.server.ts:200`).
- **Order mutations**: `orderMarkAsPaid` after confirmed bank matches; `tagsAdd` for credit-hold tag (`ntr-credit-hold`).
- **Function registrations**: Creates/updates the Cart Validation and Payment Customization Functions.

---

## App Categories

- **Primary:** Orders and shipping → Orders → Invoices and receipts
- **Secondary:** Store management → Finances → Accounting

---

## Merchant Requirements

- **Shopify Plan:** Basic, Grow, Advanced, or Shopify Plus
- **B2B (optional):** B2B features require B2B on the store (not available on Starter or Retail plans)
- **Region:** Optimized for Indian merchants (bank statement formats for HDFC, ICICI, SBI, Axis; INR currency; IST timezone)

---

## Technical Details

- **Embedded App:** Yes (Shopify App Bridge)
- **Session Tokens:** Yes (no third-party cookies)
- **Hosting:** App runs on Cloudflare's global network
- **Database:** Supabase Postgres (stored in India, Mumbai region)

---

## Data Handling

- **Privacy Policy:** `/privacy` route (see `docs/privacy.md`)
- **Data Location:** Data stored in India (Mumbai); the app runs on Cloudflare's global network
- **GDPR/CCPA Webhooks:** `customers/data_request`, `customers/redact`, `shop/redact` handled
- **Data Sales:** We do not sell merchant or customer data

---

## Partner Dashboard Steps

**[OWNER]** Before submission:

1. Upload app icon (1200×1200)
2. Upload feature image (1600×900)
3. Upload 3–6 screenshots (1600×900) with alt text
4. Add screencast URL
5. Set demo store URL and test instructions
6. Set support email
7. Add emergency developer contact (email + phone)
8. Set privacy policy URL
9. Configure pricing plans
10. Submit for review

---

*This listing describes features merged on main as of 2026-10-25. All **[OWNER]** items require decisions or assets before App Store submission.*
