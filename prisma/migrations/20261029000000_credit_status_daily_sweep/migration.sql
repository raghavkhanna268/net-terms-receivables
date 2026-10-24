-- Credit Status Daily Sweep
--
-- pg_cron job that enqueues CREDIT_STATUS_RECOMPUTE messages for accounts
-- that may need their credit status updated:
--
-- 1. Accounts with newly-overdue invoices (dueAt crossed NOW() - 1 day threshold)
--    - Any non-HELD state (OK, NEAR_LIMIT) needs recompute
-- 2. Self-heal: HELD accounts whose overdue invoices are all cleared
--    - holdReasonCode = 'PAYMENT_OVERDUE' but no remaining overdue invoices
--
-- Design:
-- - pg_cron CANNOT call Shopify (no pg_net/http calls)
-- - Cron ONLY enqueues messages to pgmq s6_sync queue
-- - Worker drain handler does the actual recompute and metafield sync
-- - Deterministic dedupe key per account per day prevents duplicate messages
-- - Uses existing s6_processed_webhooks table for idempotency
--
-- Schedule: 00:30 IST = 19:00 UTC (daily)
-- This gives a buffer after midnight IST when invoices might cross the threshold.

-- Create a function that enqueues credit status recompute messages.
-- This is called by pg_cron and MUST NOT make any external HTTP calls.
CREATE OR REPLACE FUNCTION enqueue_credit_status_recomputes()
RETURNS TABLE (accounts_enqueued INTEGER, messages_skipped INTEGER) AS $$
DECLARE
  v_accounts_enqueued INTEGER := 0;
  v_messages_skipped INTEGER := 0;
  v_account RECORD;
  v_dedupe_key TEXT;
  v_today TEXT;
  v_message JSONB;
BEGIN
  -- Get today's date for dedupe key
  v_today := TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD');
  
  -- Part 1: Find accounts with overdue invoices that are NOT already held
  -- This includes holdState = 'OK' OR holdState = 'NEAR_LIMIT'
  -- (any non-HELD, non-BYPASS state)
  FOR v_account IN
    SELECT DISTINCT
      ba.id AS buyer_account_id,
      s.domain AS shop_domain
    FROM "BuyerAccount" ba
    JOIN "Shop" s ON s.id = ba."shopId"
    JOIN "Invoice" i ON i."buyerAccountId" = ba.id
    WHERE ba."holdState" IN ('OK', 'NEAR_LIMIT')
      AND ba.bypass = false
      AND ba.gated_at IS NULL
      AND i.status = 'open'
      AND i.outstanding > 0
      AND i."dueAt" IS NOT NULL
      AND i."dueAt" < NOW() - INTERVAL '1 day'
  LOOP
    -- Create deterministic dedupe key: account ID + date
    v_dedupe_key := 'credit_recompute:' || v_account.buyer_account_id || ':' || v_today;
    
    -- Check if already processed today (idempotency)
    -- s6_processed_webhooks uses webhook_id as PK (no shop column)
    IF EXISTS (
      SELECT 1 FROM s6_processed_webhooks
      WHERE webhook_id = v_dedupe_key
    ) THEN
      v_messages_skipped := v_messages_skipped + 1;
      CONTINUE;
    END IF;
    
    -- Build the message
    v_message := jsonb_build_object(
      'topic', 'CREDIT_STATUS_RECOMPUTE',
      'shop', v_account.shop_domain,
      'buyerAccountId', v_account.buyer_account_id,
      'source', 'daily_sweep',
      'webhookId', v_dedupe_key,
      'resourceGid', v_account.buyer_account_id
    );
    
    -- Enqueue to pgmq s6_sync queue
    PERFORM pgmq.send('s6_sync', v_message);
    
    v_accounts_enqueued := v_accounts_enqueued + 1;
  END LOOP;
  
  -- Part 2: Self-heal - HELD accounts with PAYMENT_OVERDUE that no longer have overdue invoices
  -- If a payment event was missed, this allows the account to be released
  FOR v_account IN
    SELECT DISTINCT
      ba.id AS buyer_account_id,
      s.domain AS shop_domain
    FROM "BuyerAccount" ba
    JOIN "Shop" s ON s.id = ba."shopId"
    WHERE ba."holdState" = 'HELD'
      AND ba."holdReasonCode" = 'PAYMENT_OVERDUE'
      AND ba.bypass = false
      AND ba.gated_at IS NULL
      AND ba."manualHold" = false
      -- No overdue invoices remaining
      AND NOT EXISTS (
        SELECT 1 FROM "Invoice" i
        WHERE i."buyerAccountId" = ba.id
          AND i.status = 'open'
          AND i.outstanding > 0
          AND i."dueAt" IS NOT NULL
          AND i."dueAt" < NOW() - INTERVAL '1 day'
      )
  LOOP
    v_dedupe_key := 'credit_recompute:' || v_account.buyer_account_id || ':' || v_today;
    
    IF EXISTS (
      SELECT 1 FROM s6_processed_webhooks
      WHERE webhook_id = v_dedupe_key
    ) THEN
      v_messages_skipped := v_messages_skipped + 1;
      CONTINUE;
    END IF;
    
    v_message := jsonb_build_object(
      'topic', 'CREDIT_STATUS_RECOMPUTE',
      'shop', v_account.shop_domain,
      'buyerAccountId', v_account.buyer_account_id,
      'source', 'daily_sweep',
      'webhookId', v_dedupe_key,
      'resourceGid', v_account.buyer_account_id
    );
    
    PERFORM pgmq.send('s6_sync', v_message);
    
    v_accounts_enqueued := v_accounts_enqueued + 1;
  END LOOP;
  
  -- Return stats for logging
  RETURN QUERY SELECT v_accounts_enqueued, v_messages_skipped;
END;
$$ LANGUAGE plpgsql;

-- Add helpful comment
COMMENT ON FUNCTION enqueue_credit_status_recomputes() IS 
  'Daily sweep: enqueues CREDIT_STATUS_RECOMPUTE messages for (1) accounts with overdue invoices '
  '(holdState OK or NEAR_LIMIT), and (2) HELD accounts with PAYMENT_OVERDUE but no remaining overdue '
  'invoices (self-heal). Called by pg_cron at 19:00 UTC (00:30 IST). Does NOT make any HTTP calls - '
  'the drain handler does the actual Shopify metafield sync.';

-- Schedule the cron job (follows s13 pattern: IF EXISTS guard for unschedule)
DO $do$
DECLARE
  job_exists BOOLEAN;
BEGIN
  -- Check if pg_cron extension is available
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron extension not available, skipping cron job creation';
    RETURN;
  END IF;

  -- Check if job already exists (idempotent)
  SELECT EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'credit_status_daily_sweep'
  ) INTO job_exists;

  IF job_exists THEN
    -- Unschedule existing job first (ensures idempotency on re-run)
    PERFORM cron.unschedule('credit_status_daily_sweep');
  END IF;

  -- Schedule new job: 19:00 UTC = 00:30 IST
  PERFORM cron.schedule(
    'credit_status_daily_sweep',
    '0 19 * * *',
    'SELECT * FROM enqueue_credit_status_recomputes()'
  );

  RAISE NOTICE 'Scheduled credit_status_daily_sweep cron job at 19:00 UTC';

EXCEPTION
  WHEN OTHERS THEN
    -- Only log if pg_cron is installed but scheduling failed for another reason
    RAISE NOTICE 'Failed to schedule pg_cron job: %. Manual invocation via enqueue_credit_status_recomputes() is still available.', SQLERRM;
END;
$do$;
