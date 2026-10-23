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
4. Enter the shop domain (e.g., `net-terms-receivables.myshopify.com`)
5. Click **Run workflow**

### Output Interpretation

#### Step 1: Session Check

Queries the `Session` table and displays:

| Field | Meaning |
|-------|---------|
| `shop` | Shopify shop domain |
| `isOnline` | `true` = staff user session, `false` = offline (app) session |
| `scope` | OAuth scopes granted to the session |
| `hasAccessToken` | `true` if access token is present and non-empty |
| `expires` | Session expiration timestamp (null for offline sessions) |

**Common issues:**
- No rows returned → Shop has uninstalled or never installed
- `hasAccessToken = false` → Token revoked or corrupted session
- Missing `scope` → OAuth flow incomplete

#### Step 2: Protected Customer Data Probe

Calls the Shopify Admin GraphQL API with the offline token and reports:

| Field | Meaning |
|-------|---------|
| `customer_found` | `true` if at least one customer exists |
| `email_non_null` | `true` if the first customer has an email |
| `email_not_redacted` | `true` if email looks like a real address (not redacted) |
| `first_name_non_null` | `true` if first name is present |
| `last_name_non_null` | `true` if last name is present |
| `graphql_errors` | Array of error messages/codes if the query failed |

**Common issues:**
- `customer_found = false` → Shop has no customers yet
- `email_non_null = false` with `customer_found = true` → PCD scopes not approved
- `email_not_redacted = false` → Customer has redacted email (test account or GDPR)
- `graphql_errors` present → Check error codes for scope issues (403) or rate limits (429)

### Security Notes

- The workflow runs with `permissions: contents: read` only
- Access token is masked via `::add-mask::` before any use
- No customer PII (email, names, IDs) is printed in logs
- No artifacts are uploaded
- All values passed via environment variables, not command-line arguments
