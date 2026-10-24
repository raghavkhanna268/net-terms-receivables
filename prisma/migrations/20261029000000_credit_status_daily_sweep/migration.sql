-- Credit Status Daily Sweep
--
-- pg_cron job that enqueues CREDIT_STATUS_RECOMPUTE messages for accounts
-- with newly-overdue invoices (dueAt crossed the NOW() - 1 day threshold).
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
  
  -- Find accounts with:
  -- 1. At least one overdue invoice (dueAt < NOW() - 1 day)
  -- 2. holdState = 'OK' (not already held)
  -- 3. Not bypassed
  -- 4. Not gated
  FOR v_account IN
    SELECT DISTINCT
      ba.id AS buyer_account_id,
      s.domain AS shop_domain
    FROM "BuyerAccount" ba
    JOIN "Shop" s ON s.id = ba."shopId"
    JOIN "Invoice" i ON i."buyerAccountId" = ba.id
    WHERE ba."holdState" = 'OK'
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
  
  -- Return stats for logging
  RETURN QUERY SELECT v_accounts_enqueued, v_messages_skipped;
END;
$$ LANGUAGE plpgsql;

-- Add helpful comment
COMMENT ON FUNCTION enqueue_credit_status_recomputes() IS 
  'Daily sweep: enqueues CREDIT_STATUS_RECOMPUTE messages for accounts with overdue invoices. '
  'Called by pg_cron at 19:00 UTC (00:30 IST). Does NOT make any HTTP calls - '
  'the drain handler does the actual Shopify metafield sync.';

-- Schedule the cron job (unschedule first for idempotency)
DO $do_block$
BEGIN
  -- Check if pg_cron extension is available
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Unschedule existing job if any (idempotent)
    PERFORM cron.unschedule('credit_status_daily_sweep');
    
    -- Schedule new job: 19:00 UTC = 00:30 IST
    PERFORM cron.schedule(
      'credit_status_daily_sweep',
      '0 19 * * *',
      'SELECT * FROM enqueue_credit_status_recomputes()'
    );
    
    RAISE NOTICE 'Scheduled credit_status_daily_sweep cron job at 19:00 UTC';
  ELSE
    RAISE NOTICE 'pg_cron extension not available, skipping cron job creation';
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    -- Gracefully skip if cron scheduling fails (CI doesn't have pg_cron)
    RAISE NOTICE 'Could not schedule cron job: %', SQLERRM;
END;
$do_block$;
