# S24 Scope Audit: Production OAuth scope verification

**Audit date:** 2026-10-25  
**Auditor:** QA

This document records the S24 scope reduction from 11 to 8 production OAuth scopes.

## Summary: Scope Reduction

Per [Shopify Access Scopes documentation](https://shopify.dev/docs/api/usage/access-scopes) 'How it works' section:
> "Any scope that writes a resource also grants read access to it, so request the write scope only when your app needs both."

**Dropped scopes (3):**
- `read_companies` — implied by `write_companies`
- `read_customers` — implied by `write_customers`
- `read_orders` — implied by `write_orders`

**Remaining scopes (8):**
| Scope | Status | Evidence |
|-------|--------|----------|
| `read_draft_orders` | **USED** | `shopify.app.toml` draft_orders/* webhook subscription, `app/routes/webhooks.draft_orders.tsx`, `app/services/sync/draft-order.server.ts` |
| `read_payment_terms` | **USED** | `app/services/sync/bulk-operations.server.ts` (Order.paymentTerms, CompanyLocation.buyerExperienceConfiguration.paymentTermsTemplate) |
| `write_companies` | **USED** | `app/lib/metafield-definitions.server.ts` (metafieldDefinitionCreate on COMPANY_LOCATION), implies read_companies |
| `write_customers` | **USED** | `app/lib/metafield-definitions.server.ts` (metafieldDefinitionCreate on CUSTOMER), implies read_customers |
| `write_merchant_managed_fulfillment_orders` | **PRE-GRANTED (S13)** | Reserved for fulfillmentOrderHold/fulfillmentOrderReleaseHold |
| `write_orders` | **PRE-GRANTED (S17)** | Reserved for orderMarkAsPaid, tagsAdd, tagsRemove; implies read_orders |
| `write_payment_customizations` | **PRE-GRANTED (S13)** | Reserved for paymentCustomizationCreate |
| `write_validations` | **USED** | `app/lib/validation-registration.server.ts` (validationCreate for credit-check-validation Function) |

---

## Verification: No Code Requires Dropped Scopes

### Grep Evidence

No production code, check, or test requires the literal strings `read_companies`, `read_customers`, or `read_orders` as scope requirements:

```bash
# Files containing these strings (excluding schema fixture and docs):
rg "read_companies|read_customers|read_orders" --type ts --type tsx -l | grep -v test/fixtures | grep -v docs/

# Result: Only test fixtures use these as example scope strings in session storage tests.
# These are arbitrary example values, not scope validation logic.
```

The app does NOT:
- Check for specific read scopes in afterAuth
- Validate session.scope contains specific read scopes
- Reject API calls based on missing read scopes (Shopify handles this via ACCESS_DENIED)

### Runtime Scope Handling

1. **app/scopes_update webhook**: Stores whatever scopes Shopify grants. Does not validate against expected list.
2. **afterAuth**: Does not check granted scopes against required scopes.
3. **API calls**: Rely on Shopify returning ACCESS_DENIED errors, handled generically by shopify-client.server.ts.
4. **Session storage**: Stores scope string as-is; no validation logic.

---

## Scopes NOT in Production

| Scope | Reason |
|-------|--------|
| `read_companies` | **DROPPED S24**: Implied by `write_companies` |
| `read_customers` | **DROPPED S24**: Implied by `write_customers` |
| `read_orders` | **DROPPED S24**: Implied by `write_orders` |
| `write_payment_terms` | Not needed; use `companyLocationUpdate` with `write_companies` |
| `write_draft_orders` | Not in production; for local dev only |
| `read_locations` | Not requested; not needed for app functionality |
| `read_all_orders` | Protected scope; requires separate Partner Dashboard approval |

---

## Release Guard Validation

`scripts/ci/shopify_release_guards.py` enforces exactly 8 approved scopes:

```python
APPROVED_SCOPES = {
    "read_draft_orders", "read_payment_terms",
    "write_companies", "write_customers",
    "write_merchant_managed_fulfillment_orders", "write_orders",
    "write_payment_customizations", "write_validations",
}
```

Any scope outside this set (e.g., `read_locations`) causes the guard to fail.

---

## Shopify Behaviour: Stores with Old 11 Scopes

Stores that previously granted the old 11 scopes will continue to work. Shopify:
- Does not revoke granted scopes when app requests fewer
- Returns the full granted scope list in `app/scopes_update` webhook
- Session stores the granted scopes, which may exceed requested scopes

The app does NOT loop on re-auth because it does not compare granted scopes against requested scopes. The `app/scopes_update` handler simply stores whatever Shopify reports.

---

## Audit Method

1. Read `shopify.app.toml` scopes configuration
2. Read `wrangler.jsonc` SCOPES var
3. Ran `rg` searches for dropped scope strings in production code
4. Reviewed webhook handlers, afterAuth logic, session storage
5. Verified release guard rejects scopes outside approved set
