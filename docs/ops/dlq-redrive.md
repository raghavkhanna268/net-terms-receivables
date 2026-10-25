# DLQ Redrive Runbook

## Overview

The Dead Letter Queue (DLQ) contains messages that failed processing after maximum
retries or encountered non-retryable errors (schema mismatches, auth failures).

This runbook describes how to investigate and redrive DLQ messages.

## Sanitized Rows

Some DLQ rows are **sanitized** (contain only allowlisted metadata, no payload).
These rows have `message->>'sanitized' = 'true'` and cannot be redriven because
there is no message payload to re-process.

### When are rows sanitized?

Rows are sanitized for `shop_not_found` errors on topics with reconcile coverage:
- Companies, company locations (re-fetched via RECONCILE_COMPANIES)
- Orders (re-fetched via RECONCILE_ORDERS)
- Bulk JSONL with bulkType 'companies' or 'orders'

Sanitized rows preserve audit metadata (topic, webhookId, resourceGid, attemptCount)
but remove PII (shop domain, payload, customer data).

### Known gap: draft orders and customers

Draft order and customer `shop_not_found` rows **are NOT sanitized** because nothing
re-fetches those topics after install. They keep their full message unchanged.

A follow-up (S8 customers/draft-orders reconcile) will enable sanitization for those
topics once reconcile coverage exists.

### Coverage nuances

**COMPANIES_\* topics:** The company handler has no Shop lookup, so companies
never produce `shop_not_found`. They are listed as covered but cannot be sanitized
via the `shop_not_found` path. However, they ARE sanitized via the `no_session`
path when the Shop is missing or uninstalled (see below).

**ORDER/LOCATION/COMPANY CREATE/UPDATE after uninstall (no_session path):**
These topics run `adminGraphQL` before any Shop lookup. After uninstall or redact,
sessions are gone, so these fail with `No session found` (`retryable: false`).
The DLQ reason is `non_retryable:no_session`. When the Shop row is missing or
`uninstalledAt` is set, the message is sanitized (same allowlist as `shop_not_found`).
When the Shop is installed, the full message is stored for debugging.

**Uninstall race window:** The `app/uninstalled` webhook handler deletes sessions
before setting `uninstalledAt`. A `no_session` failure during that brief window
sees an installed Shop and stores the full message. That row is purged by
`deleteShop` at the redact deadline (`compliance.server.ts:193-196`), so no
action is needed.

A follow-up (S8 customers/draft-orders reconcile) will enable sanitization for
customers and draft orders once reconcile coverage exists.

**What actually gets sanitized:**
- `ORDERS_*`, `COMPANY_LOCATIONS_*`, `COMPANIES_*` (CREATE/UPDATE) with
  `no_session` when the Shop row is missing or `uninstalledAt` is set
- `COMPANY_LOCATIONS_DELETE` when the Shop row is missing (handler-level
  `shop_not_found`)
- Bulk `companies`/`orders` (Shop check runs first, gives `permanent:shop_not_found`)

## Diagnosing DLQ Issues

### Check DLQ Contents

Run the [Prod Diagnostics workflow](../../.github/workflows/prod-diagnostics.yml) to see:
- DLQ message counts by topic and error class
- Queue depths and webhook receipt counts
- Entity counts

The workflow outputs DLQ summary in the "Queue and webhook counts" step.

### Common Error Classes

| Error Pattern | Cause | Action |
|---------------|-------|--------|
| `GraphQL query error: Cannot query field` | Schema mismatch (API version changed) | Fix query, redeploy, then redrive |
| `non_retryable:no_session` | Shop uninstalled | Sanitized when shop gone; do not redrive |
| `Authentication failed (401)` | Token revoked/expired | Check token refresh, may need reinstall |
| `HTTP 5xx` | Transient Shopify error | Redrive if recent; investigate if persistent |
| `Max retries exceeded` | Repeated transient failures | Check Shopify status, then redrive |

## Redriving Messages

### Via GitHub Actions (Recommended)

Use the [Prod Diagnostics workflow](https://github.com/raghavkhanna268/net-terms-receivables/actions/workflows/prod-diagnostics.yml) with:

1. **redrive_dlq**: `true`
2. **redrive_topic**: The exact topic name (e.g., `ORDERS_UPDATED`, `COMPANIES_CREATE`)
3. **redrive_limit**: Max messages to redrive (default: 100)

The workflow will:
1. Re-enqueue matching DLQ messages to their original queues
2. Delete successfully redriven messages from s6_dead_letter
3. Report the count and affected queues

**The redrive is idempotent**: re-running with the same parameters only processes
messages that haven't been redriven yet.

### Safety

- Always investigate the root cause before redriving
- Fix schema/code issues first, then redrive
- Start with a small `redrive_limit` (10-50) to validate
- Monitor queue processing after redrive

### Direct SQL (Emergency Only)

For emergencies when GitHub Actions is unavailable:

```sql
-- Preview: Count messages by topic (separating redrivable vs sanitized)
SELECT
  message->>'topic' AS topic,
  COUNT(*) FILTER (WHERE NOT (message ? 'sanitized')) AS redrivable,
  COUNT(*) FILTER (WHERE message ? 'sanitized') AS sanitized
FROM s6_dead_letter
GROUP BY message->>'topic';

-- Preview: Show redrivable messages for a topic (no payloads)
SELECT id, original_queue, dead_lettered_at,
       LEFT(REGEXP_REPLACE(error, ':.*$', ''), 80) AS error_class
FROM s6_dead_letter
WHERE message->>'topic' = 'ORDERS_UPDATED'
  AND NOT (message ? 'sanitized')
ORDER BY dead_lettered_at
LIMIT 20;

-- Redrive (in a transaction for safety)
-- NOTE: Excludes sanitized rows - they have no payload to re-process
BEGIN;

WITH to_redrive AS (
  SELECT id, original_queue, message
  FROM s6_dead_letter
  WHERE message->>'topic' = 'ORDERS_UPDATED'
    AND NOT (message ? 'sanitized')
  ORDER BY dead_lettered_at ASC
  LIMIT 50
),
requeued AS (
  SELECT tr.id, pgmq.send(tr.original_queue, tr.message)
  FROM to_redrive tr
)
DELETE FROM s6_dead_letter
WHERE id IN (SELECT id FROM requeued);

-- Verify, then COMMIT or ROLLBACK
COMMIT;
```

## Post-Redrive Verification

1. Run Prod Diagnostics again to confirm DLQ count decreased
2. Check `pgmq.metrics_all()` for queue depth changes
3. Monitor drain logs for successful processing
4. Verify entity counts match expectations

## Related

- [S10 Jobs](./s10-jobs.md) - Drain job configuration
- [Prod Diagnostics Workflow](../../.github/workflows/prod-diagnostics.yml)
