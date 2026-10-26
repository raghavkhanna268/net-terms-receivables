/**
 * Typed helper for mapping sync error codes to user-friendly messages.
 * Never shows raw error codes in the UI.
 */

export type SyncErrorCategory = "session" | "permission" | "owner" | "generic";

export interface SyncErrorInfo {
  category: SyncErrorCategory;
  message: string;
}

const KNOWN_SESSION_ERRORS = [
  "no_session",
  "invalid_grant",
  "token_refresh_failed",
  "no_refresh_token",
  "missing_credentials",
] as const;

/**
 * Maps a sync error code to a user-friendly error info object.
 * 
 * Categories:
 * - session: App session errors (no_session, invalid_grant, etc.) → reinstall message
 * - permission: Access denied → missing permissions message
 * - owner: Entity not found → company/customer deleted message
 * - generic: Unknown errors or dead-letter only → contact support message
 * 
 * The returned message NEVER contains the raw error code.
 */
export function getSyncErrorInfo(errorCode: string | null): SyncErrorInfo {
  if (errorCode === null) {
    return {
      category: "generic",
      message: "Credit settings couldn't sync to Shopify after multiple attempts. Automatic retries have stopped. Please contact support if this persists.",
    };
  }

  if ((KNOWN_SESSION_ERRORS as readonly string[]).includes(errorCode)) {
    return {
      category: "session",
      message: "Credit settings couldn't sync to Shopify because the app session expired. Automatic retries have stopped. Reopen the app, or reinstall it to restore the connection.",
    };
  }

  if (errorCode === "access_denied") {
    return {
      category: "permission",
      message: "Credit settings couldn't sync to Shopify because the app is missing required permissions. Automatic retries have stopped. Please reinstall the app to grant the necessary access.",
    };
  }

  if (errorCode === "owner_not_found") {
    return {
      category: "owner",
      message: "Credit settings couldn't sync to Shopify because the company location or customer no longer exists. The buyer account may need to be removed or reassigned.",
    };
  }

  return {
    category: "generic",
    message: "Credit settings couldn't sync to Shopify after repeated attempts. Automatic retries have stopped. Please contact support for assistance.",
  };
}
