-- Credit Status Daily Sweep - Include Gated Accounts
--
-- Product rule: Gated accounts are never hidden from totals or lists.
-- Holds and the checkout block work on every plan.
-- Gating applies only to value-add actions (reminders, credit-limit edits, etc.).
--
-- This migration updates the sweep function to include gated accounts.
-- The cron job is unchanged (calls the function by name).

-- Update the function to include gated accounts in the sweep.
-- Removes ba.gated_at IS NULL from both Part 1 and Part 2.
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
  -- Gated accounts are included (gating applies only to value-add actions).
  FOR v_account IN
    SELECT DISTINCT
      ba.id AS buyer_account_id,
      s.domain AS shop_domain
    FROM "BuyerAccount" ba
    JOIN "Shop" s ON s.id = ba."shopId"
    JOIN "Invoice" i ON i."buyerAccountId" = ba.id
    WHERE ba."holdState" IN ('OK', 'NEAR_LIMIT')
      AND ba.bypass = false
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
  
  -- Part 2: Self-heal - Auto-held accounts that may no longer need to be held
  -- Conditions: HELD state, NOT manual hold, and no remaining overdue invoices.
  -- We don't check holdReasonCode because it's only persisted for manual holds.
  -- Let recomputeCreditStatus decide if the hold should be released.
  -- Gated accounts are included (gating applies only to value-add actions).
  FOR v_account IN
    SELECT DISTINCT
      ba.id AS buyer_account_id,
      s.domain AS shop_domain
    FROM "BuyerAccount" ba
    JOIN "Shop" s ON s.id = ba."shopId"
    WHERE ba."holdState" = 'HELD'
      AND ba."manualHold" = false
      AND ba.bypass = false
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

-- Update the comment
COMMENT ON FUNCTION enqueue_credit_status_recomputes() IS 
  'Daily sweep: enqueues CREDIT_STATUS_RECOMPUTE messages for (1) accounts with overdue invoices '
  '(holdState OK or NEAR_LIMIT), and (2) auto-held accounts (manualHold=false) with no remaining '
  'overdue invoices (self-heal). Gated accounts are included (gating applies only to value-add '
  'actions, not to holds or sync). Called by pg_cron at 19:00 UTC (00:30 IST). Does NOT make any '
  'HTTP calls - the drain handler does the actual Shopify metafield sync.';
