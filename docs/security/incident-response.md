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
1. Disable the app via Shopify Partners Dashboard (removes from all merchants) [Raghav to confirm procedure]
2. Rotate all secrets (see 3.2)
3. Notify Shopify Partner Security immediately

**High:**
1. Rotate affected credentials
2. Deploy fix or revert to last-known-good commit
3. Review Cloudflare Workers logs for scope of impact

**Medium/Low:**
1. Document the issue
2. Schedule fix in next deployment cycle

### 3.2 Secret Rotation

All secrets are stored in Cloudflare Workers environment and can be rotated via:

```bash
wrangler secret put SECRET_NAME
```

| Secret | Location | Rotation Procedure |
|--------|----------|-------------------|
| `SHOPIFY_API_SECRET` | Cloudflare Workers (`wrangler secret put`) | Regenerate in Shopify Partners → App setup → Client credentials; redeploy [Raghav to confirm] |
| `SHOPIFY_API_KEY` | Cloudflare Workers (`wrangler secret put`) | Regenerate in Shopify Partners → App setup → Client credentials; redeploy [Raghav to confirm] |
| `RESEND_API_KEY` | Cloudflare Workers (`wrangler secret put`) | Regenerate in Resend dashboard → API Keys [Raghav to confirm] |
| `REMINDER_UNSUBSCRIBE_SECRET` | Cloudflare Workers (`wrangler.jsonc:61-64`) | Generate new HMAC key; set `_PREVIOUS` to old value during transition [Raghav to confirm] |
| `JOBS_DRAIN_SECRET` | Vault `jobs_drain_secret` (`jobs.drain.tsx:97-98`) | Regenerate in Vault; sync with `sync-vault-secrets` workflow [Raghav to confirm] |
| Hyperdrive DB password | Hyperdrive binding connection string | Rotate in Supabase; update Hyperdrive binding [Raghav to confirm] |
| `DATABASE_URL_MIGRATIONS` | GitHub Actions secret | Rotate in Supabase; update GitHub secret [Raghav to confirm] |
| `DATABASE_URL_SESSION` | GitHub Actions secret | Rotate in Supabase; update GitHub secret [Raghav to confirm] |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions secret | Regenerate in Cloudflare dashboard → API Tokens [Raghav to confirm] |
| `SHOPIFY_APP_AUTOMATION_TOKEN` | GitHub Actions secret (`shopify-app-release.yml:188`) | Regenerate in Shopify Partners [Raghav to confirm] |

### 3.3 Offline Token Revocation

If an offline access token is compromised:
1. Mark the session `needsReauth=true` in the database
2. Setting `needsReauth=true` stops this app's background jobs from using/refreshing the token (`app/lib/offline-token.server.ts:197-203`, `:409-414`)
3. **Important:** This does NOT revoke the token at Shopify; the leaked token stays valid until revoked by Shopify (e.g., uninstall/reinstall or secret rotation) [Raghav to confirm revocation procedure]
4. The affected shop will need to re-authenticate on next access

---

## 4. Notification

### 4.1 Internal Timeline

| Action | Timeline |
|--------|----------|
| Incident detected | T+0 |
| Initial triage complete | [Raghav to confirm] |
| Containment actions begun | [Raghav to confirm] |
| Affected scope determined | [Raghav to confirm] |
| Post-mortem scheduled | [Raghav to confirm] |

### 4.2 Merchant Notification

For incidents affecting merchant data:

| Severity | Notification Method | Timeline |
|----------|-------------------|----------|
| Critical | Email to affected shop owner(s) | [Raghav to confirm] |
| High | Email to affected shop owner(s) | [Raghav to confirm] |
| Medium/Low | In-app banner or changelog | [Raghav to confirm] |

### 4.3 Shopify Notification

Per [Shopify Partner Agreement](https://www.shopify.com/partners/terms):
- **Critical breaches:** Notify Shopify Partner Security immediately
- **Timeline:** [Raghav to confirm]
- **Contact:** [Raghav to confirm]

---

## 5. Regulatory Breach Notification

### 5.1 GDPR (EU)

Per GDPR Article 33:
- **Controller duties (Art. 33(1)):** The merchant (Controller) must notify the supervisory authority within 72 hours of becoming aware of a personal data breach, and notify data subjects without undue delay if high risk
- **Our role as Processor (Art. 33(2)):** We notify the merchant (the Controller) without undue delay so they can meet their Article 33 duties
- **Authority:** Supervisory authority of the lead establishment (or affected Member State)
- **Timelines:** [Raghav to confirm]

### 5.2 DPDP Rules 2025 (India)

Per the Digital Personal Data Protection Rules, 2025 (notified 13 Nov 2025):
- **Rule 7 — Breach notification:** The Data Fiduciary (merchant) must intimate each affected Data Principal and the Data Protection Board without delay; detailed report to the Board within 72 hours
- **Our role as Processor:** We notify the merchant (the Data Fiduciary) without delay so they can meet their Rule 7 duties
- **Commencement:** Rule 7 applies from 13 May 2027 (18 months after publication) [Raghav/lawyer to confirm dates]

---

## 6. Post-Mortem

### 6.1 Template

Every Critical or High severity incident requires a post-mortem within [Raghav to confirm] days:

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

| Role | Contact | Notes |
|------|---------|-------|
| Incident Owner | Raghav | [Raghav to confirm] |
| Shopify Partner Security | [Raghav to confirm] | For breach notification |
| Sentry Account Owner | [Raghav to confirm] | For log access |
| Cloudflare Account Owner | [Raghav to confirm] | For worker management |
| Legal/DPO | [Raghav to confirm] | For regulatory notification |

---

## Revision History

| Date | Author | Change |
|------|--------|--------|
| 2026-10-25 | Cursor Agent | Initial version |
