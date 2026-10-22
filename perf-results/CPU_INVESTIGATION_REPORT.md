# Cloudflare Workers CPU Performance Investigation

## Executive Summary

**Target**: 10ms CPU per request (Cloudflare Workers Free tier limit)

**Current State** (from DevOps measurements on deployed Worker):
- `/` cold: 70ms, warm: 12ms
- `/app`: 26-36ms

**Local Profiling Results** (warm requests):
- GET `/`: avg 6.5ms wall-clock
- GET `/app`: avg 5.4ms wall-clock
- GET `/auth/login`: avg 5.9ms wall-clock
- POST webhooks: avg 5.5ms wall-clock

**Critical Finding**: Every request calls `shopifyApp()`, which reinitializes the entire Shopify API library. This is visible in logs (`[shopify-api/INFO] version 15.0.1` appears for each request).

---

## Bundle Analysis

| Component | Size | % of Bundle | Gzipped |
|-----------|------|-------------|---------|
| Prisma WASM Query Compiler | 3,357 KB | 67.2% | ~1.1 MB |
| Worker Entry (main bundle) | 1,501 KB | 30.0% | ~357 KB |
| Server Build (app routes) | 130 KB | 2.6% | ~40 KB |
| Prisma WASM Glue | 8 KB | 0.2% | ~3 KB |
| **Total** | **4,995 KB** | **100%** | **~1.5 MB** |

The Prisma WASM query compiler dominates the bundle. While it's only loaded once per isolate (not per request), it contributes to cold start time.

---

## CPU Breakdown by Component (from V8 Profiling)

### Warm Request Profile (5 GET / requests)

| Function/Module | CPU Time | % of Total |
|-----------------|----------|------------|
| (idle/wait) | 39.81ms | 39.2% |
| `shopifyApi()` initialization | 20.45ms | 20.1% |
| `useRoutesImpl` (React Router) | 13.78ms | 13.6% |
| `matchRouteBranch` | 1.07ms | 1.1% |
| Other (React SSR, etc.) | ~12ms | ~12% |

### Single Warm Request Profile

| Source | CPU Time | % of Total |
|--------|----------|------------|
| (native/idle) | ~43ms | 89.7% |
| worker-entry.js | ~4.6ms | 9.7% |
| server-build.js | ~0.3ms | 0.6% |

**Key Insight**: The actual CPU time per warm request is approximately **5ms**, with the rest being I/O wait time (database queries, network).

---

## Root Cause Analysis

### 1. Per-Request `shopifyApp()` Initialization (MAJOR)

In `workers/app.ts`:
```typescript
export default wrapWithSentry({
  async fetch(request, env, ctx) {
    // ...
    const shopify = createShopifyApp(sessionStorage); // Called EVERY request!
    // ...
  }
});
```

The `shopifyApp()` function from `@shopify/shopify-app-react-router`:
1. Validates configuration
2. Creates client factories
3. Creates auth, session, utils, webhooks, billing objects
4. Logs version info
5. Logs future flag warnings

This takes ~4ms per request and is completely unnecessary for warm requests.

### 2. Session Storage Architecture

Current design requires per-request Prisma client due to Hyperdrive binding:
- Hyperdrive connection string comes from `env.HYPERDRIVE.connectionString`
- This is only available in request context
- Session storage is tied to Prisma client
- Shopify app requires session storage at initialization

### 3. React Router SSR

Every request goes through:
- Route matching (`useRoutesImpl`, `matchRouteBranch`)
- Component rendering (`renderToReadableStream`)
- Polaris and App Bridge loading

---

## Candidate Fixes Analysis

### Fix A: Lazy-init shopifyApp at Module Scope

**Approach**: Initialize `shopifyApp` once per isolate, not per request.

**Challenge**: Session storage depends on per-request Prisma client (Hyperdrive binding).

**Solution**: Use AsyncLocalStorage to provide request-scoped Prisma access while maintaining module-scoped Shopify app.

**Estimated CPU Savings**: ~4ms per warm request (20-30% reduction)

**Implementation Complexity**: Medium - requires restructuring worker entry

### Fix B: Skip Prisma for Non-DB Requests

**Approach**: Don't initialize Prisma client for requests that don't need database access.

**Current State**: Already partially implemented via lazy getter:
```typescript
let prisma: PrismaClient | null = null;
const getPrisma = (): PrismaClient => {
  if (!prisma) {
    prisma = createPrismaClient(env.HYPERDRIVE.connectionString);
  }
  return prisma;
};
```

**Effectiveness**: Limited - Prisma is only created when `getPrisma()` is called. The overhead is in the session storage operations, not Prisma instantiation.

**Estimated CPU Savings**: Minimal for warm requests

### Fix C: Cache-Control for `/` Route

**Approach**: Add `Cache-Control` headers to static-like responses.

**Implementation**:
```typescript
// In routes/_index/route.tsx loader
export const headers: HeadersFunction = () => ({
  "Cache-Control": "public, max-age=3600, s-maxage=86400",
});
```

**Effectiveness**: High for repeat visits (served from edge cache)

**Impact**: Reduces Worker invocations, not per-invocation CPU

### Fix D: Client-Side Rendering for Admin UI

