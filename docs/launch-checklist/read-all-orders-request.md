# Request `read_all_orders` Scope

**Status:** ⏳ **Requested** 25 Oct 22:13 IST; grant pending confirmation

This checklist guided the request for Shopify approval of the `read_all_orders` protected scope. This scope extends order access to orders older than 60 days.

**Note (S24):** We request `write_orders` which implies `read_orders` per [Shopify Access Scopes](https://shopify.dev/docs/api/usage/access-scopes). The `read_all_orders` scope extends this implied read access to orders beyond the 60-day window.

## Why We Need This Scope

Termwise: Net Terms & Credit is a B2B net-terms receivables management app that:

- Tracks unpaid net-terms invoices per buyer company
- Calculates aging (current, 1-30, 31-60, 61-90, 90+ days overdue)
- Manages credit limits and holds
- Reconciles bank payments against historical invoices

**The 60-day order limit is insufficient because:**

1. **Net terms**: An invoice due in 30-60 days may be paid after 60+ days from order creation
2. **Aging calculations**: 90+ day aging reports require orders from at least 90 days ago (buckets: current, 1-30, 31-60, 61-90, 90+ days overdue)
3. **Historical reconciliation**: Matching bank payments to invoices requires access to the original order
4. **Backfill on install**: New merchants need their existing receivables imported, not just new orders

Without `read_all_orders`, orders older than 60 days return `null` from the API, breaking aging reports, payment matching, and credit calculations.

## Current Scopes

The app declares these scopes in `shopify.app.toml`:

```text
read_all_orders,read_draft_orders,read_payment_terms,write_companies,write_customers,write_merchant_managed_fulfillment_orders,write_orders,write_payment_customizations,write_validations
```

Note: `write_orders` implies `read_orders` per [Shopify Access Scopes](https://shopify.dev/docs/api/usage/access-scopes), so `read_all_orders` extends that implied access. The scope is in the app's configuration; access still requires Shopify's approval in the Partner Dashboard. See `docs/scopes.md` for the full scope audit.

## Where to Request

For apps created under a Partner organization (which this app is), you must request approval in the Partner Dashboard before declaring the scope.

1. Go to [Shopify Partner Dashboard](https://partners.shopify.com)
2. Click **Apps** in the left sidebar
3. Click the app name (**Termwise: Net Terms & Credit**)
4. Click **API access requests** (verify in UI—may be under Configuration or a similar section)
5. In the **Access requests** section, find the **Read all orders** card
6. Click **Request access**
7. Fill in the justification form (see template below)

> **Source**: [Shopify API Access Scopes - Orders Permissions](https://shopify.dev/docs/api/usage/access-scopes#orders-permissions)

## Ready-to-Paste Justification

Copy and customize this text for the request form:

---

**App Name:** Termwise: Net Terms & Credit

**What does your app do?**

Termwise is a B2B net-terms receivables management app for Shopify merchants. It helps wholesale merchants:
- Track unpaid invoices from orders placed on net terms such as Net 60
- Calculate accounts receivable aging (current, 1-30, 31-60, 61-90, 90+ days overdue)
- Manage buyer credit limits and automatic credit holds
- Reconcile bank transfer payments (NEFT/RTGS/IMPS/UPI) against open invoices

**Why do you need access to orders older than 60 days?**

1. **Payment terms exceed 60 days**: Net terms such as Net 60 mean invoices are due 60 days after order creation. By the time payment is due or overdue, the order is outside the 60-day window.

2. **Aging reports**: Standard accounts receivable aging (current, 1-30, 31-60, 61-90, 90+ days overdue) requires order data going back at least 90 days to calculate which invoices are 90+ days overdue.

3. **Payment reconciliation**: When a buyer makes a bank transfer, we match it against open invoices. If the original order is older than 60 days, we cannot retrieve invoice details for matching.

4. **Historical backfill**: When a merchant installs the app, they need existing receivables imported—not just future orders. Most B2B merchants have significant outstanding receivables from orders older than 60 days.

**How do you minimize data access?**

- The bulk order query fetches only receivables fields: order ID, name, timestamps (createdAt, processedAt, updatedAt, cancelledAt, closedAt), displayFinancialStatus, displayFulfillmentStatus, totalPriceSet, totalOutstandingSet, paymentTerms (including paymentSchedules with dueAt, issuedAt, completedAt, amount), purchasingEntity (company/location IDs), and customer (ID and tags only—no email in orders)
- The bulk order query does NOT fetch line items, shipping addresses, or customer contact details (email, phone, address). Note: customer email and displayName ARE fetched separately in the customer sync (`CUSTOMER_PII_FIELDS`, gated by PCD approval) for labels, payment matching and reminders (`docs/scopes.md:165`)
- Protected Customer Data (PCD) Level 1 (Name, Email): completed, pending Shopify review, not yet approved (per `docs/scopes.md`); phone and address fields are never fetched
- Data request exports (`s22_data_requests`) have 30-day expiration with auto-purge; GDPR `customers/redact` webhook deletes customer-linked data
- All data is deleted on `shop/redact` webhook (48 hours post-uninstall)

---

## After Approval

**Request submitted:** 25 Oct 2026 22:13 IST — grant pending confirmation

Post-approval steps (once grant is confirmed):

1. ✅ Add `read_all_orders` to `shopify.app.toml` scopes (extends access from `write_orders` which implies `read_orders`)
2. ✅ Update `wrangler.jsonc` SCOPES variable to match
3. ✅ Run `scripts/check-scope-sync.ts` to verify sync
4. ⏳ Deploy new app version with `shopify app deploy` (batched with next release)
5. ⏳ Dev store must re-approve the scope after that release
6. ⏳ Production merchants will approve when they next open the app after that release

## Data Minimization Evidence

Reference these existing implementations when filling out the justification:

| Feature | File | What It Does |
|---------|------|--------------|
| Bulk order export | `app/services/sync/bulk-operations.server.ts` | Reads order fields for backfill (see lines 135-195 for exact fields) |
| Apply matched payment | `app/services/apply.server.ts` | Calls `orderMarkAsPaid` on orders when a confirmed bank match is applied |
| Order webhooks | `app/routes/webhooks.orders.tsx` | Handles order create/update/paid/cancelled events, including for orders >60 days old |
| Null refetch handling | `app/services/drain/processor.server.ts` | Handles null refetch for orders >60 days; uses webhook topic as evidence for paid/cancelled state |
| Data request export | `app/routes/webhooks.compliance.tsx` | S22 compliance handler |
| Data request purge | `s22_data_requests` table with `expires_at` | 30-day auto-purge |
| Customer redact | `app/routes/webhooks.compliance.tsx` | Deletes customer data on GDPR request |
| Shop redact | `app/routes/webhooks.compliance.tsx` | Cascading delete on uninstall |
| Forbidden PII fields | `app/services/sync/customer-fields.server.ts` | Blocks phone/address fields |

See `docs/privacy.md` for the public privacy policy and `docs/privacy-implementation.md` for internal implementation details.

## Checklist Summary

- [x] Log in to [Shopify Partner Dashboard](https://partners.shopify.com)
- [x] Navigate to Apps → Termwise: Net Terms & Credit
- [x] Click **API access requests** (verify in UI)
- [x] Find **Read all orders** card and click **Request access**
- [x] Paste and customize the justification text above
- [x] Submit the request (25 Oct 22:13 IST)
- [ ] **Grant pending confirmation** — check API access request status in Partner Dashboard
- [x] Create PR to add `read_all_orders` scope
- [ ] Deploy release with scope change (batched with next release)
- [ ] Dev store re-approves scope after release
