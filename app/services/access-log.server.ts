/**
 * Access logging for staff reads of customer PII.
 *
 * Records AuditEvent entries when merchant staff view pages containing
 * customer PII in the embedded admin. One event per page view or download,
 * never one per row.
 *
 * - Uses waitUntil for non-blocking writes that never delay or fail the page
 * - Actor is the Shopify staff user id from sessionToken.sub (for embedded apps)
 *   or session.onlineAccessInfo.associated_user.id, else 'unknown' (NEVER an email)
 * - Event data contains only: recordType, recordId?, count?
 * - No names, emails, phone numbers, narration, payerText, amounts, or query strings
 *
 * Retention: AuditEvent rows are kept while the app is installed and deleted by
 * the shop/redact cascade (compliance.server.ts:230; s5 migration line 284).
 * No time-based purge yet.
 */

import type { Sql } from "~/lib/db-light.server";
import { getRequestWaitUntil } from "~/lib/request-context.server";
import { safeLog } from "~/lib/log.server";

/**
 * Event data stored in AuditEvent.data JSON column.
 * Strictly whitelisted fields - the helper rejects any other fields.
 */
export interface AccessEventData {
  recordType: string;
  recordId?: string;
  count?: number;
}

/**
 * Parameters for recording a page access event.
 */
export interface RecordAccessParams {
  shopId: string;
  actor: string;
  action: string;
  recordType: string;
  recordId?: string;
  count?: number;
}

/**
 * JWT payload from sessionToken (subset of fields we use).
 */
interface JwtPayload {
  sub?: string;
}

/**
 * Session type with associated_user (shopify-api 15.0.1 field name).
 */
interface SessionWithUser {
  onlineAccessInfo?: {
    associated_user?: {
      id?: string | number | bigint;
    };
  };
}

/**
 * Check if a string looks like a numeric user ID (not an email).
 * Returns true for non-empty strings containing only digits.
 */
function isNumericId(value: string): boolean {
  return value.length > 0 && /^\d+$/.test(value);
}

/**
 * Extract the staff user id from the session token or session.
 *
 * For embedded apps, shopify.authenticate.admin returns a sessionToken (JWT)
 * where sub contains the staff user id. This is preferred.
 *
 * Falls back to session.onlineAccessInfo.associated_user.id (shopify-api 15.0.1
 * uses snake_case) for offline token flows.
 *
 * Returns 'unknown' if neither is available or if the value looks like an email.
 * NEVER returns an email address, name, or dest.
 */
export function getActorFromSessionToken(
  sessionToken: JwtPayload | undefined,
  session: SessionWithUser
): string {
  if (sessionToken?.sub !== undefined && sessionToken.sub !== null) {
    const sub = String(sessionToken.sub);
    if (isNumericId(sub)) {
      return sub;
    }
    return "unknown";
  }

  const userId = session.onlineAccessInfo?.associated_user?.id;
  if (userId !== undefined && userId !== null) {
    return String(userId);
  }

  return "unknown";
}

/**
 * Build a whitelisted AccessEventData object.
 * Only includes recordType, recordId (if provided), and count (if provided).
 * Rejects any extra fields by construction.
 */
function buildEventData(params: RecordAccessParams): AccessEventData {
  const data: AccessEventData = {
    recordType: params.recordType,
  };
  if (params.recordId !== undefined) {
    data.recordId = params.recordId;
  }
  if (params.count !== undefined) {
    data.count = params.count;
  }
  return data;
}

/**
 * Record a page access event as an AuditEvent.
 *
 * - Uses waitUntil for non-blocking write (page renders immediately)
 * - On failure, logs a count-only error (no PII, no raw error message)
 * - Falls back to fire-and-forget if waitUntil is not available
 *
 * @param sql - postgres.js SQL client
 * @param params - Access event parameters (whitelisted fields only)
 */
export function recordAccess(sql: Sql, params: RecordAccessParams): void {
  const waitUntil = getRequestWaitUntil();
  const eventData = buildEventData(params);
  const eventType = `access.${params.action}`;

  const insertPromise = (async () => {
    try {
      await sql`
        INSERT INTO "AuditEvent" (id, "shopId", actor, type, data, at)
        VALUES (
          gen_random_uuid(),
          ${params.shopId},
          ${params.actor},
          ${eventType},
          ${sql.json(eventData as unknown as Record<string, string | number | undefined>)},
          NOW()
        )
      `;
    } catch {
      safeLog("error", "access_log_insert_failed", {
        shopId: params.shopId,
        topic: eventType,
        count: 1,
      });
    }
  })();

  if (waitUntil) {
    waitUntil(insertPromise);
  }
}
