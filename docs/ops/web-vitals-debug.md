# Web Vitals Debug Logging

Debug logging for Core Web Vitals (LCP, CLS, INP) collected by App Bridge.

## Overview

The app registers with `shopify.webVitals.onReport` to collect Core Web Vitals.
Debug logging is **opt-in** and logs **only** metric name and value to the console.

## Enabling Debug Logging

1. Open DevTools in Chrome/Edge
2. Switch console context to `app-iframe` (the embedded app iframe)
3. In the Console tab, run:
   ```js
   localStorage.setItem('debug:web-vitals', '1')
   ```
4. Reload the page

## Viewing Debug Logs

After enabling and reloading:

1. Open DevTools Console
2. **Important:** Set the console context dropdown to `app-iframe`
   - The dropdown is at the top of the Console panel
   - Default is `top` (the admin frame) - metrics won't appear there
3. Look for lines like:
   ```
   [web-vitals] LCP 1234
   [web-vitals] CLS 0.05
   [web-vitals] INP 89
   ```

## Disabling Debug Logging

In the `app-iframe` console context:
```js
localStorage.removeItem('debug:web-vitals')
```

## Privacy Notes

Debug logging outputs **only**:
- Metric name (e.g., `LCP`, `CLS`, `INP`)
- Metric value (rounded: ms for LCP/INP, score for CLS)

It does **not** log:
- Shop domain
- User or customer data
- URLs or query strings
- Session tokens
- Metric IDs or versions
- Country or IP information

## Troubleshooting

**No logs appearing?**
1. Verify console context is `app-iframe`, not `top`
2. Check localStorage: `localStorage.getItem('debug:web-vitals')` should return `"1"`
3. Ensure you reloaded after setting the flag
4. Metrics are reported by App Bridge when available (may take a few seconds)

**Multiple LCP/CLS values?**
Normal - App Bridge reports updated values as the page settles.
