# Access Control & Data Loss Prevention — Net Terms Receivables

**Owner:** Raghav  
**Audited Commit:** `df77eae4f4abe0caf3fec2a94d339f83cc458403`  
**Last Updated:** 2026-10-25

---

## 1. Production Data Access

### 1.1 Human Access

| Person | Access Level | Notes |
|--------|--------------|-------|
| Raghav (Owner) | Full access to Supabase, Cloudflare, GitHub, Shopify Partners | Proposed, pending owner review. Sentry and Resend not yet enabled. |

**Proposed, pending owner review:** Admin access to each service is limited to the owner.
- **Supabase:** [Unverified — Raghav to confirm]
- **Shopify Partners:** [Unverified — Raghav to confirm]

### 1.2 Automated Access

| System | Token Type | Scope | Notes |
|--------|-----------|-------|-------|
| Cloudflare Workers | Hyperdrive binding | Database read/write via connection string | Runtime DB access; pooled connections |
| GitHub Actions CI | `DATABASE_URL_MIGRATIONS`, `DATABASE_URL_SESSION` | Prisma migrations; prod-diagnostics; prod-readonly-query; prod-backfill-dry-run; prod-credit-status-backfill-dry-run; sync-vault-secrets; seed-dev-store | CI tests use ephemeral local Postgres; listed workflows connect to production |
| Shopify App | Offline access tokens | Per-shop scoped | Stored in `Session` table |
| Resend | API key | Email sending | Not yet enabled (`RESEND_API_KEY` not set) |
| Sentry | DSN | Error reporting | Not enabled (no `SENTRY_DSN`) |

**Proposed, pending owner review:** AI automation bots operate via scoped API tokens in their own environments:
- Cloudflare API token (Worker deployment)
- GitHub fine-grained token (repository access)
- Shopify Partner API token (Partner API access)
- Shopify app automation token (app release)
- Supabase access (database operations)

**GitHub Actions Secrets (by name):**
`AGE_RECIPIENT`, `ALLOWED_DEV_STORE`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `DATABASE_URL_MIGRATIONS`, `DATABASE_URL_SESSION`, `E2E_SHOP`, `JOBS_DRAIN_SECRET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_PARTNER_API_TOKEN`.

**Environment `shopify-release`:** `SHOPIFY_APP_AUTOMATION_TOKEN` (requires reviewer `raghavkhanna268`, main branch only).

