# Operations Runbook

This document describes operational procedures for the Net Terms Receivables app.

---

## Production Diagnostics Workflow

A manually-triggered GitHub Actions workflow for read-only diagnostics against the Mumbai Supabase production database.

### When to Use

- Verify OAuth session state for a shop after install/reinstall
- Check if offline access token exists and is valid
- Confirm protected customer data (PCD) scopes are working
- Debug customer API access issues without exposing PII

### How to Run

1. Go to **Actions** → **Prod Diagnostics** in GitHub
2. Click **Run workflow**
3. Select `main` branch (required - workflow only runs from main)
4. Enter the shop domain (e.g., `<your-dev-store>.myshopify.com`)
5. Optionally check **fail_on_expired** for strict mode (fails if token expired)
6. Click **Run workflow**

### Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `shop` | `<your-dev-store>.myshopify.com` | Shopify shop domain |
| `fail_on_expired` | `false` | If true, fail the workflow when the offline token has expired |

### Output Interpretation

#### Step 1: Session Check

Queries the `Session` table and displays:

| Field | Meaning |
|-------|---------|
| `shop` | Shopify shop domain |
| `isOnline` | `true` = staff user session, `false` = offline (app) session |
| `scope` | OAuth scopes granted to the session |
| `hasAccessToken` | `true` if access token is present and non-empty |
| `expires` | Session expiration timestamp. For expiring offline tokens (`future.expiringOfflineAccessTokens: true`), this is set; null only for legacy non-expiring tokens |

Additionally, for the offline session:

| Field | Meaning |
|-------|---------|
| `token_expired` | `true` if the offline token's `expires` timestamp has passed |
| `has_refresh_token` | `true` if a refresh token is stored (can be used to renew) |

**Common issues:**
- No rows returned → Shop has uninstalled or never installed
- `hasAccessToken = false` → Token revoked or corrupted session
- Missing `scope` → OAuth flow incomplete
- `token_expired = true` → Offline token has expired; see "Token Expiration" below

#### Step 2: Protected Customer Data Probe

Calls the Shopify Admin GraphQL API with the offline token and reports:

| Field | Meaning |
|-------|---------|
| `customer_found` | `true` if at least one customer exists |
| `email_non_null` | `true` if the first customer has an email |
| `email_not_redacted` | `true` if email looks like a real address (not redacted) |
| `first_name_non_null` | `true` if first name is present |
| `last_name_non_null` | `true` if last name is present |
| `graphql_error_codes` | Array of GraphQL error codes if the query failed |

**Common issues:**
- `customer_found = false` → Shop has no customers yet
- `email_non_null = false` with `customer_found = true` → PCD scopes not approved
- `email_not_redacted = false` → Customer has redacted email (test account or GDPR)
- `graphql_error_codes` present → Check error codes for scope issues or rate limits

**Possible status values:**
- `success` → API call succeeded, boolean fields populated
- `skipped` → Token expired, API call not attempted
- `auth_failed` → HTTP 401/403, token invalid or revoked
- `error` → Other API error (e.g., rate limit, server error)

#### Step 3: Database Extensions and Jobs Check

Checks database infrastructure required for S10 background jobs.

**Extensions status:**

| Field | Meaning |
|-------|---------|
| `pgmq_installed` | `true` if pgmq extension is installed |
| `pg_cron_installed` | `true` if pg_cron extension is installed |
| `pg_net_installed` | `true` if pg_net extension is installed |
| `supabase_vault_installed` | `true` if supabase_vault extension is installed |

**Cron jobs (if pg_cron is installed):**

Lists all cron jobs showing `jobid`, `jobname`, `schedule`, `active`. The `command` column is never printed (may contain URLs or secrets).

| Field | Meaning |
|-------|---------|
| `s10_drain_job_exists` | `true` if the `s10_drain_every_minute` job exists |
| `s10_drain_job_active` | `true` if the drain job is active |

**Vault secrets (if supabase_vault is installed):**

| Field | Meaning |
|-------|---------|
| `vault_schema_exists` | `true` if the vault schema exists |
| `jobs_drain_secret_exists` | `true` if the `jobs_drain_secret` entry exists |
| `jobs_drain_url_exists` | `true` if the `jobs_drain_url` entry exists |

**Note:** The workflow queries `vault.secrets` by name only. It never selects `decrypted_secret`.

**Common issues:**
- Extension not installed → Enable in Supabase Dashboard > Database > Extensions
- `cron_schema_exists = false` → pg_cron not installed or not configured
- `vault_schema_exists = false` → supabase_vault not installed
- `s10_drain_job_exists = false` → S10 migration not applied
- `jobs_drain_*_exists = false` → Run the Sync Vault Secrets workflow

### Token Expiration

This app uses expiring offline access tokens (`future.expiringOfflineAccessTokens: true` in `shopify.app.toml`). Offline tokens have an `expires` timestamp and must be periodically refreshed.

**When `token_expired = true`:**

The workflow skips the Admin API probe and exits successfully (exit 0) unless `fail_on_expired = true`.

**Why the workflow doesn't refresh the token:**

This workflow is strictly read-only. Refreshing an expired token via Shopify's OAuth refresh endpoint would:
1. Return a new access token and a **new refresh token**
2. Invalidate the old refresh token

Without writing the new tokens back to the database, the app's session would be permanently broken. The drain path does not yet include token refresh, so this workflow must not attempt it.

**How to renew an expired token:**

1. **Open the app in Shopify admin** — The embedded app OAuth flow automatically refreshes the token when a merchant opens the app
2. **Implement a refresh flow** — A future background job could refresh tokens before expiry and write them back to the database

### Security Notes

- The workflow runs with `permissions: contents: read` only
- Database queries use `PGOPTIONS='-c default_transaction_read_only=on'` to enforce read-only mode
- Access token is masked via `::add-mask::` before any use
- Access token is passed to curl via `--config` file (mode 600), never on argv
- No customer PII (email, names, IDs) is printed in logs — only boolean indicators
- Error responses only print HTTP status and GraphQL error codes, never raw bodies
- No artifacts are uploaded
- All values passed via environment variables, not command-line arguments
- Temp files are cleaned up via trap on EXIT

### Optional: GitHub Environment Protection

The workflow can be gated on a GitHub Environment named `production` for additional approval control. To enable:

1. Go to **Settings** → **Environments** → **New environment**
2. Name it `production`
3. Configure required reviewers or other protection rules
4. Uncomment the `environment: production` line in the workflow

When configured, the workflow will require approval before running diagnostics against production.

---

## S18: Reminder Unsubscribe Secret Rotation

To rotate `REMINDER_UNSUBSCRIBE_SECRET` without breaking links in already-sent emails:

1. Copy the current secret to `REMINDER_UNSUBSCRIBE_SECRET_PREVIOUS`
2. Set a new value for `REMINDER_UNSUBSCRIBE_SECRET`
3. After all old-secret links have expired (links are valid indefinitely, so wait for the oldest campaign's opt-out window), remove `REMINDER_UNSUBSCRIBE_SECRET_PREVIOUS`
