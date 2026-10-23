# OAuth Scopes

This document lists all OAuth scopes requested by the Net Terms Receivables app, the features that use them, and the exact API calls that require them.

**Scope bar policy**: Production config (`shopify.app.toml` and `wrangler.jsonc` SCOPES) may only include scopes that a planned, shipped feature uses.

## Scopes

### read_companies

| Feature | Step | API Call | Reference |
|---------|------|----------|-----------|
| Company/location sync | S6 | `companies` query | [companies query](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/companies) |
| Company/location sync | S6 | `companyLocations` query | [companyLocations query](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/companyLocations) |
| Bulk companies export | S6 | `bulkOperationRunQuery` with companies | [bulkOperationRunQuery](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/bulkOperationRunQuery) |

### read_orders

| Feature | Step | API Call | Reference |
|---------|------|----------|-----------|
| Order sync | S6 | `orders` query | [orders query](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/orders) |
| Bulk orders export | S6 | `bulkOperationRunQuery` with orders | [bulkOperationRunQuery](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/bulkOperationRunQuery) |
| Order webhooks | S6 | orders/create, orders/updated, orders/cancelled, orders/paid | [Webhook topics](https://shopify.dev/docs/api/admin-rest/2026-10/resources/webhook) |

### read_payment_terms

| Feature | Step | API Call | Reference |
|---------|------|----------|-----------|
| Order payment terms | S6 | `Order.paymentTerms` field | [Order.paymentTerms](https://shopify.dev/docs/api/admin-graphql/2026-10/objects/Order#field-order-paymentterms) |
| Company location payment terms | S6 | `CompanyLocation.buyerExperienceConfiguration.paymentTermsTemplate` | [buyerExperienceConfiguration](https://shopify.dev/docs/api/admin-graphql/2026-10/objects/CompanyLocation#field-companylocation-buyerexperienceconfiguration) |

### read_customers

| Feature | Step | API Call | Reference |
|---------|------|----------|-----------|
| Tagged customer sync | S8 | `customers` query with tag filter | [customers query](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/customers) |

### read_draft_orders

| Feature | Step | API Call | Reference |
|---------|------|----------|-----------|
| Draft order payment terms | S8 | `draftOrders` query | [draftOrders query](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/draftOrders) |

### write_companies

| Feature | Step | API Call | Reference |
|---------|------|----------|-----------|
| Credit/hold metafields on Company | S11 | `metafieldsSet` with Company ownerId | [metafieldsSet](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/metafieldsSet) |
| Credit/hold metafields on CompanyLocation | S11 | `metafieldsSet` with CompanyLocation ownerId | [metafieldsSet](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/metafieldsSet) |
| Dev store seed | S4 | `companyCreate`, `companyLocationCreate` | [companyCreate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/companyCreate) |

> **Note**: `metafieldsSet` requires the same access level needed to mutate the owner resource. For Company/CompanyLocation metafields, this requires `write_companies`.

### write_customers

| Feature | Step | API Call | Reference |
|---------|------|----------|-----------|
| Credit/hold metafields on Customer | S11 | `metafieldsSet` with Customer ownerId | [metafieldsSet](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/metafieldsSet) |

> **Note**: `metafieldsSet` requires the same access level needed to mutate the owner resource. For Customer metafields, this requires `write_customers`.

### write_orders

| Feature | Step | API Call | Reference |
|---------|------|----------|-----------|
| Mark order as paid after bank match | S17 | `orderMarkAsPaid` | [orderMarkAsPaid](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/orderMarkAsPaid) |
| Add tags to orders | S13, S17 | `tagsAdd` with Order id | [tagsAdd](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/tagsAdd) |
| Dev store seed | S4 | `orderCreate` | [orderCreate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/orderCreate) |

### write_payment_terms

| Feature | Step | API Call | Reference |
|---------|------|----------|-----------|
| Dev store seed | S4 | `paymentTermsCreate` | [paymentTermsCreate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/paymentTermsCreate) |

> **Note**: Payment terms are added to orders after creation using `paymentTermsCreate`, not as part of `orderCreate`.

### write_merchant_managed_fulfillment_orders

| Feature | Step | API Call | Reference |
|---------|------|----------|-----------|
| Fulfillment hold on overdue accounts | S13 | `fulfillmentOrderHold` | [fulfillmentOrderHold](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/fulfillmentOrderHold) |
| Release fulfillment hold | S13 | `fulfillmentOrderReleaseHold` | [fulfillmentOrderReleaseHold](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/fulfillmentOrderReleaseHold) |

> **Note**: Both mutations require `write_merchant_managed_fulfillment_orders` OR `write_third_party_fulfillment_orders`. Since this app is merchant-facing (not a fulfillment service), we use `write_merchant_managed_fulfillment_orders`.

### write_payment_customizations

| Feature | Step | API Call | Reference |
|---------|------|----------|-----------|
| Payment method customization function | S13 | `paymentCustomizationCreate` | [paymentCustomizationCreate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/paymentCustomizationCreate) |

### write_validations

| Feature | Step | API Call | Reference |
|---------|------|----------|-----------|
| Cart/checkout validation function | S12 | `validationCreate` | [validationCreate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/validationCreate) |

## Scopes NOT in Production Config

### write_draft_orders

**Not required.** The dev store seed uses `orderCreate` + `paymentTermsCreate` instead of draft orders.

The `orderCreate` mutation supports:
- `companyLocationId` for B2B orders (see [OrderCreateOrderInput](https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/OrderCreateOrderInput))
- Payment terms via separate `paymentTermsCreate` mutation (see [paymentTermsCreate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/paymentTermsCreate))

This approach avoids needing `write_draft_orders` in production.

## Final Scope List

```
read_companies,read_customers,read_draft_orders,read_orders,read_payment_terms,write_companies,write_customers,write_merchant_managed_fulfillment_orders,write_orders,write_payment_customizations,write_payment_terms,write_validations
```

## Audit Reminder

Before S24: audit requested scopes and drop any that no merged code uses. See `docs/launch-checklist.md`.
