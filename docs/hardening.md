# Hardening: Idempotent Webhooks & Rate Limit Retries (S20)

This document describes the hardening measures implemented in S20 to ensure reliable webhook processing and graceful handling of Shopify API rate limits.

## Overview

The Net Terms Receivables app receives webhooks from Shopify for various events (orders, companies, customers, etc.). These webhooks need to be processed reliably:

1. **Exactly-once semantics**: Each webhook should be processed exactly once, even if Shopify retries delivery
2. **Ordering safety**: Out-of-order events should not overwrite newer data
3. **Rate limit handling**: API calls should gracefully handle throttling without losing data
4. **Worker budget awareness**: Retries must respect the 10ms CPU budget on Cloudflare Workers Free

## Webhook Idempotency

### Two-Level Deduplication

Webhooks are deduplicated at two levels:

#### 1. Edge Level (Webhook Route)

Immediately after HMAC verification, webhooks are recorded in the `webhook_receipts` table:

```sql
INSERT INTO webhook_receipts (shop, webhook_id, topic, triggered_at, received_at)
VALUES ($1, $2, $3, $4, NOW())
ON CONFLICT (shop, webhook_id) DO NOTHING
RETURNING webhook_id
```

- If a row is returned, this is a **new webhook** → continue processing
- If no row is returned (conflict), this is a **duplicate** → return 200 and skip

This prevents duplicate enqueues when Shopify retries webhooks.

#### 2. Processor Level (Drain)

Before processing queued messages, handlers check if the webhook was already processed:

```typescript
if (await isWebhookProcessed(sql, webhookId, shop)) {
  return { success: true, action: "skipped" };
}
```

This provides belt-and-suspenders safety for queue retries.

### Data Model

```sql
CREATE TABLE webhook_receipts (
    shop TEXT NOT NULL,
    webhook_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    triggered_at TIMESTAMPTZ(6),  -- X-Shopify-Triggered-At
    received_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    PRIMARY KEY (shop, webhook_id)
);
```

### Retention

- **30-day retention**: Receipts older than 30 days are purged via pg_cron daily at 04:30 UTC
- **Shop deletion**: Receipts are immediately purged on `app/uninstalled` and `shop/redact` webhooks

## Ordering Guards

To prevent out-of-order events from overwriting newer data, processors use the `X-Shopify-Triggered-At` header:

### How It Works

1. Webhook handlers parse `X-Shopify-Triggered-At` and include it in the queue message
2. Processors compare the incoming `triggeredAt` against the existing record's `updatedAt`
3. If the existing record is newer, the update is skipped

```typescript
if (triggeredAt) {
  const [existing] = await sql`
    SELECT id, "updatedAt" FROM "Invoice"
    WHERE "orderId" = ${data.orderId}
  `;
  
  if (existing && existing.updated_at > triggeredAt) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Ordering guard: existing record is newer",
    };
  }
}
```

### Protected Entities

- **Invoices**: Order events check against Invoice.updatedAt
- **BuyerAccounts**: Company/location events use upsert's natural ordering

## Rate Limit Handling

### Shopify API Client Wrapper

All Admin GraphQL calls use `shopify-client.server.ts` which handles:

#### THROTTLED Responses

GraphQL responses with `extensions.code = "THROTTLED"` include cost information:

```json
{
  "extensions": {
    "cost": {
      "requestedQueryCost": 100,
      "actualQueryCost": 100,
      "throttleStatus": {
        "maximumAvailable": 1000,
        "currentlyAvailable": 50,
        "restoreRate": 50
      }
    }
  }
}
```

Wait time is calculated as: `(requestedCost - currentlyAvailable) / restoreRate`

#### HTTP 429 Rate Limiting

1. Parse `Retry-After` header (numeric seconds or HTTP date)
2. If not present, use exponential backoff with jitter

#### 5xx Server Errors

Retried with exponential backoff: `baseDelay * 2^attempt + jitter`

#### 4xx Client Errors

**Never retried** - these indicate permanent failures:
- 401/403: Authentication failures
- 400: Invalid requests
- userErrors in GraphQL responses

### Worker Budget Awareness

The retry behavior adapts to the execution context:

| Context | Max Retries | Max Wait Time |
|---------|-------------|---------------|
| Request | 1 | 1 second |
| Queue | 3 | 30 seconds |

#### Request-Path Code

Used for webhook handlers and user-facing routes:
- At most 1 short retry
- Surfaces `retryable: true` for pgmq to handle later

```typescript
const result = await shopifyGraphQLRequest(shop, query);
if (!result.success && result.retryable) {
  // Let the message retry via pgmq visibility timeout
  return { success: false, error: result.error };
}
```

#### Queue/Job Path Code

Used by the drain processor:
- Up to 3 retries
- Can wait up to 30 seconds total
- Respects platform wall-clock limits

```typescript
const result = await shopifyGraphQLQueue(shop, query);
```

## Compliance

### Data Retention

- `webhook_receipts` table holds **no PII** - only IDs and topics
- 30-day retention enforced via pg_cron
- Immediate deletion on shop uninstall/redact

### Shop Deletion Flow

1. `app/uninstalled`: Sessions deleted, shop marked uninstalled, receipts purged
2. `shop/redact` (48h later): Full shop deletion via CASCADE, receipts already gone

## Testing

Tests verify:

1. **Duplicate webhook replay**: Same payload twice produces exactly one write
2. **Out-of-order events**: Older `triggeredAt` is ignored
3. **THROTTLED retry**: Computed wait from throttleStatus
4. **429 Retry-After**: Header is honoured
5. **No retry on userErrors**: Permanent failures stop immediately
6. **Request-path cap**: At most 1 retry in request context

Run tests:
```bash
npm test -- --grep "S20"
```

## Configuration

### Environment Variables

No new environment variables required. Uses existing:
- `SHOPIFY_API_SECRET`: For HMAC verification

### Database Requirements

- `webhook_receipts` table (created by migration)
- pg_cron extension (for retention purge job)

## Monitoring

Log messages for observability:

```
[webhooks.orders] Duplicate ORDERS_CREATE for shop.myshopify.com, skipping
[shopify-client] THROTTLED, waiting 1100ms (attempt 1/4)
[shopify-client] 429 rate limited, waiting 2000ms (attempt 2/4)
[shopify-client] Server error (500), retrying in 200ms (attempt 1/4)
```

## Migration

Migration `20261024050000_s20_webhook_receipts` creates:
- `webhook_receipts` table with indexes
- pg_cron job for 30-day retention
- Migrates existing `s6_processed_webhooks` data (deprecated table)
