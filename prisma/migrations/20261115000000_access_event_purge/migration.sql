-- Retention: access.* AuditEvent rows are kept 365 days; all other AuditEvent
-- types (financial: match.*, invoice.*, account.* ...) are untouched and are
-- deleted only by the shop/redact FK cascade.

-- Partial index so the nightly purge does not scan financial events.
CREATE INDEX IF NOT EXISTS "AuditEvent_access_at_idx"
  ON "AuditEvent" ("at")
  WHERE "type" LIKE 'access.%';

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'audit_purge_access_events_365d',
      '30 3 * * *',   -- daily 03:30 UTC (09:00 IST), after s22 purge at 03:00
      $job$DELETE FROM "AuditEvent"
           WHERE "type" LIKE 'access.%'
             AND "at" < NOW() - INTERVAL '365 days'$job$
    );
  END IF;
END$do$;
