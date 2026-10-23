# Request `read_all_orders` Scope

This checklist guides you through requesting Shopify approval for the `read_all_orders` protected scope. This scope extends `read_orders` and `write_orders` access to orders older than 60 days.

## Why We Need This Scope

Net Terms Receivables is a B2B net-terms receivables management app that:

- Tracks unpaid net-terms invoices per buyer company
- Calculates aging (30/60/90+ days overdue)
- Manages credit limits and holds
- Reconciles bank payments against historical invoices

**The 60-day order limit is insufficient because:**

1. **Net-30/60 terms**: An invoice due in 30-60 days may be paid after 60+ days from order creation
2. **Aging calculations**: 90+ day aging reports require orders from at least 90 days ago
3. **Historical reconciliation**: Matching bank payments to invoices requires access to the original order
4. **Backfill on install**: New merchants need their existing receivables imported, not just new orders

Without `read_all_orders`, orders older than 60 days return `null` from the API, breaking aging reports, payment matching, and credit calculations.

## Current Scopes (No Changes in This PR)

The app currently declares these scopes in `shopify.app.toml`:

```text
read_companies,read_customers,read_draft_orders,read_orders,read_payment_terms,write_companies,write_customers,write_merchant_managed_fulfillment_orders,write_orders,write_payment_customizations,write_validations
```

After approval, `read_all_orders` will be added alongside `read_orders`. See `docs/scopes.md` for the full scope audit.

> **Note**: This PR does not change scopes. The scope change will be a separate PR after approval is granted.

## Where to Request

For apps created under a Partner organization (which this app is), you must request approval in the Partner Dashboard before declaring the scope.

1. Go to [Shopify Partner Dashboard](https://partners.shopify.com)
2. Click **Apps** in the left sidebar
3. Click the app name (**Net Terms Receivables**)
4. Click **API access requests** (verify in UI—may be under Configuration or a similar section)
5. In the **Access requests** section, find the **Read all orders** card
6. Click **Request access**
7. Fill in the justification form (see template below)

> **Source**: [Shopify API Access Scopes - Orders Permissions](https://shopify.dev/docs/api/usage/access-scopes#orders-permissions)

## Ready-to-Paste Justification

Copy and customize this text for the request form:

---

**App Name:** Net Terms Receivables

**What does your app do?**

Net Terms Receivables is a B2B net-terms receivables management app for Shopify merchants. It helps wholesale merchants:
- Track unpaid invoices from orders placed on net-30/60/90 payment terms
- Calculate accounts receivable aging (current, 30, 60, 90+ days overdue)
- Manage buyer credit limits and automatic credit holds
- Reconcile bank transfer payments (NEFT/RTGS/IMPS/UPI) against open invoices

**Why do you need access to orders older than 60 days?**

1. **Payment terms exceed 60 days**: Net-60 and Net-90 terms mean invoices are due 60-90 days after order creation. By the time payment is due or overdue, the order is outside the 60-day window.

2. **Aging reports**: Standard accounts receivable aging (30/60/90+ days) requires order data going back at least 90 days to calculate which invoices are 90+ days overdue.

3. **Payment reconciliation**: When a buyer makes a bank transfer, we match it against open invoices. If the original order is older than 60 days, we cannot retrieve invoice details for matching.

4. **Historical backfill**: When a merchant installs the app, they need existing receivables imported—not just future orders. Most B2B merchants have significant outstanding receivables from orders older than 60 days.

**How do you minimize data access?**

- We fetch only the fields needed for receivables: order ID, name, total, payment status, payment terms, company/customer reference
- We do NOT fetch line items, shipping details, or fulfillment data
- Customer PII (email, phone, address) is handled per Protected Customer Data approval (Level 1 + Name + Email)
- Retention/purge jobs exist: `s22_data_requests` with 30-day expiration, GDPR `customers/redact` webhook deletes customer-linked data
- All data is deleted on `shop/redact` webhook (48 hours post-uninstall)

---

## After Approval

Once Shopify approves the request:

1. Add `read_all_orders` to `shopify.app.toml` scopes (alongside existing `read_orders`)
2. Update `wrangler.jsonc` SCOPES variable to match
3. Run `scripts/check-scope-sync.ts` to verify sync
4. Deploy new app version with `shopify app deploy`
5. Existing merchants must open the app to approve the new scope

## Data Minimization Evidence

Reference these existing implementations when filling out the justification:

| Feature | File | What It Does |
|---------|------|--------------|
| Data request export | `app/routes/webhooks.compliance.tsx` | S22 compliance handler |
| Data request purge | `s22_data_requests` table with `expires_at` | 30-day auto-purge |
| Customer redact | `app/routes/webhooks.compliance.tsx` | Deletes customer data on GDPR request |
| Shop redact | `app/routes/webhooks.compliance.tsx` | Cascading delete on uninstall |
| Forbidden PII fields | `app/services/sync/customer-fields.server.ts` | Blocks phone/address fields |

See `docs/privacy.md` for complete data handling documentation.

## Checklist Summary

- [ ] Log in to [Shopify Partner Dashboard](https://partners.shopify.com)
- [ ] Navigate to Apps → Net Terms Receivables
- [ ] Click **API access requests** (verify in UI)
- [ ] Find **Read all orders** card and click **Request access**
- [ ] Paste and customize the justification text above
- [ ] Submit the request
- [ ] Wait for Shopify approval (may take several business days)
- [ ] After approval: create separate PR to add `read_all_orders` scope
