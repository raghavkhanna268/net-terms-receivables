# Incident Response Plan — Net Terms Receivables

**Owner:** Raghav  
**Audited Commit:** `df77eae4f4abe0caf3fec2a94d339f83cc458403`  
**Last Updated:** 2026-10-25

---

## 1. Detection

### 1.1 Sentry Error Monitoring

Sentry is initialised in the Cloudflare Workers entry point via `wrapWithSentry()`:

- **Initialisation:** `workers/app.ts:16` wraps the worker handler with Sentry
- **Configuration:** `app/lib/sentry.ts:173-199` configures the Sentry SDK with:
  - `dataCollection` set to restrictive mode (lines 19-31)
  - `beforeSend` / `beforeSendTransaction` scrubbing hooks (lines 140-150)

Sentry captures:
- Uncaught exceptions from request handlers
- SSR render errors via `handleError` in `app/entry.server.tsx:12-23`
- Manually captured exceptions via `captureExceptionWithTags` (e.g., `app/entry.server.tsx:22`)

### 1.2 Worker Logs

The application emits structured JSON logs via `safeLog()` (`app/lib/log.server.ts:325-347`):

- **Format:** Single-line JSON with `event` field and redacted metadata
- **Redaction:** PII is automatically redacted per the allowlist (lines 20-82)
- **Sensitive patterns:** Shop domains, emails, and tokens are redacted (lines 88-96)

Log events for security monitoring include:
- `shop_redact_deleted` / `shop_redact_not_found` — compliance deletions
- `offline_token_invalid_grant` / `offline_token_no_refresh_token` — authentication failures
- `data_request_email_sent` / `data_request_email_skipped` — data request notifications

Worker logs are accessible via Cloudflare dashboard (Workers → Logs) or `wrangler tail`.

---

## 2. Triage — Severity Levels

| Severity | Definition | Example |
|----------|------------|---------|
| **Critical** | Active breach, data exfiltration, or customer PII exposed | Compromised API token, unredacted PII in logs, DB breach |
| **High** | Potential breach, vulnerability exploited, compliance failure | Shop/redact webhook failing, refresh token leak, HMAC bypass |
| **Medium** | Security control degraded, non-PII data affected | Sentry scrubbing misconfigured, rate limiting failure |
| **Low** | Informational, potential future risk | Dependency vulnerability (no exploit), logging gap |

---

## 3. Containment

### 3.1 Immediate Actions by Severity

**Critical:**
1. Disable the app via Shopify Partners Dashboard (removes from all merchants)
2. Rotate all secrets (see 3.2)
3. Notify Shopify Partner Security immediately

**High:**
1. Rotate affected credentials
2. Deploy fix or revert to last-known-good commit
3. Review Cloudflare Workers logs for scope of impact

**Medium/Low:**
1. Document the issue
2. Schedule fix in next deployment cycle

### 3.1.1 Application Disable Levers

**Proposed, pending owner review:**

| Lever | Command | Status |
|-------|---------|--------|
| **Roll back Worker** | `wrangler deployments list` / `wrangler versions list` then `wrangler rollback [version-id] -m "<reason>"` or `wrangler versions deploy <id>@100` | Verified (list); available, not exercised (rollback) |
| **Stop deploys** | `gh workflow disable deploy.yml` / `gh workflow enable deploy.yml` | Available, not exercised. `deploy.yml` triggers on push to main + workflow_dispatch |
| **Stop migrations** | `gh variable set ENABLE_MIGRATIONS --body false` | Available, not exercised. `migrate.yml` skips when `vars.ENABLE_MIGRATIONS == 'false'` (`.github/workflows/migrate.yml:31`); currently unset |
| **Disable Hyperdrive caching** | `wrangler hyperdrive update <hyperdrive-id> --caching-disabled` | Verified (used) |

**Feature flags (`wrangler.jsonc`):** `PLAN_GATING_ENFORCED`, `CUSTOMER_PII_FIELDS`. No other kill switches.

### 3.2 Secret Rotation

**Proposed, pending owner review:** All secrets can be rotated via `wrangler secret put SECRET_NAME` or `gh secret set`. Deploy via `deploy.yml` (pushes Worker secrets via `--secrets-file`).