**Approach**: Use React Router SPA mode for `/app/*` routes, keeping SSR only for auth/webhooks.

**Implementation**:
```typescript
// In react-router.config.ts or per-route
export const clientLoader = async ({ serverLoader }) => {
  return serverLoader();
};
export const ssr = false; // Disable SSR for this route
```

**Benefits**:
- Eliminates React SSR CPU overhead for admin pages
- Polaris/App Bridge load client-side (faster perceived performance)
- Session validation still happens server-side via API routes

**Estimated CPU Savings**: 1-2ms per request (React SSR overhead)

**Tradeoffs**:
- Initial HTML is a shell (slightly slower FCP)
- App Bridge session token validation still needs server route

### Fix E: Replace Prisma with Kysely

**Approach**: Use Kysely for runtime queries, keep Prisma for schema/migrations only.

**Bundle Impact**:
- Removes: 3.36 MB Prisma WASM + ~1 MB Prisma runtime = ~4.4 MB
- Adds: ~50 KB Kysely

**Estimated Bundle Reduction**: ~85% (from 5 MB to ~750 KB)

**Cold Start Impact**: Significant improvement (less WASM to load)

**Implementation**:
```typescript
// New db.server.ts using Kysely
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

export function createDb(connectionString: string) {
  return new Kysely({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString }),
    }),
  });
}
```

**Warm Request CPU Impact**: Minimal change (Prisma WASM is already loaded)

**Tradeoffs**:
- Lose Prisma's type-safe generated client
- Need to manually maintain Kysely types
- Migration workflow unchanged (still use Prisma)

---

## Recommendations (Ranked by Impact/Effort)

### Immediate (High Impact, Low Effort)

1. **Fix Cache-Control headers** for `/` and static responses
   - Impact: Reduces Worker invocations significantly
   - Effort: 5 minutes

### Short-term (High Impact, Medium Effort)

2. **Module-scope shopifyApp initialization** (Fix A)
   - Impact: ~4ms CPU savings per request (~30%)
   - Effort: 2-4 hours to implement and test AsyncLocalStorage pattern

3. **Client-side rendering for `/app/*`** (Fix D)
   - Impact: 1-2ms CPU savings + better UX
   - Effort: 1-2 hours

### Medium-term (High Impact, High Effort)

4. **Replace Prisma with Kysely** (Fix E)
   - Impact: 85% bundle reduction, faster cold starts
   - Effort: 4-8 hours to reimplement session storage

---

## Realistic Assessment: Can We Hit 10ms on Workers Free?

### Optimistic Scenario (All Fixes Applied)

| Request Type | Current | After Fixes | Target |
|--------------|---------|-------------|--------|
| Cold start | 70ms | 25-30ms | n/a |
| GET / (cached) | 12ms | 0ms (edge) | <10ms ✓ |
| GET /app (CSR) | 26-36ms | 8-12ms | <10ms ⚠️ |
| Webhooks | ~10ms | 6-8ms | <10ms ⚠️ |

### Realistic Assessment

**GET / can definitely meet 10ms** with caching.

**GET /app (embedded admin) is borderline**:
- With CSR + module-scoped Shopify: 8-12ms realistic
- The session token validation overhead is unavoidable
- Smart Placement helps if DB is the bottleneck

**Webhooks can meet 10ms** with module-scoped Shopify.

### Recommendation

For a production Shopify embedded app with Prisma database:
- **Workers Paid ($5/mo)** is the safer choice
- It allows 30ms CPU time, which is comfortable for SSR apps
- Smart Placement is included in both plans

If committed to Free tier:
1. Implement all fixes above
2. Use aggressive caching for public pages
3. Consider moving to Supabase Edge Functions (no CPU limit) for auth flows
4. Accept that some requests may exceed 10ms during cold starts

---

## Files Modified/Created

### Profiling Scripts
- `/workspace/scripts/profile-cpu.mjs` - V8 inspector profiling
- `/workspace/scripts/baseline-measurement.mjs` - Request timing
- `/workspace/scripts/analyze-bundle.mjs` - Bundle analysis
- `/workspace/scripts/parse-profile.mjs` - Profile parser

### Profiles Collected
- `/workspace/profiles/*.cpuprofile` - V8 CPU profiles
- `/workspace/perf-results/baseline_*.json` - Timing measurements

### Experimental Code
- `/workspace/workers/app-fix-a.ts` - Module-scoped Shopify (incomplete)

---

## What Could Not Be Measured

1. **Actual Cloudflare CPU time**: Local profiling measures wall-clock time including I/O. Real CF CPU excludes async I/O waits. The dashboard metrics are authoritative.

2. **Prisma WASM instantiation time**: This happens once per isolate on cold start, difficult to isolate in profiling.

3. **Production Hyperdrive latency**: Local Postgres is faster than Hyperdrive to Supabase.

4. **Real cold start frequency**: Depends on traffic patterns and Cloudflare's isolate recycling.

5. **Smart Placement effectiveness**: Would need production traffic to measure.

---

## Appendix: Local Test Environment

- Node.js: 22.23.4
- Wrangler: 4.151.3
- PostgreSQL: 16 (local)
- Prisma: 7.10.1
- React Router: 7.18.2
- @shopify/shopify-app-react-router: 4.0.0
