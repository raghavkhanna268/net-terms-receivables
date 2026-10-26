# Sentry Setup

This checklist guides you through creating a Sentry account and project for error monitoring in the Net Terms Receivables app.

## Prerequisites

- Access to the Cloudflare account where the Worker is deployed
- Access to 1Password or other secrets manager (for DSN handoff)

## Step 1: Create Sentry Account and Organization

1. Go to [sentry.io](https://sentry.io) and click **Get Started Free**
2. Sign up with your email or SSO provider
3. When prompted to create an organization:
   - Enter organization name (e.g., `net-terms-receivables` or your company name)
   - **Data Storage Location**: Choose **US** or **EU**
     - US stores data in Iowa, USA
     - EU stores data in Frankfurt, Germany
     - **India consideration**: Sentry does not offer an India data region. For DPDP compliance, EU is often preferred for non-US companies. The choice is permanent—you must create a new organization to change regions.
   - Select **Developer** plan ($0/month)

> **Source**: [Sentry Data Storage Location](https://docs.sentry.io/organization/data-storage-location/)

## Step 2: Create a Project

1. After organization setup, navigate to **Insights → Projects** in the left sidebar
2. Click **New Project**
3. Select platform: **JavaScript** (not Node.js—Cloudflare Workers use the JavaScript SDK)
4. Enter project name: `net-terms-receivables` (or match your Worker name)
5. Click **Create Project**

> **Source**: [Sentry for Cloudflare](https://docs.sentry.io/platforms/javascript/guides/cloudflare/)

## Step 3: Find the DSN

1. In your new project, go to **Settings → Projects → [your project] → Client Keys (DSN)**
2. Copy the DSN—it looks like:

   ```text
   https://<key>@o<orgId>.ingest.sentry.io/<projectId>
   ```

   For EU organizations, the host is `o<orgId>.ingest.de.sentry.io`.

3. **Do NOT paste the DSN in Slack or any chat.** It is collected securely (see below).

> **Source**: [Sentry Client Keys](https://docs.sentry.io/platforms/javascript/guides/cloudflare/)

## Step 4: DSN Handoff (Secure)

The DSN is collected by the DevOps bot via a **secure secret-request card**. Never paste it in chat.

Once collected, it is stored as:

| Location | Secret Name | Purpose |
|----------|-------------|---------|
| Wrangler secrets | `SENTRY_DSN` | Runtime access in Worker |
| GitHub Actions secrets | `SENTRY_DSN` | CI source-map upload (if using sentry-cli) |

To set the wrangler secret (DevOps runs this after receiving the DSN):

```bash
wrangler secret put SENTRY_DSN
# Paste the DSN when prompted
```

## Step 5: (Optional) Auth Token for Source Maps

Source map upload requires an Organization Auth Token. This is optional but recommended for readable stack traces.

### Create the Token

1. In Sentry, go to **Settings → Developer Settings → Organization Tokens**
2. Click **New Token**
3. The token has a fixed scope of `org:ci` (sufficient for source map uploads, release creation, and code mappings)
4. Copy the token immediately—it is only shown once

### Store as Secret

| Location | Secret Name | Purpose |
|----------|-------------|---------|
| GitHub Actions secrets | `SENTRY_AUTH_TOKEN` | CI source-map upload via `upload_source_maps: true` in wrangler.jsonc |

> **Source**: [Sentry Auth Tokens](https://docs.sentry.io/account/auth-tokens/)

## SDK Configuration

This repo already uses `@sentry/cloudflare`. The relevant wrangler.jsonc settings:

```jsonc
{
  "compatibility_date": "2026-10-19",
  "compatibility_flags": ["nodejs_compat"],
  "upload_source_maps": true
}
```

The Worker wraps handlers with `Sentry.withSentry()` and reads `SENTRY_DSN` from the environment.

> **Source**: [Sentry Cloudflare Wrangler Setup](https://docs.sentry.io/platforms/javascript/guides/cloudflare/install/wrangler/)

## Privacy Settings

To comply with DPDP and minimize PII exposure:

| Setting | Value | Why |
|---------|-------|-----|
| `sendDefaultPii` | `false` (default) | Do not attach IP, user agent, etc. automatically |
| Scrub buyer emails/phones | Manual (see below) | Avoid capturing customer PII in error breadcrumbs |

In the Sentry dashboard under **Settings → Projects → [project] → Security & Privacy**:
- Enable **Data Scrubbing**
- Add patterns to scrub email addresses and phone numbers if they appear in error messages

## Free Tier Quota Limits

The Developer plan includes per-month:

| Resource | Included | Overage |
|----------|----------|---------|
| Errors | 5,000 | Dropped (no PAYG on free tier) |
| Spans (tracing) | 10 million | Dropped |
| Session Replays | 50 | Dropped |
| Attachments | 1 GB | Dropped |
| Cron Monitors | 1 | — |
| Uptime Monitors | 1 | — |

When quota is exhausted, new events are dropped until the next billing cycle. To increase quota, upgrade to Team ($26/month) or Business ($80/month).

> **Source**: [Sentry Pricing](https://sentry.io/pricing/)

## Checklist Summary

- [x] Create Sentry account (sign up at sentry.io) (#390)
- [x] Create organization (choose US or EU data region) (#390)
- [x] Create project (JavaScript platform, match Worker name) (#390)
- [x] Locate DSN in project settings (#390)
- [x] Submit DSN via DevOps secure secret-request card (never paste in chat) (#390)
- [x] DevOps stores DSN as `wrangler secret SENTRY_DSN` (DevOps names-only wrangler secret list, 2026-10-26 19:44 IST)
- [ ] (Optional) Create Organization Auth Token for source maps — Why open: in open PR #323
- [ ] (Optional) DevOps stores auth token as GitHub Actions secret `SENTRY_AUTH_TOKEN` — Why open: in open PR #323
- [x] Restrictive SDK data collection: `dataCollection: RESTRICTIVE_DATA_COLLECTION` (replaces `sendDefaultPii` in @sentry/core 11.8) in `app/lib/sentry.ts`
- [ ] Enable data scrubbing in Sentry dashboard for email/phone patterns — Why open: Sentry dashboard setting, not verifiable from the repo; in-code scrubbing is via beforeSend/beforeSendTransaction in `app/lib/sentry.ts`
