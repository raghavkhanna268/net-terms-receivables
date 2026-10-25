/**
 * Access logging for staff reads of customer PII.
 *
 * Records AuditEvent entries when merchant staff view pages containing
 * customer PII in the embedded admin. One event per page view or download,
 * never one per row.
 *
 * - Uses waitUntil for non-blocking writes that never delay or fail the page
 * - Actor is the Shopify staff user id from the session's onlineAccessInfo,
 *   or 'unknown' if not available (NEVER an email address)
 * - Event data contains only: recordType, recordId?, count?
 * - No names, emails, phone numbers, narration, payerText, amounts, or query strings
 *
 * Retention: AuditEvent rows cascade-delete with Shop via FK. See compliance.server.ts
 * deleteShop() and the Shop -> AuditEvent onDelete: Cascade FK in schema.prisma.
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
 * Extract the staff user id from a Shopify admin session.
 * Returns the user id as a string, or 'unknown' if not available.
 * NEVER returns an email address.
 */
export function getActorFromSession(session: {
  onlineAccessInfo?: {
    associatedUser?: {
      id?: string | number | bigint;
    };
  };
}): string {
  const userId = session.onlineAccessInfo?.associatedUser?.id;
  if (userId === undefined || userId === null) {
    return "unknown";
  }
  return String(userId);
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
