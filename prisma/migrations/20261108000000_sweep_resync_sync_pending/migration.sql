-- Sweep Resync for Sync Pending Accounts (#204)
--
-- This migration:
-- 1. Adds nullable columns for tracking permanent metafield sync failures
-- 2. Updates the sweep function to add Part 3: resync pass for stale syncPending accounts
--
-- The resync pass selects accounts where:
-- - syncPending = true
-- - metafieldSyncedAt IS NULL OR older than 1 day
-- - Shop is not uninstalled
-- - Account is not a no-owner row (COMPANY with NULL companyLocationId, TAGGED_CUSTOMER with NULL customerId)
-- - Account is not redacted (customerId like '%\_redacted\_%')
-- - Account does not have a permanent sync error marker set
--
-- BYPASS accounts ARE included because BYPASS writes hold:false to unblock.
-- The resync pass ONLY enqueues; it NEVER changes holdState.

-- Add columns for tracking permanent metafield sync failures
-- These are nullable with no default and no backfill
ALTER TABLE "BuyerAccount"
  ADD COLUMN "metafieldSyncErrorCode" TEXT,
  ADD COLUMN "metafieldSyncErrorAt" TIMESTAMPTZ(3);

-- Update the sweep function with Part 3: resync pass
-- Part 1 and Part 2 are BYTE-IDENTICAL to 20261102000000_credit_status_sweep_include_gated
CREATE OR REPLACE FUNCTION enqueue_credit_status_recomputes()
RETURNS TABLE (accounts_enqueued INTEGER, messages_skipped INTEGER) AS $$
DECLARE
  v_accounts_enqueued INTEGER := 0;
  v_messages_skipped INTEGER := 0;
  v_account RECORD;
  v_dedupe_key TEXT;
  v_today TEXT;
  v_message JSONB;
  c_resync_cap CONSTANT INTEGER := 100;
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
  -- (RETURN QUERY moved to end of function for Part 3)
  
  -- Part 3: Resync pass - Accounts with stale syncPending that need metafield retry
  -- This handles both directions:
  -- A) Hold direction: HELD in DB but metafield write failed, checkout not blocking
  -- B) Release direction: OK/NEAR_LIMIT in DB but metafield still has hold:true, buyer blocked
  --
  -- Selection criteria:
  -- - syncPending = true (DB state differs from last successful metafield write)
  -- - metafieldSyncedAt IS NULL OR older than 1 day (stale)
  -- - Shop is installed (uninstalledAt IS NULL)
  -- - Not a no-owner row (would fail permanently)
  -- - Not a redacted account (customerId like '%\_redacted\_%')
  -- - No permanent sync error marker (metafieldSyncErrorCode IS NULL)
  --
  -- BYPASS accounts ARE included: BYPASS writes hold:false to unblock checkout.
  -- This pass ONLY enqueues for sync. It NEVER changes holdState.
  -- Key: credit_resync:<id>:<UTC date> (distinct from credit_recompute:)
  -- Order: metafieldSyncedAt NULLS FIRST, id (deterministic, prioritizes never-synced)
  -- Cap: c_resync_cap per run (100)
  FOR v_account IN
    SELECT
      ba.id AS buyer_account_id,
      s.domain AS shop_domain
    FROM "BuyerAccount" ba
    JOIN "Shop" s ON s.id = ba."shopId"
    WHERE ba."syncPending" = true
      AND (ba."metafieldSyncedAt" IS NULL OR ba."metafieldSyncedAt" < NOW() - INTERVAL '1 day')
      AND s."uninstalledAt" IS NULL
      -- Exclude no-owner rows: COMPANY must have companyLocationId, TAGGED_CUSTOMER must have customerId
      AND NOT (ba.kind = 'COMPANY' AND ba."companyLocationId" IS NULL)
      AND NOT (ba.kind = 'TAGGED_CUSTOMER' AND ba."customerId" IS NULL)
      -- Exclude redacted accounts (customerId like 'gid://...._redacted_<timestamp>')
      -- Use ESCAPE '\' because _ is a wildcard in LIKE
      AND (ba."customerId" IS NULL OR ba."customerId" NOT LIKE '%\_redacted\_%' ESCAPE '\')
      -- Exclude accounts with permanent sync error marker
      AND ba."metafieldSyncErrorCode" IS NULL
    ORDER BY ba."metafieldSyncedAt" NULLS FIRST, ba.id
    LIMIT c_resync_cap
  LOOP
    -- Use distinct key prefix to avoid collision with credit_recompute:
    v_dedupe_key := 'credit_resync:' || v_account.buyer_account_id || ':' || v_today;
    
    -- Idempotent per UTC day
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
  '(holdState OK or NEAR_LIMIT), (2) auto-held accounts (manualHold=false) with no remaining '
  'overdue invoices (self-heal), and (3) accounts with stale syncPending for metafield resync '
  '(handles both hold and release directions). Gated accounts are included (gating applies only '
  'to value-add actions, not to holds or sync). Resync excludes uninstalled shops, no-owner rows, '
  'redacted accounts, and accounts with permanent sync errors. Called by pg_cron at 19:00 UTC. '
  'Does NOT make any HTTP calls - the drain handler does the actual Shopify metafield sync.';
