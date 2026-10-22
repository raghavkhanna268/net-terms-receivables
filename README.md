# Net Terms Receivables - Shopify App

A B2B wholesale net-terms receivables management app for Shopify. Track invoices, manage credit limits, send payment reminders, and match Indian bank transfer payments (NEFT/RTGS/IMPS/UPI) to orders.

## Tech Stack

- **Runtime**: Cloudflare Workers (Free tier, Smart Placement near Mumbai)
- **Framework**: React Router v7 with `@shopify/shopify-app-react-router`
- **UI**: Polaris Web Components + App Bridge
- **Session Storage**: Cloudflare KV (via `@shopify/shopify-app-session-storage-kv`)
- **Build**: Vite with `@cloudflare/vite-plugin`

### Why This Stack?

- **$0/month until paying merchants**: Cloudflare Workers Free tier (100k requests/day), Supabase Free tier (later)
- **Low latency for India**: Smart Placement prefers Mumbai region
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

### 5. Set Up Cloudflare KV (for Sessions)

```bash
# Login to Cloudflare
npx wrangler login

# Create KV namespace for sessions
npx wrangler kv namespace create SESSIONS
# Copy the id from output, e.g.: id = "abc123..."
```

Update `wrangler.jsonc` with your namespace ID:
```jsonc
"kv_namespaces": [
  {
    "binding": "SESSIONS",
    "id": "abc123..."  // ← Your actual ID here
  }
]
```

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

### Current: Cloudflare KV

- **Why**: Works on Workers, official Shopify adapter (`@shopify/shopify-app-session-storage-kv`), no external database needed for S1
- **Trade-offs**: Eventually consistent (not an issue for sessions), 1 write/sec per key limit

### Future (S2): Supabase Postgres via Hyperdrive

- Prisma + Cloudflare Hyperdrive for connection pooling
- Replace KV session storage with Prisma session storage
- Add business data tables (buyers, invoices, payments)

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
- Ensure KV namespace ID is correct in `wrangler.jsonc`
- Check that `SESSIONS` binding is present

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
