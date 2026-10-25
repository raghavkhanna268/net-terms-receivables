# Hardening: Idempotent Webhooks & Rate Limit Retries (S20)

This document describes the hardening measures implemented in S20 to ensure reliable webhook processing and graceful handling of Shopify API rate limits.

## Overview

The Net Terms Receivables app receives webhooks from Shopify for various events (orders, companies, customers, etc.). These webhooks need to be processed reliably:

1. **Exactly-once semantics**: Each webhook should be processed exactly once, even if Shopify retries delivery
2. **Rate limit handling**: API calls should gracefully handle throttling without losing data
3. **Worker budget awareness**: Retries must respect platform limits

## Webhook Idempotency

### Two-Level Deduplication (Separate Tables)

Webhooks are deduplicated at two independent levels using **separate tables**:

#### 1. Edge Level (`webhook_receipts`)

For webhooks that enqueue to pgmq (orders, companies, customers, etc.), the receipt and enqueue happen in **ONE transaction**:

```typescript
const result = await sql.begin(async (tx) => {
  const isNew = await recordWebhookReceipt(tx, shop, webhookId, topic, triggeredAt);
  if (!isNew) {
    return { duplicate: true };
  }
  
  await sendSyncMessage(tx, { topic, shop, webhookId, resourceGid, ... });
  return { duplicate: false };
});

if (result.duplicate) {
  console.log("Duplicate, skipping");
  return new Response(null, { status: 200 });
}
```

This ensures:
- If duplicate: Return 200 immediately (no double enqueue)
- If enqueue fails: Receipt rolls back, Shopify's retry will succeed

#### 2. Drain Level (`s6_processed_webhooks`)

Before processing queued messages, handlers check if the webhook was already processed:

```typescript
if (await isWebhookProcessed(sql, webhookId, shop)) {
  return { success: true, action: "skipped" };
}

// ... process webhook ...

await markWebhookProcessed(sql, webhookId, topic, resourceGid, shop);
```

This provides belt-and-suspenders safety for queue retries.

### Compliance Webhooks (No Edge Deduplication)

Compliance webhooks (`app/uninstalled`, `shop/redact`, `customers/redact`, `customers/data_request`, `app/scopes_update`, `app/subscriptions_update`) do **not** use edge deduplication because:

1. Their handlers are fully idempotent (delete/mark operations are safe to repeat)
2. They don't enqueue to pgmq - they execute immediately
3. Shopify retries are safe and may even be beneficial for resilience

### Data Model

```sql
-- Edge deduplication (S20)
CREATE TABLE webhook_receipts (
    shop TEXT NOT NULL,
    webhook_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    triggered_at TIMESTAMPTZ(6),
    received_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    PRIMARY KEY (shop, webhook_id)
);

-- Drain deduplication (S6, kept separate)
CREATE TABLE s6_processed_webhooks (
    webhook_id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    resource_gid TEXT NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL
);
```

### Retention

- **`webhook_receipts`**: 30-day retention via pg_cron (`s20_webhook_receipts_cleanup`, 04:30 UTC)
- **`s6_processed_webhooks`**: 7-day retention via pg_cron (`s10_processed_webhooks_cleanup`, 04:00 UTC daily; see `prisma/migrations/20261024010000_s10_drain_cron/migration.sql:183-188`)
- **Shop deletion**:
  - `app/uninstalled`: Receipt-linked processed webhooks and receipts are purged immediately
  - `shop/redact`: All remaining processed webhooks (including reconcile-prefix ids) and receipts are purged

## Ordering (No Explicit Guards)

The drain re-fetches data from Shopify Admin API before processing. This means:
- **Re-fetched data is always the latest Shopify state**
- No `triggeredAt` vs `updatedAt` comparison needed
- Terminal states (paid/cancelled) are protected in the upsert's `ON CONFLICT` clause

The `X-Shopify-Triggered-At` header is still parsed and stored for audit/debugging, but not used for ordering decisions.

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

### NOT Retried (Caller Must Handle)

- **HTTP 4xx (except 429)**: 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found
- **GraphQL userErrors**: Application-level validation errors (e.g., invalid input, constraint violations)
- **GraphQL errors without THROTTLED code**: Query syntax errors, field errors, access denied
- **InvalidSession**: Token revoked, shop needs to reinstall the app

### Worker Budget Awareness

The retry behavior adapts to the execution context:

| Context | Max Retries | Max Wait Time | Use Case |
|---------|-------------|---------------|----------|
| Request | 1 | 1 second | Webhook handlers, user routes |
| Queue | 3 | 25 seconds | Drain processor |

**Important**: Queue max wait (25s) is less than pgmq visibility timeout (30s) to ensure processing completes before the message becomes visible to other workers.

#### Request-Path Code

```typescript
const result = await shopifyGraphQLRequest(shop, query);
if (!result.success && result.retryable) {
  // Let the message retry via pgmq visibility timeout
  return { success: false, error: result.error };
}
```

#### Queue/Job Path Code

```typescript
const result = await shopifyGraphQLQueue(shop, query);
```

## Compliance

### Data Retention

- `webhook_receipts` table holds **no PII** - only IDs and topics
- 30-day retention enforced via pg_cron
- Immediate deletion on shop uninstall/redact

### Shop Deletion Flow

1. `app/uninstalled`: Sessions deleted, shop marked uninstalled. Receipt-linked processed
   webhooks and receipts purged in one transaction. Reconcile-prefix processed webhooks
   are NOT deleted (kept for reinstall grace period).
2. `shop/redact` (48h later): Full shop deletion via CASCADE. Reconcile-prefix processed
   webhooks purged. Any remaining receipts and receipt-linked processed webhooks purged
   (in case uninstall webhook failed or was missed).

**Intentionally NOT purged** (expire under 7-day TTL instead):
- `credit_*` processed webhook rows: carry no shop domain, internal credit-status markers
- Shopify-id processed webhook rows with no matching receipt (orphaned or pre-S20)

## Testing

Tests verify:

1. **Edge-then-drain**: Webhook is received at edge, processed in drain, write is applied
2. **Replay test**: Same webhook twice produces exactly one write (no double processing)
3. **Enqueue failure**: If enqueue throws, receipt is rolled back, retry succeeds
4. **THROTTLED retry**: Computed wait from throttleStatus
5. **429 Retry-After**: Header is honoured
6. **No retry on userErrors**: Permanent failures stop immediately
7. **Request-path cap**: At most 1 retry in request context

Run S20 tests:
```bash
npm test -- --grep "S20"
```

## Configuration

### Environment Variables

No new environment variables required. Uses existing:
- `SHOPIFY_API_SECRET`: For HMAC verification

### Database Requirements

- `webhook_receipts` table (created by S20 migration)
- `s6_processed_webhooks` table (created by S6 migration, still used)
- pg_cron extension (for retention purge jobs)

## Monitoring

Log messages for observability:

```
[webhooks.orders] Duplicate ORDERS_CREATE for shop.myshopify.com, skipping
[shopify-client] THROTTLED, waiting 1100ms (attempt 1/4)
[shopify-client] 429 rate limited, waiting 2000ms (attempt 2/4)
[shopify-client] Server error (500), retrying in 200ms (attempt 1/4)
```

## Migration

Migration `20261025010000_s20_webhook_receipts` creates:
- `webhook_receipts` table with indexes
- pg_cron job `s20_webhook_receipts_cleanup` for 30-day retention

Note: `s10_processed_webhooks_cleanup` cron job is kept running since `s6_processed_webhooks` is still actively used for drain-level idempotency.
