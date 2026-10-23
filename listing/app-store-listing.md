# App Store Listing — Net Terms Receivables

> **Status:** Draft for QA review. Features marked ⚠️ depend on unmerged PRs.

---

## App Name

**Net Terms Receivables**

---

## Tagline (80 characters max)

B2B net-terms invoicing, credit limits, and Indian bank payment matching

---

## Introduction (Brief Description)

Net Terms Receivables helps Indian B2B wholesale merchants manage payment terms, track outstanding invoices, enforce credit limits, and match bank transfer payments (NEFT/RTGS/IMPS/UPI) to orders — all within Shopify.

---

## Key Features

### ✅ Available Now (main branch)

- **Shopify OAuth Integration** — Secure embedded app with session management
- **Shop Configuration** — Set default payment terms, timezone (for due date calculations), and currency (INR)
- **GDPR/CCPA Compliance** — Handles `customers/data_request`, `customers/redact`, and `shop/redact` webhooks
- **Webhook HMAC Verification** — All webhooks verified with constant-time HMAC-SHA256

### ⚠️ Coming with PR #28 (S6 — Company & Order Sync)

- **B2B Company Sync** — Automatically create buyer accounts from Shopify B2B Companies and CompanyLocations
- **Order Invoice Sync** — Create invoices from orders with payment terms (NET 15/30/60, fixed dates)
- **Bulk Backfill** — Import existing companies and orders via Shopify's bulk operations API
- **Payment Terms Tracking** — Due dates computed from order payment terms schedules

### ⚠️ Coming with PR #32 (S8 — Tag Rules & Customer Sync)

- **Tag-Based Buyer Accounts** — Map customer tags (e.g., "net30", "wholesale") to default payment terms
- **Customer Sync** — Track tagged customers as net-terms buyers
- **Draft Order Tracking** — Track draft orders with payment terms for pending credit exposure
- **Tag Activation/Deactivation** — Graceful handling when tags are added or removed

### Planned Features (Not Yet Implemented)

- **Credit Limit Enforcement** — Set per-buyer credit limits with hold states (OK, NEAR_LIMIT, HELD)
- **Indian Bank Statement Import** — Upload HDFC, ICICI, or mapped CSV statements
- **Payment Matching** — Automatic and manual matching of bank payments to invoices
- **Payment Reminders** — Email reminders before, on, or after due dates (via Resend)
- **Aging Reports** — Track overdue invoices and DSO metrics
- **GST Invoice Numbers** — Indian tax compliance fields

---

## Pricing

**TBD**

Options under consideration:
- Free tier with limits
- Paid tier via Shopify Billing API

---

## Screenshots

**TBD** — Screenshots to be added after UI implementation

Planned screenshots:
1. Dashboard with outstanding receivables
2. Buyer account list with credit status
3. Invoice detail with payment history
4. Bank statement import
5. Payment matching interface

---

## Demo Video

**TBD** — Video walkthrough to be recorded after core features complete

---

## Support

- **Support Email:** **TBD**
- **Documentation:** **TBD**
- **Response Time SLA:** **TBD**

---

## App Categories

Suggested categories for Shopify App Store:
- **Primary:** Orders and shipping → Invoicing
- **Secondary:** Store management → Finances

---

## Merchant Requirements

- **Shopify Plan:** Standard or higher (for B2B features, requires Shopify Plus or B2B on Shopify)
- **Region:** Optimized for Indian merchants (bank statement formats, INR currency, IST timezone)
- **B2B:** B2B features require B2B to be enabled on the store

---

## Technical Details

- **Embedded App:** Yes (uses Shopify App Bridge)
- **Session Tokens:** Yes (no third-party cookies)
- **Hosting:** Cloudflare Workers (edge runtime)
- **Database:** Supabase Postgres (Mumbai region)

---

## Permissions Requested

**Current (main branch):** No scopes requested

**⚠️ After PR #28 (S6):**

| Scope | Purpose |
|-------|---------|
| `read_companies` | Access B2B companies and locations for buyer accounts |
| `read_orders` | Access orders to create invoices (60-day window without `read_all_orders`) |
| `read_payment_terms` | Access payment terms on orders and company locations |
| `read_customers` | Access customers with net-terms tags |
| `read_draft_orders` | Access draft orders for pending credit exposure |

**Note:** These are read-only scopes. The app does not modify orders, customers, or companies.

**Protected Customer Data:** `read_customers` and `read_orders` require Shopify's PCD access approval.

---

## Data Handling

- **Privacy Policy:** See `docs/privacy.md`
- **Data Location:** India (AWS ap-south-1 Mumbai)
- **GDPR Webhooks:** Handled
- **No Data Selling:** We do not sell merchant or customer data

---

*This listing draft describes features based on the current main branch and open PRs #28 and #32. Features marked ⚠️ are not yet merged. All **TBD** items require decisions before App Store submission.*
