# Web Vitals and Performance Monitoring

This document covers how the app measures and reports Core Web Vitals for Built for Shopify compliance.

## Admin Web Vitals

The app is measured by Shopify's Web Vitals collection when running in the Shopify admin iframe. The p75 metrics over 28 days are visible in the [Partner Dashboard](https://partners.shopify.com/) under the app's analytics.

**We do not build our own aggregation.** The `api.web-vitals.tsx` endpoint only logs validated metrics for debugging purposes; it does not store or aggregate them. All official metrics come from Shopify's collection via App Bridge.

### BFS Performance Targets (p75 over 28 days)

| Metric | Target | Description |
|--------|--------|-------------|
| LCP | ≤ 2.5s | Largest Contentful Paint |
| CLS | ≤ 0.1 | Cumulative Layout Shift |
| INP | ≤ 200ms | Interaction to Next Paint |

## App Bridge Setup

App Bridge is loaded from the Shopify CDN in `<head>` before any other scripts. This is required for:
1. Shopify to collect Web Vitals metrics
2. Built for Shopify eligibility
3. App Bridge APIs (idToken, navigation, etc.)

The script is added in `app/root.tsx` and applies to all routes using the React Router layout.

## Debug Meta Tag

To enable detailed Web Vitals logging in the browser console during development:

```html
<meta name="shopify-debug" content="web-vitals" />
```

This meta tag is automatically included when `import.meta.env.DEV` is true. It enables:
- Real-time logs from Web Vitals with attribution data
- Send-time logs showing final values recorded by Shopify

**Production:** The debug meta tag is not rendered in production to avoid console noise and minor performance overhead.

To manually enable in production for debugging, set the tag via browser DevTools before page load, or temporarily modify the `isDevMode` check.

### How to Read Debug Logs

When the debug meta tag is present:
1. Open browser DevTools → Console
2. Load or navigate within the app
3. Look for logs prefixed with Web Vitals metric names (LCP, CLS, INP)
4. Attribution data shows which elements or interactions caused the metric value

## Client-Side Reporter

The app optionally reports Web Vitals to `/api/web-vitals` for internal logging:
- Registered in `app/routes/app.tsx` via `web-vitals.client.ts`
- Only logs to the server; does not store or aggregate
- Validates payloads server-side with strict allowlists

See `app/routes/api.web-vitals.tsx` for validation and logging details.

## References

- [Admin performance docs](https://shopify.dev/docs/apps/build/performance/admin-installation-oauth)
- [Web Vitals API](https://shopify.dev/docs/api/app-home/latest/apis/device-and-platform-integration/web-vitals-api)
- [Built for Shopify requirements](https://shopify.dev/docs/apps/launch/built-for-shopify/requirements)