| Secret | Location | Rotation Procedure | Status |
|--------|----------|-------------------|--------|
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | Worker secret, GitHub Actions | Regenerate in Shopify Dev Dashboard [Unverified steps]; `gh secret set SHOPIFY_API_SECRET`; redeploy or `wrangler secret put` | Proposed, not exercised |
| `RESEND_API_KEY` | Worker secret | Regenerate in Resend dashboard → API Keys; `wrangler secret put` | Proposed, not exercised |
| `REMINDER_UNSUBSCRIBE_SECRET` | Worker secret | See `docs/ops.md:171-178`: copy to `_PREVIOUS`, then put new | Proposed, not exercised |
| `JOBS_DRAIN_SECRET` | Vault + Worker secret | See `docs/ops/s10-jobs.md:97-106`; expect brief 401s between Vault sync and Worker update | Proposed, not exercised |
| Supabase DB password | Hyperdrive, GitHub Actions | Reset in Supabase dashboard ([Supabase docs](https://supabase.com/docs/guides/troubleshooting/how-do-i-reset-my-supabase-database-password-oTs5sB)); expect brief 28P01 auth errors; `wrangler hyperdrive update <hyperdrive-id> --origin-password` ([Hyperdrive docs](https://developers.cloudflare.com/hyperdrive/reference/wrangler-commands/)); `gh secret set DATABASE_URL_MIGRATIONS` and `DATABASE_URL_SESSION`; update automation copies | Proposed, not exercised |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions | Create new token in Cloudflare dashboard → API Tokens; `gh secret set`; revoke old | Proposed, not exercised |
| `SHOPIFY_PARTNER_API_TOKEN` | GitHub Actions | Partners Dashboard > Settings > Partner API clients (owner only; [Partner API docs](https://shopify.dev/docs/api/partner#authentication)); `gh secret set` | Proposed, not exercised |
| `SHOPIFY_APP_AUTOMATION_TOKEN` | GitHub Actions (`shopify-release` env) | `gh secret set SHOPIFY_APP_AUTOMATION_TOKEN --env shopify-release`; regeneration [Unverified — Raghav to confirm] | Proposed, not exercised |
| `R2_SECRET_ACCESS_KEY` | GitHub Actions | Rotated 2026-10-25 | Done |

### 3.3 Offline Token Revocation

**Proposed, pending owner review:**

If an offline access token is compromised:
1. Mark the session `needsReauth=true` in the database (`prisma/schema.prisma:136`)
2. Setting `needsReauth=true` stops this app's background jobs from using/refreshing the token (`app/lib/offline-token.server.ts:197-203`, `:409-414`)
3. **Important:** This does NOT revoke the token at Shopify. Shopify app tokens are invalidated on uninstall; for a compromised offline token, force reinstall to revoke. The affected shop will need to re-authenticate on next access.

Note: No direct "revoke token" API call is implemented in this codebase.

---

## 4. Notification

**Proposed, pending owner review:**

### 4.1 Internal Timeline

| Action | Timeline |
|--------|----------|
| Incident detected | T+0 |
| Initial triage complete | [TBD — Raghav to decide] |
| Containment actions begun | [TBD — Raghav to decide] |
| Affected scope determined | [TBD — Raghav to decide] |
| Post-mortem scheduled | [TBD — Raghav to decide] |

### 4.2 Merchant Notification

For incidents affecting merchant data:

| Severity | Notification Method | Timeline |
|----------|-------------------|----------|
| Critical | Email to affected shop owner(s) | [TBD — Raghav to decide] |
| High | Email to affected shop owner(s) | [TBD — Raghav to decide] |
| Medium/Low | In-app banner or changelog | [TBD — Raghav to decide] |

### 4.3 Shopify Notification

Per [Shopify Partner Program Agreement](https://www.shopify.com/partners/terms) §1(vi):
- **Data Breach:** "notify Shopify of any actual or suspected breach or compromise of Merchant Data... immediately upon, but no later than twenty-four (24) hours of, becoming aware of such occurrence"
- **Contact:** Report via [Shopify Partner Support](https://help.shopify.com/questions/partners)

---

## 5. Regulatory Breach Notification

**Proposed, pending owner review:**

### 5.1 GDPR (EU)

Per [GDPR Article 33](https://gdpr-info.eu/art-33-gdpr/):
- **Controller duties (Art. 33(1)):** The merchant (Controller) must notify the supervisory authority within **72 hours** of becoming aware of a personal data breach, and notify data subjects without undue delay if high risk.
- **Our role as Processor (Art. 33(2)):** We notify the merchant (the Controller) without undue delay so they can meet their Article 33 duties.
- **Authority:** Supervisory authority of the lead establishment (or affected Member State).

### 5.2 DPDP Rules 2025 (India)

Per the [Digital Personal Data Protection Rules, 2025](https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf) (MeitY, published 14 Nov 2025):
- **Rule 7(2)(b) — Breach notification:** The Data Fiduciary (merchant) must intimate the Board "within seventy-two hours of becoming aware of the breach, or within such longer period as the Board may allow on a request made in writing".
- **Our role as Processor:** We notify the merchant (the Data Fiduciary) without delay so they can meet their Rule 7 duties.
- **Commencement:** [Unverified — Raghav/lawyer to confirm dates from official text]

---

## 6. Post-Mortem

**Proposed, pending owner review:**

### 6.1 Template

Every Critical or High severity incident requires a post-mortem within [TBD — Raghav to decide] days:

1. **Timeline:** Detailed chronology of events
2. **Root Cause:** Technical and process failures
3. **Impact:** Affected merchants, data categories, duration
4. **Detection:** How was the incident discovered? Could detection have been faster?
5. **Containment:** What actions were taken? Were they effective?
6. **Remediation:** What fixes were deployed?
7. **Prevention:** What changes prevent recurrence?

### 6.2 Follow-Up Actions

- Update this incident response plan if gaps identified
- File security issues with `security` label in GitHub
- Review and update monitoring/alerting as needed

---

## 7. Contacts

**Proposed, pending owner review:**

| Role | Contact | Notes |
|------|---------|-------|
| Incident Owner | Raghav Khanna (raghavkhanna468@gmail.com) | All roles |
| Shopify Partner Security | Raghav Khanna (raghavkhanna468@gmail.com) | For breach notification |
| Sentry Account Owner | Raghav Khanna (raghavkhanna468@gmail.com) | For log access |
| Cloudflare Account Owner | Raghav Khanna (raghavkhanna468@gmail.com) | For worker management |
| Legal/DPO | Raghav Khanna (raghavkhanna468@gmail.com) | For regulatory notification |

---

## Revision History

| Date | Author | Change |
|------|--------|--------|
| 2026-10-25 | Cursor Agent | Initial version |