**Worker Secrets:** `JOBS_DRAIN_SECRET`, `REMINDER_UNSUBSCRIBE_SECRET`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`.

---

## 2. Account Security

### 2.1 Two-Factor Authentication (2FA)

**Proposed, pending owner review:** 2FA status per account is not published in this public repository; it is tracked privately by the owner.

---

## 3. Shopify OAuth Scopes — Least Privilege

The app requests 8 scopes as defined in `shopify.app.toml:33`:

```
scopes = "read_draft_orders,read_payment_terms,write_companies,write_customers,write_merchant_managed_fulfillment_orders,write_orders,write_payment_customizations,write_validations"
```

### Read-Only Scopes (2)

| Scope | Purpose |
|-------|---------|
| `read_draft_orders` | View draft orders to calculate pending credit exposure |
| `read_payment_terms` | View payment terms on orders and company locations |

### Write Scopes (6)

| Scope | Purpose |
|-------|---------|
| `write_companies` | View and update B2B companies/locations for buyer account sync and credit status |
| `write_customers` | View and update customers for net-terms eligibility and credit status (requires PCD approval) |
| `write_merchant_managed_fulfillment_orders` | Place fulfillment holds on orders from overdue/held accounts |
| `write_orders` | View orders for invoice tracking, mark as paid, add status tags |
| `write_payment_customizations` | Configure payment method visibility based on account status |
| `write_validations` | Configure checkout validation to enforce credit limits and holds |

**Protected Customer Data:** `write_customers` (implies `read_customers`) requires Shopify PCD approval, Level 2 (protected customer fields: Name, Email only).

---

## 4. Data Loss Prevention Controls

### 4.1 safeLog Allowlist and Redaction

**Location:** `app/lib/log.server.ts`

The `safeLog()` function (lines 325-347) provides structured logging with automatic PII redaction:

- **Allowlisted keys** (lines 20-82): Only these fields pass through unredacted:
  - IDs: `shopId`, `shopHash`, `requestId`, `jobId`, `matchId`, `buyerAccountId`, `orderGid`, `invoiceId`, `customerId`, `companyId`, `locationId`, `sessionId`, `operationId`, `messageId`, `msgId`, and patterns `*Id`, `*Gid` (`webhookId` is banned per #332)
  - Operational: `topic`, `status`, `reason`, `reasonCode`, `code`, `err`, `errorCode`, `httpStatus`, `pgCode`, `*Count`, `count`, `durationMs`, `elapsedMs`, timestamps, booleans

- **Sensitive value patterns** (lines 88-96): These are always redacted:
  - Shop domains: `*.myshopify.com`
  - Email addresses: `@` pattern
  - Bearer tokens: `Bearer ...`
  - Shopify tokens: `shpat_*`, `shpua_*`, `shpss_*`
  - JWT-like strings: three-part dot-separated base64

- **shopHash()** function (lines 416-433): Hashes shop domains using SHA-256 (first 12 hex chars) for safe logging in compliance paths where no shopId exists. PR #260 (pending) switches this to HMAC-SHA-256 keyed by `LOG_HASH_KEY`, fail closed.

### 4.2 Sentry Scrubbing

**Location:** `app/lib/sentry.ts`

The Sentry configuration includes multiple layers of PII protection:

1. **Restrictive dataCollection** (lines 19-31): Disables all automatic data collection:
   - `userInfo: false`
   - `cookies: false`
   - `httpHeaders: false`
   - `httpBodies: []`
   - `urlQueryParams: false`
   - `graphQL: { document: false, variables: false }`
   - `databaseQueryData: false`
   - `stackFrameVariables: false`

2. **beforeSend scrubbing** (lines 83-137):
   - Deletes `request.headers`, `request.cookies`, `request.query_string`, `request.data`
   - Strips query string from `request.url`
   - Replaces `exception.value` with error code via `toErrorCode()`
   - Redacts `event.message` via `redactString()`
   - Deletes `event.breadcrumbs` entirely
   - Scrubs `event.extra`, `event.tags`, `event.contexts` to allowlist only: `shopId`, `code`, `requestId`, `jobId`, `topic`, `status`, `errorCode`

3. **Hostname enrichment disabled** (line 193): `enhanceFetchErrorMessages: false` prevents shop domains from appearing in fetch error messages.

### 4.3 AST Log Guard — CI Enforcement

**Location:** `scripts/ci/check-logging.ts`

The AST-based logging guard (2175 lines) runs in CI to prevent PII leaks at build time.

**Checked patterns:**
- `console.*`, `safeLog`, and Sentry method calls with sensitive data
- Template literals interpolating shop/domain identifiers
- `captureException` with raw catch variables (must use `captureExceptionWithTags`)
- Token prefix patterns (`shpat_`, `shpua_`, `shpss_`, `shpca_`, `shppa_`)
- Literal `myshopify.com` domains outside of validation patterns

**CI step:** `./scripts/ci/check-logging.sh` (see `.github/workflows/ci.yml`)

**Sensitive key patterns** (line 41):
```typescript
const SENSITIVE_PATTERN = /amount|paise|total|outstanding|balance|shop|domain|email|name|narration|payer|remitter|phone|address|note/i;
```

**Safe key allowlist** (lines 101-142): Documents which keys matching the deny pattern are actually safe (IDs, counts, code-controlled enums).

Existing violations are grandfathered in `scripts/ci/logging-allowlist.txt` (9 entries).

### 4.4 Logger Mock Allowlist

**Location:** `scripts/ci/logger-mock-allowlist.txt`

Tests that mock `safeLog`, `toErrorCode`, or `shopHash` must be explicitly allowlisted with a justification. The allowlist is currently empty, meaning no tests mock the logger.

**CI enforcement:** `check-logging.ts` Gap 5 (lines 1715-1905) scans test files for logger mocks. Violations without an allowlist entry fail CI.

### 4.5 CUSTOMER_PII_FIELDS Gating

**Environment variable:** `CUSTOMER_PII_FIELDS`

**Enabled in production** (`wrangler.jsonc:42`, PCD Level 2 (protected customer fields: Name, Email only) per the comment at line 39).

When enabled (`"1"`), the app fetches and stores buyer email and display name in `s8_tagged_customers.email` and `s8_tagged_customers.display_name`.

**References:**
- Environment definition: `wrangler.jsonc:42` (`"CUSTOMER_PII_FIELDS": "1"`)
- Usage in drain: `workers/app.ts:44` passes `env` to request context for handlers to check

---

## 5. Additional Security Controls

### 5.1 Webhook Verification

- **HMAC-SHA256:** Webhooks verified by `verifyWebhook()` (constant-time compare, `app/lib/webhook-verify.server.ts:127-136`, `:241`) or, for `bulk_operations/finish`, the Shopify library's `authenticate.webhook` (`webhooks.bulk_operations.finish.tsx:33`)
- **Payload shop verification:** Compliance webhooks verify `payload.shop_domain` matches header `X-Shopify-Shop-Domain` to prevent forged deletions (`webhooks.compliance.tsx:89`, `:176`, `:212`)

### 5.2 Session Isolation

- Sessions scoped per shop via `offline_{shop}` session ID format
- Shop domain validated on all webhook handlers

### 5.3 Token Handling

- `Session.accessToken` (`prisma/schema.prisma:123`) and `Session.refreshToken` (`:132`) are stored as plain-text columns and are not encrypted by the app (app-level encryption: not implemented, tracked in issue #266). Supabase encrypts data at rest with AES-256 (provider-managed, per [Supabase security](https://supabase.com/security)).
- Refresh token rotation handled by `app/lib/offline-token.server.ts`
- Invalid tokens trigger `needsReauth` flag (`prisma/schema.prisma:136`) requiring merchant re-authentication

### 5.4 Per-Shop Scoping

Queries are filtered by `shopId` and `session.shop` in loaders and services to ensure shop isolation:
- Invoice queries: `app/services/sync/order.server.ts:117` (`WHERE "shopId" = ${shopId}`)
- Buyer account queries: `app/routes/app._index.tsx:188` (`WHERE "shopId" = ${shopId}`)
- Tagged customer queries: `app/services/sync/customer.server.ts:204` (`WHERE shop_id = ${shopId}`)

FK constraints do not prevent cross-shop reads; isolation is enforced in application code.
