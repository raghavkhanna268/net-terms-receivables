# DLQ Redrive Runbook

## Overview

The Dead Letter Queue (DLQ) contains messages that failed processing after maximum
retries or encountered non-retryable errors (schema mismatches, auth failures).

This runbook describes how to investigate and redrive DLQ messages.

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
| `No offline session found` | Shop uninstalled | Do not redrive (permanent) |
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
-- Preview: Count messages by topic
SELECT message->>'topic' AS topic, COUNT(*)
FROM s6_dead_letter
GROUP BY message->>'topic';

-- Preview: Show messages for a topic (no payloads)
SELECT id, original_queue, dead_lettered_at,
       LEFT(REGEXP_REPLACE(error, ':.*$', ''), 80) AS error_class
FROM s6_dead_letter
WHERE message->>'topic' = 'ORDERS_UPDATED'
ORDER BY dead_lettered_at
LIMIT 20;

-- Redrive (in a transaction for safety)
BEGIN;

WITH to_redrive AS (
  SELECT id, original_queue, message
  FROM s6_dead_letter
  WHERE message->>'topic' = 'ORDERS_UPDATED'
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
