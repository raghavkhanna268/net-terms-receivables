/**
 * Access event retention purge constants.
 *
 * The pg_cron job 'audit_purge_access_events_365d' runs at 03:30 UTC daily,
 * deleting access.* AuditEvent rows older than 365 days.
 *
 * Financial events (match.*, invoice.*, account.*) are not purged by schedule;
 * they are deleted only by the shop/redact FK cascade.
 *
 * @see prisma/migrations/20261115000000_access_event_purge/migration.sql
 * @see docs/security/data-retention.md
 */

/** pg_cron job name for the access event purge. */
export const ACCESS_EVENT_PURGE_JOB = "audit_purge_access_events_365d";

/** Cron schedule for the access event purge (daily 03:30 UTC). */
export const ACCESS_EVENT_PURGE_SCHEDULE = "30 3 * * *";

/**
 * The DELETE statement used by the pg_cron job.
 * Access events (type LIKE 'access.%') older than 365 days are deleted.
 * Financial and other event types are untouched.
 */
export const ACCESS_EVENT_PURGE_SQL = `DELETE FROM "AuditEvent"
           WHERE "type" LIKE 'access.%'
             AND "at" < NOW() - INTERVAL '365 days'`;
