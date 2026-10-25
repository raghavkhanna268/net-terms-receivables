/**
 * Unsubscribe route for payment reminder opt-out (S18 #232).
 *
 * Implements RFC 8058 one-click unsubscribe:
 * - GET: Shows confirmation page (no state change, safe for link scanners)
 * - POST with body "List-Unsubscribe=One-Click": Opts out immediately (idempotent)
 *
 * Security:
 * - Token is HMAC-SHA256 signed with REMINDER_UNSUBSCRIBE_SECRET
 * - Constant-time comparison prevents timing attacks
 * - Bad tokens get a generic response (no information leakage)
 * - No PII logged (only IDs and enums via safeLog)
 * - No auth required (public route with signed token)
 *
 * @see https://datatracker.ietf.org/doc/html/rfc8058
 */

import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, Form } from "react-router";
import { verifyUnsubscribeToken } from "~/services/reminder-unsubscribe-token.server";
import { setBuyerOptOut, isBuyerOptedOut } from "~/services/reminder-optout.server";
import { safeLog } from "~/lib/log.server";
import { getRequestSql } from "~/lib/request-context.server";

/**
 * GET handler: Show confirmation page.
 *
 * Per RFC 8058, GET must NOT change state. This allows link scanners
 * and prefetchers to safely access the URL without unsubscribing anyone.
 *
 * The page shows a confirmation button that POSTs to complete the unsubscribe.
 */
export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    return { valid: false, alreadyOptedOut: false };
  }

  const cfEnv = context?.cloudflare?.env as { REMINDER_UNSUBSCRIBE_SECRET?: string; REMINDER_UNSUBSCRIBE_SECRET_PREVIOUS?: string } | undefined;
  const secret = cfEnv?.REMINDER_UNSUBSCRIBE_SECRET ?? process.env.REMINDER_UNSUBSCRIBE_SECRET;
  const previousSecret = cfEnv?.REMINDER_UNSUBSCRIBE_SECRET_PREVIOUS ?? process.env.REMINDER_UNSUBSCRIBE_SECRET_PREVIOUS;

  const payload = verifyUnsubscribeToken(token, secret, previousSecret);

  if (!payload) {
    // Log invalid token attempt (no PII, just the fact it happened)
    safeLog("warn", "unsubscribe_invalid_token", { reason: "invalid_token" });
    return { valid: false, alreadyOptedOut: false };
  }

  // Check if already opted out
  const sql = getRequestSql();
  const alreadyOptedOut = await isBuyerOptedOut(sql, payload.shopId, payload.buyerAccountId);
  return { valid: true, alreadyOptedOut };
};

/**
 * POST handler: Process unsubscribe.
 *
 * Per RFC 8058, the POST body should be "List-Unsubscribe=One-Click".
 * We accept this as form data for email client compatibility.
 *
 * The operation is idempotent: a second POST is a no-op 200.
 */
export const action = async ({ request, context }: ActionFunctionArgs) => {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    return { success: false, error: "missing_token" };
  }

  const cfEnv = context?.cloudflare?.env as { REMINDER_UNSUBSCRIBE_SECRET?: string; REMINDER_UNSUBSCRIBE_SECRET_PREVIOUS?: string } | undefined;
  const secret = cfEnv?.REMINDER_UNSUBSCRIBE_SECRET ?? process.env.REMINDER_UNSUBSCRIBE_SECRET;
  const previousSecret = cfEnv?.REMINDER_UNSUBSCRIBE_SECRET_PREVIOUS ?? process.env.REMINDER_UNSUBSCRIBE_SECRET_PREVIOUS;

  const payload = verifyUnsubscribeToken(token, secret, previousSecret);

  if (!payload) {
    // Log invalid token attempt (no PII)
    safeLog("warn", "unsubscribe_invalid_token_post", { reason: "invalid_token" });
    // Return generic success to not leak token validity
    return { success: true, alreadyOptedOut: true };
  }

  // Verify the POST body contains the RFC 8058 key (optional but recommended)
  // Email clients send "List-Unsubscribe=One-Click" as form data
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const listUnsubscribe = formData.get("List-Unsubscribe");
    // RFC 8058: value should be "One-Click" but we accept the POST regardless
    // since the signed token is the real authorization
    if (listUnsubscribe) {
      safeLog("info", "unsubscribe_rfc8058_oneclick", {
        shopId: payload.shopId,
        buyerAccountId: payload.buyerAccountId,
      });
    }
  }

  const sql = getRequestSql();
  // Set opt-out with source='link' (idempotent)
  const applied = await setBuyerOptOut(sql, payload.shopId, payload.buyerAccountId, "link");

  safeLog("info", "unsubscribe_completed", {
    shopId: payload.shopId,
    buyerAccountId: payload.buyerAccountId,
    applied,
  });

  return { success: true, alreadyOptedOut: !applied };
};

/**
 * Unsubscribe confirmation page.
 *
 * Shows:
 * - Invalid token: generic message (no info leakage)
 * - Already opted out: confirmation message
 * - Valid token: confirmation button to POST
 *
 * No PII is displayed on the page.
 */
export default function UnsubscribePage() {
  const data = useLoaderData<typeof loader>();

  return (
    <div style={{
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      lineHeight: 1.6,
      color: "#1a1a1a",
      maxWidth: "500px",
      margin: "0 auto",
      padding: "2rem 1rem",
      minHeight: "100vh",
    }}>
      <div style={{
        background: "#fff",
        borderRadius: "8px",
        padding: "2rem",
        boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
      }}>
        {!data.valid ? (
          <>
            <h1 style={{ margin: "0 0 1rem", fontSize: "1.5rem", color: "#111" }}>
              Unsubscribe
            </h1>
            <p style={{ margin: "0 0 1rem", color: "#444" }}>
              This unsubscribe link is invalid or has expired.
            </p>
            <p style={{ color: "#6b7280", fontSize: "0.875rem" }}>
              If you want to manage your reminder preferences, please contact the merchant directly.
            </p>
          </>
        ) : data.alreadyOptedOut ? (
          <>
            <h1 style={{ margin: "0 0 1rem", fontSize: "1.5rem", color: "#059669" }}>
              Already Unsubscribed
            </h1>
            <p style={{ margin: "0 0 1rem", color: "#444" }}>
              You have already been unsubscribed from payment reminder emails.
            </p>
            <p style={{ color: "#6b7280", fontSize: "0.875rem" }}>
              Only the merchant can re-enable reminders for your account.
            </p>
          </>
        ) : (
          <>
            <h1 style={{ margin: "0 0 1rem", fontSize: "1.5rem", color: "#111" }}>
              Unsubscribe from Payment Reminders
            </h1>
            <p style={{ margin: "0 0 1rem", color: "#444" }}>
              Click the button below to stop receiving payment reminder emails.
            </p>
            <p style={{ margin: "0 0 1rem", color: "#6b7280", fontSize: "0.875rem" }}>
              After unsubscribing, only the merchant can re-enable reminders for your account.
            </p>
            <Form method="post">
              <input type="hidden" name="List-Unsubscribe" value="One-Click" />
              <button
                type="submit"
                style={{
                  display: "inline-block",
                  background: "#dc2626",
                  color: "#fff",
                  padding: "0.75rem 1.5rem",
                  border: "none",
                  borderRadius: "6px",
                  fontSize: "1rem",
                  cursor: "pointer",
                }}
              >
                Unsubscribe
              </button>
            </Form>
          </>
        )}
      </div>
    </div>
  );
}
