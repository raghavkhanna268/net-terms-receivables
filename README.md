# Net Terms Receivables - Shopify App

A B2B wholesale net-terms receivables management app for Shopify. Track invoices, manage credit limits, send payment reminders, and match Indian bank transfer payments (NEFT/RTGS/IMPS/UPI) to orders.

## Tech Stack

- **Runtime**: Cloudflare Workers (Free tier, placed near AWS Seoul via region hint)
- **Framework**: React Router v7 with `@shopify/shopify-app-react-router`
- **UI**: Polaris Web Components + App Bridge
- **Session Storage**: Postgres (postgres.js LightSessionStorage via Hyperdrive)
- **Build**: Vite with `@cloudflare/vite-plugin`

### Why This Stack?

- **$0/month until paying merchants**: Cloudflare Workers Free tier (100k requests/day), Supabase Free tier (later)
- **Low latency for DB**: Explicit region hint places Worker near Supabase Postgres (AWS ap-northeast-2)
- **Edge-native**: No cold starts, global distribution
- **Official Shopify support**: Uses `@shopify/shopify-app-react-router` with Node adapter + `nodejs_compat`

## Prerequisites

1. **Node.js 22.12+**
2. **Shopify Partner Account**: [Create one](https://partners.shopify.com/signup)
3. **Cloudflare Account**: [Sign up](https://dash.cloudflare.com/sign-up)
4. **Shopify CLI**: Install globally or use `npx @shopify/cli@latest`

## Setup Steps

### 1. Clone and Install

```bash
git clone <this-repo>
cd net-terms-receivables
npm install
```

### 2. Create Shopify App in Partner Dashboard

1. Go to [Partner Dashboard](https://partners.shopify.com) → Apps → Create app
2. Choose "Create app manually"
3. Name: `Net Terms Receivables`
4. App URL: `https://net-terms-receivables.<your-subdomain>.workers.dev` (or use dev tunnel URL for local)
5. Allowed redirection URLs:
   - `https://net-terms-receivables.<your-subdomain>.workers.dev/auth/callback`
   - `https://localhost/auth/callback`
6. Note your **API key** and **API secret**

### 3. Link App to Project

```bash
npx @shopify/cli@latest app config link
# Select your app from the list
```

This creates/updates `shopify.app.toml` with your `client_id`.

### 4. Create Development Store

```bash
npx @shopify/cli@latest store create dev
# Name it something like: net-terms-receivables
# Or use existing dev store: net-terms-receivables.myshopify.com
```

### 5. Set Up Hyperdrive (for Database Connection)

```bash
# Login to Cloudflare
npx wrangler login

# Create Hyperdrive config pointing to your Supabase session pooler
npx wrangler hyperdrive create net-terms-db --connection-string="<SESSION_POOLER_URL>"
# Copy the id from output
```

Update `wrangler.jsonc` with your Hyperdrive ID (see existing config for structure).

### 6. Configure Secrets

For **local development**, Shopify CLI handles environment variables automatically when you run `shopify app dev`.

For **Cloudflare Workers deployment**, set secrets:
```bash
npx wrangler secret put SHOPIFY_API_KEY
# Enter your API key when prompted

npx wrangler secret put SHOPIFY_API_SECRET
# Enter your API secret when prompted

npx wrangler secret put SHOPIFY_APP_URL
# Enter: https://net-terms-receivables.<your-subdomain>.workers.dev

npx wrangler secret put SCOPES
# Enter: read_orders,read_customers
```

### 7. Local Development

```bash
npx @shopify/cli@latest app dev
```

This will:
- Start the Vite dev server with Cloudflare Workers runtime
- Create a tunnel to expose your local app
- Open the app installation page in your dev store

Press `P` to open the app in your browser.

### 8. Deploy to Cloudflare Workers

```bash
npm run cf:deploy
```

This builds the app and deploys to Cloudflare Workers.

### 9. Update Shopify App URLs

After deployment, update your app URLs in Partner Dashboard:
- App URL: `https://net-terms-receivables.<your-subdomain>.workers.dev`
- Redirect URLs: `https://net-terms-receivables.<your-subdomain>.workers.dev/auth/callback`

## Deployment

Merges to `main` trigger automatic deployment via GitHub Actions:

1. **CI workflow** runs lint, typecheck, tests, and build on every push/PR
2. **Database Migrations workflow** runs `prisma migrate deploy` when `prisma/` files change
3. **Deploy workflow** triggers when either CI or Migrations completes on `main`

The deploy workflow always deploys the **current main HEAD** (not the triggering run's sha) to prevent stale or out-of-order deploys. Before deploying, it verifies:
- CI has a successful push run for that sha on main
- No migrations are active (not yet completed) on main
- The latest migration run on main succeeded (or was skipped)

If conditions aren't met yet, the run skips with a notice (not a failure). If the latest migration failed, the deploy fails until migrations are fixed or re-run. This ensures that when commit A's migration finishes after commit B merges, the deploy ships B (once B is green) rather than rolling back to A—and if A's migration failed, B won't deploy until migrations are fixed.

**Required repository secrets:**
- `CLOUDFLARE_API_TOKEN` - API token with Workers edit permissions
- `CLOUDFLARE_ACCOUNT_ID` - Your Cloudflare account ID
- `SHOPIFY_API_KEY` - Shopify app API key
- `SHOPIFY_API_SECRET` - Shopify app API secret

**Manual deployment:** Use the "Run workflow" button on the Deploy workflow in GitHub Actions (main branch only).

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start local dev with Shopify CLI (recommended) |
| `npm run dev:cf` | Start Vite dev server directly (without Shopify CLI) |
| `npm run build` | Build for production |
| `npm run cf:deploy` | Build and deploy to Cloudflare Workers |
| `npm run typecheck` | Run TypeScript type checking |
| `npm run lint` | Run ESLint |
| `npm run preview` | Build and preview locally |
| `npm run seed` | Seed dev store with test data |

## Dev Store Seed Script

The seed script (`scripts/seed.ts`) creates test data for development:

- **5 B2B companies** with locations and contacts
- **5 customers** tagged as net-terms buyers
- **~30 orders** with payment terms (NET 15/30/60 and fixed dates, some overdue)

All amounts are in INR with varied values across the seed data.

### Prerequisites

The seed script requires a **custom app** on your dev store (separate from the production app) with Admin API access.

#### 1. Create a Custom App on Your Dev Store

1. In your dev store admin, go to **Settings → Apps and sales channels**
2. Click **Develop apps** (enable custom app development if prompted)
3. Click **Create an app** → name it something like "NTR Seed Script"
4. Click **Configure Admin API scopes** and select:
   - `read_companies`, `write_companies`
   - `read_customers`, `write_customers`
   - `read_draft_orders`, `write_draft_orders`
   - `read_products`
   - `read_payment_terms`, `write_payment_terms`
5. Click **Save**, then **Install app**
6. Under **API credentials**, click **Reveal token once** and copy the Admin API access token

#### 2. Run the Seed Script

```bash
# Set environment variables
export SHOP=your-dev-store.myshopify.com
export SHOPIFY_ADMIN_TOKEN=shpat_xxxxxxxxxxxxx

# Preview what will be created (no changes)
npm run seed -- --dry-run

# Run the seed
npm run seed

# Reset and re-seed (deletes seed data first)
npm run seed -- --reset
```

### Idempotency

The script is idempotent—running it twice creates nothing new:

- Companies are keyed by `externalId` (e.g., `ntr-seed-company-1`)
- Customers and orders are keyed by tags (e.g., `ntr-seed`, `ntr-seed-customer-1`)

A second run reports what already exists and skips creation.

### Reset / Cleanup

The `--reset` flag deletes only records created by the seed script:

- Companies with `externalId` starting with `ntr-seed-`
- Customers and draft orders with the `ntr-seed` tag
- Completed orders cannot be deleted via API but remain tagged for identification

### B2B Requirement

The script requires B2B to be available on the dev store. It performs a preflight check and exits with a clear message if B2B is not supported. Dev stores typically have B2B enabled; if not, you may need to enable it in your Partner Dashboard dev store settings.

## Project Structure

```
├── app/
│   ├── routes/
│   │   ├── app.tsx              # Authenticated app layout
│   │   ├── app._index.tsx       # Home page (shows shop name)
│   │   ├── auth.$.tsx           # Auth catch-all
│   │   ├── auth.login/          # Login page
│   │   ├── _index/              # Landing page
│   │   └── webhooks.*.tsx       # Webhook handlers
│   ├── entry.server.tsx         # Server entry (injects KV)
│   ├── root.tsx                 # App root
│   ├── routes.ts                # Route config
│   └── shopify.server.ts        # Shopify app config
├── workers/
│   └── app.ts                   # Cloudflare Worker entry
├── wrangler.jsonc               # Cloudflare config
├── shopify.app.toml             # Shopify app config
└── vite.config.ts               # Vite config
```

## CPU Time Analysis (Workers Free Tier)

**Workers Free tier allows 10ms CPU time per request.**

### Estimated CPU Times

| Operation | Estimated CPU Time | Notes |
|-----------|-------------------|-------|
| OAuth start | 1-3ms | Redirect generation, HMAC validation |
| OAuth callback | 3-5ms | Token exchange, session storage |
| Embedded app load | 2-4ms | Session lookup, React SSR |
| Webhook handler | 1-2ms | HMAC validation, simple response |

### Verification

**Cannot measure actual CPU time without deployment.** After deploying, check CPU time with:

```bash
# Real-time logs with CPU time
npx wrangler tail --format=pretty

# Or in Cloudflare Dashboard:
# Workers & Pages → net-terms-receivables → Analytics → CPU Time
```

If requests exceed 10ms, you'll see errors in logs. The Worker will return errors for requests exceeding the limit.

### Mitigation Strategies (if needed)

1. **Upgrade to Workers Paid** ($5/mo for 10M requests, 30ms CPU)
2. **Optimize code paths** - defer non-critical work
3. **Use streaming responses** - reduces time to first byte
4. **Cache aggressively** - KV lookups are fast (~1ms)

## Session Storage Choice

### Current: Postgres via Hyperdrive

- **Implementation**: `app/lib/session-storage-light.server.ts` using postgres.js LightSessionStorage
- **Why**: Unified data layer with business data, strong consistency, no separate KV namespace needed
- **Connection**: Cloudflare Hyperdrive for connection pooling to Supabase Postgres (Seoul, ap-northeast-2)

## OAuth Scopes

Currently configured minimal scopes in `shopify.app.toml`:
```toml
scopes = "read_orders,read_customers"
```

**To add more scopes:**
1. Update `shopify.app.toml`
2. Run `shopify app deploy` to push changes
3. Merchants will be prompted to re-approve

## What's Next (S2)

1. **Supabase Postgres Integration**
   - Set up Hyperdrive connection pool
   - Migrate session storage to Prisma
   - Add business data models

2. **B2B Features**
   - Buyer management UI
   - Credit limit tracking
   - Invoice generation
   - Payment matching (NEFT/RTGS/IMPS/UPI)

3. **Background Jobs**
   - Supabase Queues / pg_cron
   - Payment reminders
   - Aging reports

## Troubleshooting

### "Session not found" errors
- Ensure Hyperdrive config is correct in `wrangler.jsonc`
- Check database connection and that the Session table exists

### OAuth redirect fails
- Verify `SHOPIFY_APP_URL` matches your actual deployment URL
- Check redirect URLs in Partner Dashboard match

### Build fails with manifest error
- Ensure `future.v8_viteEnvironmentApi: true` is set in `react-router.config.ts`
- This is required for React Router v7 + Cloudflare Vite plugin compatibility

### CPU time exceeded
- Check `wrangler tail` for which operations are slow
- Consider Workers Paid tier if consistently hitting limits

## License

MIT
