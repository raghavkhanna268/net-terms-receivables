# OAuth Scopes

This document lists all OAuth scopes requested by the Net Terms Receivables app, the features that use them, and the exact API calls that require them.

**Scope bar policy**: Production config (`shopify.app.toml` and `wrangler.jsonc` SCOPES) may only include scopes that merged code uses or that are pre-granted for imminent features.

**S24 scope reduction**: Dropped `read_companies`, `read_customers`, `read_orders` because write scopes imply read access. Per [Shopify Access Scopes documentation](https://shopify.dev/docs/api/usage/access-scopes) 'How it works' section: "Any scope that writes a resource also grants read access to it, so request the write scope only when your app needs both."

## Production Scopes (9 total)

### Read Scopes (3)

#### read_all_orders

**Requested:** 25 Oct 2026 22:13 IST; grant evidence accepted by Team Lead (WTB, Partners API access card, 22:23 IST: no Request button, no explicit Approved label); to be confirmed by DevOps's post-release granted-scopes check

Extends `write_orders` (which implies `read_orders`) to access orders older than 60 days.

| Feature | Step | API Call | Reference |
|---------|------|----------|-----------|
| Historical order backfill | S6 | `bulkOperationRunQuery` with orders | [bulkOperationRunQuery](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/bulkOperationRunQuery) |
| Order refetch for reconciliation | S10b | `order` query | [order query](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/order) |

> **Why needed:** Net-60/90 payment terms mean invoices can be due or overdue beyond the default 60-day order window. Without this scope, aging reports, payment reconciliation, and historical backfills break for orders older than 60 days. See `docs/launch-checklist/read-all-orders-request.md` for full justification.

#### read_draft_orders

| Feature | Step | API Call | Reference |
|---------|------|----------|-----------|
| Draft order payment terms | S8 | `draftOrders` query | [draftOrders query](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/draftOrders) |
| Draft order webhooks | S8 | `draft_orders/create`, `draft_orders/update`, `draft_orders/delete` | [Webhook topics](https://shopify.dev/docs/api/admin-rest/2026-10/resources/webhook) |

#### read_payment_terms

| Feature | Step | API Call | Reference |
|---------|------|----------|-----------|
| Order payment terms | S6 | `Order.paymentTerms` field | [Order.paymentTerms](https://shopify.dev/docs/api/admin-graphql/2026-10/objects/Order#field-order-paymentterms) |
| Company location payment terms | S6 | `CompanyLocation.buyerExperienceConfiguration.paymentTermsTemplate` | [buyerExperienceConfiguration](https://shopify.dev/docs/api/admin-graphql/2026-10/objects/CompanyLocation#field-companylocation-buyerexperienceconfiguration) |

### Write Scopes (6)

#### write_companies

Implies `read_companies` per [Access Scopes](https://shopify.dev/docs/api/usage/access-scopes).

| Feature | Step | Mutation/Query | Reference |
|---------|------|----------------|-----------|
| Credit/hold metafields on Company | S11 | `metafieldsSet` with Company ownerId | [metafieldsSet](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/metafieldsSet) |
| Credit/hold metafields on CompanyLocation | S11 | `metafieldsSet` with CompanyLocation ownerId | [metafieldsSet](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/metafieldsSet) |
| Dev seed: set payment terms on location | S4 | `companyLocationUpdate` with `buyerExperienceConfiguration.paymentTermsTemplateId` | [companyLocationUpdate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/companyLocationUpdate) |
| Company/location sync | S6 | `companies` query, `companyLocations` query | [companies query](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/companies) |
| Bulk companies export | S6 | `bulkOperationRunQuery` with companies | [bulkOperationRunQuery](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/bulkOperationRunQuery) |
| Company webhooks | S6 | `companies/create`, `companies/update`, `companies/delete` | [Webhook topics](https://shopify.dev/docs/api/admin-rest/2026-10/resources/webhook) |

#### write_customers

Implies `read_customers` per [Access Scopes](https://shopify.dev/docs/api/usage/access-scopes).

| Feature | Step | Mutation/Query | Reference |
|---------|------|----------------|-----------|
| Credit/hold metafields on Customer | S11 | `metafieldsSet` with Customer ownerId | [metafieldsSet](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/metafieldsSet) |
| Tagged customer sync | S8 | `customers` query with tag filter (id, tags, email, displayName) | [customers query](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/customers) |
| Bulk customer export | S8 | `bulkOperationRunQuery` with customers | [bulkOperationRunQuery](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/bulkOperationRunQuery) |
| Customer webhooks | S8 | `customers/create`, `customers/update`, `customers/delete` | [Webhook topics](https://shopify.dev/docs/api/admin-rest/2026-10/resources/webhook) |

> **Protected Customer Data:** PCD Level 1 (Name, Email): completed, pending Shopify review, not yet approved. Fields fetched: `id`, `tags`, `email`, `displayName`. Fields NEVER fetched: `phone`, `addresses`, `firstName`, `lastName`, `defaultAddress`. See "Protected Customer Data" section below.

#### write_orders

Implies `read_orders` per [Access Scopes](https://shopify.dev/docs/api/usage/access-scopes).

| Feature | Step | Mutation/Query | Reference |
|---------|------|----------------|-----------|
| Mark order as paid after bank match | S17 | `orderMarkAsPaid` | [orderMarkAsPaid](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/orderMarkAsPaid) |
| Add tags to orders (overdue, hold, etc.) | S17 | `tagsAdd` with Order gid | [tagsAdd](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/tagsAdd) |
| Remove tags from orders | S17 | `tagsRemove` with Order gid | [tagsRemove](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/tagsRemove) |
| Order sync | S6 | `orders` query | [orders query](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/orders) |
| Bulk orders export | S6 | `bulkOperationRunQuery` with orders | [bulkOperationRunQuery](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/bulkOperationRunQuery) |
| Order webhooks | S6 | `orders/create`, `orders/updated`, `orders/cancelled`, `orders/paid` | [Webhook topics](https://shopify.dev/docs/api/admin-rest/2026-10/resources/webhook) |

#### write_validations

| Feature | Step | Mutation | Reference |
|---------|------|----------|-----------|
| Cart/checkout validation function | S12 | `validationCreate` | [validationCreate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/validationCreate) |
| Update validation function | S12 | `validationUpdate` | [validationUpdate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/validationUpdate) |
| Delete validation function | S12 | `validationDelete` | [validationDelete](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/validationDelete) |

#### write_payment_customizations

| Feature | Step | Mutation | Reference |
|---------|------|----------|-----------|
| Payment method customization function | S13 | `paymentCustomizationCreate` | [paymentCustomizationCreate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/paymentCustomizationCreate) |
| Update payment customization | S13 | `paymentCustomizationUpdate` | [paymentCustomizationUpdate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/paymentCustomizationUpdate) |
| Delete payment customization | S13 | `paymentCustomizationDelete` | [paymentCustomizationDelete](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/paymentCustomizationDelete) |

> **Pre-granted for S13**: Shopify Functions payment customization to hide/show payment methods based on account status.

#### write_merchant_managed_fulfillment_orders

| Feature | Step | Mutation | Reference |
|---------|------|----------|-----------|
| Fulfillment hold on overdue accounts | S13 | `fulfillmentOrderHold` | [fulfillmentOrderHold](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/fulfillmentOrderHold) |

> **Pre-granted for S13**: Hold fulfillment for orders from accounts that are overdue or on credit hold via `fulfillmentOrderHold` (see `app/services/backstop.server.ts`). Requires `write_merchant_managed_fulfillment_orders` OR `write_third_party_fulfillment_orders`. Since this app is merchant-facing (not a fulfillment service), we use `write_merchant_managed_fulfillment_orders`.

## Dev Seed Script

The seed script (`scripts/seed.ts`) runs with **the same 9 production scopes** — no separate dev app needed. It uses **only the dev-store token** (`SHOPIFY_ADMIN_TOKEN` env var) and refuses to run on any shop other than the one in the `ALLOWED_DEV_STORE` env var (a GitHub Actions secret in CI), and refuses to run at all if it is unset.

### How the Seed Uses Production Scopes

| Feature | Scope | Mutation | Reference |
|---------|-------|----------|-----------|
| Create B2B companies | write_companies | `companyCreate` | [companyCreate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/companyCreate) |
| Create company locations (Net 15/30/60) | write_companies | `companyLocationCreate` | [companyLocationCreate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/companyLocationCreate) |
| Set payment terms on location | write_companies | `companyLocationUpdate` with `buyerExperienceConfiguration.paymentTermsTemplateId` | [companyLocationUpdate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/companyLocationUpdate) |
| Create orders with custom line items | write_orders | `orderCreate` with title + priceSet (no variantId needed) | [orderCreate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/orderCreate) |
| Backdate orders | write_orders | `orderCreate` with `processedAt` | [OrderCreateOrderInput.processedAt](https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/OrderCreateOrderInput) |

### Backdating with processedAt

Orders are backdated using `processedAt` from [OrderCreateOrderInput](https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/OrderCreateOrderInput): *"The date and time when the order was created."* This creates overdue invoices for testing S9 due date inference.

### Why No Additional Scopes Are Needed

**No `write_draft_orders`**: The seed uses `orderCreate` with custom line items instead of draft orders. Custom line items only require `title` + `priceSet` — no product or variant lookup needed.

**No `read_products`**: Custom line items bypass the product catalog entirely. See [OrderCreateLineItemInput](https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/OrderCreateLineItemInput).

**No `write_payment_terms`**: Payment terms are configured on company locations via `companyLocationUpdate` with `buyerExperienceConfiguration.paymentTermsTemplateId` (requires `write_companies`). If Shopify doesn't inherit these terms to orders created via API, S9 inference uses DB defaults instead (BuyerAccount.defaultTermsDays or AccountSource tag rules).

**FIXED terms not supported**: FIXED payment terms require a specific `dueAt` date per order, which cannot be expressed through location templates. The seed only creates NET terms (15, 30, 60 days).

### Payment Terms Inheritance (Warning, Not Failure)

`OrderCreateOrderInput` does not have a `paymentTerms` field. We rely on Shopify inheriting terms from `companyLocationId`. If orders come back with null `paymentTerms`:
- The seed logs a **warning** (not a failure) with counts of inherited vs inferred
- S9 inference computes due dates from DB defaults seeded by this script
- **No `write_payment_terms` scope is added** (Team Lead scope decision)

## Scopes NOT in Production

- **`read_companies`**, **`read_customers`**, **`read_orders`**: Dropped in S24. Implied by their write counterparts.
- **`write_payment_terms`**: Not needed. Payment terms are configured via `companyLocationUpdate` (requires `write_companies`).
- **`write_draft_orders`**: Not in production. For local dev, create `shopify.app.dev.toml`.
- **`read_locations`**: Not requested. Not needed for app functionality.

## Final Production Scope List (9)

```
read_all_orders,read_draft_orders,read_payment_terms,write_companies,write_customers,write_merchant_managed_fulfillment_orders,write_orders,write_payment_customizations,write_validations
```

## Protected Customer Data

**Status:** PCD Level 1 (Name, Email): completed, pending Shopify review, not yet approved

**Level:** Level 1 + Name + Email

| Field | Fetched | Stored | Purpose |
|-------|---------|--------|---------|
| `id` | ✅ | ✅ | Customer GID for account linking |
| `tags` | ✅ | ✅ | Net-terms eligibility matching |
| `email` | ✅ | ✅ | S8 labels, S16 payment matching, S18 reminders |
| `displayName` | ✅ | ✅ | S8 labels, S16 payment matching |
| `phone` | ❌ | ❌ | Not approved, blocked in code |
| `addresses` | ❌ | ❌ | Not approved, blocked in code |
| `firstName` | ❌ | ❌ | Not approved, blocked in code |
| `lastName` | ❌ | ❌ | Not approved, blocked in code |
| `defaultAddress` | ❌ | ❌ | Not approved, blocked in code |

**Environment variable:** `CUSTOMER_PII_FIELDS=1` (set in wrangler.jsonc)

**Code enforcement:**
- `CUSTOMER_FORBIDDEN_FIELDS` in `app/services/sync/customer-fields.server.ts` blocks phone/address fields
- `validateNoForbiddenFields()` throws on any query containing forbidden fields
- Tests verify forbidden fields are never included, even with `CUSTOMER_PII_FIELDS=1`
