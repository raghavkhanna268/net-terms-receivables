/**
 * Shared Resend email client with pre-launch recipient allowlist guard.
 *
 * Payment and catch-up reminders MUST go through sendViaResend() to ensure
 * the allowlist is enforced.
 *
 * Note: sendDataRequestNotification in compliance.server.ts makes its own
 * direct fetch to api.resend.com on purpose, preserving main's error codes
 * (resend_api_error_{status}, toErrorCode for network errors). It enforces
 * the allowlist itself before the fetch call.
 *
 * Pre-launch behavior:
 * - RESEND_TEST_RECIPIENTS env var contains a comma-separated allowlist
 * - Only addresses in the allowlist receive emails
 * - If the allowlist is missing/empty, ALL sends are blocked (fail closed)
 * - to/cc/bcc are filtered to allowlisted addresses only
 * - If no recipients remain after filtering, send is skipped
 *
 * @module
 */

import {
  parseRecipientAllowlist,
  filterRecipients,
  isAllowlistEnforced,
  type RecipientAllowlist,
} from "./recipient-allowlist.server";

/**
 * Reason enum for skipped sends.
 */
export type ResendSkipReason =
  | "recipient_not_allowlisted"
  | "recipient_allowlist_empty";

/**
 * Result of a Resend send attempt.
 */
export type ResendSendResult =
  | { sent: true; id: string | undefined }
  | { sent: false; skipped: true; reason: ResendSkipReason; skippedCount: number; allowedCount: number }
  | { sent: false; skipped: false; error: string; httpStatus?: number; retryable: boolean };

/**
 * Email parameters for sendViaResend.
 */
export interface ResendEmailParams {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  /** Reply-To address. Sent to Resend as reply_to when set. */
  replyTo?: string;
}

/**
 * Environment parameters for Resend API.
 */
export interface ResendEnv {
  RESEND_API_KEY?: string;
  RESEND_TEST_RECIPIENTS?: string;
  RESEND_RECIPIENT_ALLOWLIST_ENFORCED?: string;
}

/**
 * Get the recipient allowlist from environment.
 * Reads from env param first, then falls back to process.env.
 */
function getAllowlist(env: ResendEnv): RecipientAllowlist {
  const raw = env.RESEND_TEST_RECIPIENTS ?? process.env.RESEND_TEST_RECIPIENTS;
  return parseRecipientAllowlist(raw);
}

/**
 * Filter all recipient fields (to, cc, bcc) through the allowlist.
 * Returns the filtered params and counts.
 *
 * When RESEND_RECIPIENT_ALLOWLIST_ENFORCED is "false", all recipients pass through unchanged.
 */
function filterAllRecipients(
  params: ResendEmailParams,
  allowlist: RecipientAllowlist,
  env: ResendEnv = {}
): {
  filteredParams: ResendEmailParams;
  totalSkipped: number;
  totalAllowed: number;
  hasAnyRecipient: boolean;
} {
  const toResult = filterRecipients(params.to, allowlist, env);
  const ccResult = params.cc ? filterRecipients(params.cc, allowlist, env) : { allowed: [], skippedCount: 0 };
  const bccResult = params.bcc ? filterRecipients(params.bcc, allowlist, env) : { allowed: [], skippedCount: 0 };

  const totalSkipped = toResult.skippedCount + ccResult.skippedCount + bccResult.skippedCount;
  const totalAllowed = toResult.allowed.length + ccResult.allowed.length + bccResult.allowed.length;

  const filteredParams: ResendEmailParams = {
    ...params,
    to: toResult.allowed,
    cc: ccResult.allowed.length > 0 ? ccResult.allowed : undefined,
    bcc: bccResult.allowed.length > 0 ? bccResult.allowed : undefined,
  };

  return {
    filteredParams,
    totalSkipped,
    totalAllowed,
    hasAnyRecipient: totalAllowed > 0,
  };
}

/**
 * Send an email via Resend API with recipient allowlist enforcement.
 *
 * This is the ONLY function that should call the Resend API directly.
 * All email sends in the app MUST go through this function.
 *
 * Pre-launch behavior:
 * - Filters to/cc/bcc to only allowlisted addresses
 * - If allowlist is empty, returns skipped with reason 'recipient_allowlist_empty'
 * - If no recipients remain after filtering, returns skipped with reason 'recipient_not_allowlisted'
 * - Only sends to allowlisted recipients
 *
 * @param params - Email parameters
 * @param env - Environment with RESEND_API_KEY and RESEND_TEST_RECIPIENTS
 * @returns Result indicating sent, skipped, or error
 */
export async function sendViaResend(
  params: ResendEmailParams,
  env: ResendEnv = {}
): Promise<ResendSendResult> {
  const apiKey = env.RESEND_API_KEY ?? process.env.RESEND_API_KEY;

  if (!apiKey || apiKey.trim().length === 0) {
    return {
      sent: false,
      skipped: false,
      error: "resend_no_api_key",
      retryable: false,
    };
  }

  const allowlist = getAllowlist(env);
  const enforced = isAllowlistEnforced(env);

  if (enforced && allowlist.size === 0) {
    const totalOriginal = params.to.length + (params.cc?.length ?? 0) + (params.bcc?.length ?? 0);
    return {
      sent: false,
      skipped: true,
      reason: "recipient_allowlist_empty",
      skippedCount: totalOriginal,
      allowedCount: 0,
    };
  }

  const { filteredParams, totalSkipped, hasAnyRecipient } =
    filterAllRecipients(params, allowlist, env);

  if (!hasAnyRecipient) {
    return {
      sent: false,
      skipped: true,
      reason: "recipient_not_allowlisted",
      skippedCount: totalSkipped,
      allowedCount: 0,
    };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  if (params.idempotencyKey) {
    headers["Idempotency-Key"] = params.idempotencyKey;
  }

  const body: Record<string, unknown> = {
    from: filteredParams.from,
    to: filteredParams.to,
    subject: filteredParams.subject,
    html: filteredParams.html,
  };

  if (filteredParams.text) {
    body.text = filteredParams.text;
  }

  if (filteredParams.cc && filteredParams.cc.length > 0) {
    body.cc = filteredParams.cc;
  }

  if (filteredParams.bcc && filteredParams.bcc.length > 0) {
    body.bcc = filteredParams.bcc;
  }

  if (filteredParams.headers && Object.keys(filteredParams.headers).length > 0) {
    body.headers = filteredParams.headers;
  }

  if (params.replyTo && params.replyTo.trim().length > 0) {
    body.reply_to = params.replyTo;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const isAuthError = response.status === 401;
    const isRateLimited = response.status === 429;
    const isServerError = response.status >= 500;
    const isRetryable = isRateLimited || isServerError;

    const errorCode = isAuthError
      ? "resend_auth_error"
      : isRateLimited
        ? "resend_rate_limited"
        : isServerError
          ? "resend_server_error"
          : "resend_error";

    return {
      sent: false,
      skipped: false,
      error: errorCode,
      httpStatus: response.status,
      retryable: isRetryable,
    };
  }

  const result = (await response.json()) as { id?: string };

  return {
    sent: true,
    id: result.id,
  };
}
