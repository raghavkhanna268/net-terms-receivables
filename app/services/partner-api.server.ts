/**
 * Partner API client for Shopify App Pricing integration.
 *
 * This module provides the low-level Partner API client used by
 * PartnerApiPlanSource. It queries activeSubscription to determine
 * the shop's current plan.
 *
 * The Partner API version is pinned per DevOps verification.
 * Rate limit: 4 requests/second per API client.
 *
 * @see https://shopify.dev/docs/api/partner/2026-10
 */

import type { PlanKey } from "~/lib/entitlements";
import { safeLog } from "~/lib/log.server";

/**
 * Partner API version, pinned to the newest dated version verified working on 2026-10-25.
 */
export const PARTNER_API_VERSION = "2026-10";

/**
 * Map plan handles from Partner API to internal plan keys.
 * T1 will move this to a shared location; for now it's local.
 *
 * Handles: starter, growth, unlimited
 * Private test plan: shopify-test maps to 'none' state (not a PlanKey)
 */
const PLAN_HANDLE_TO_KEY: Record<string, PlanKey | "none"> = {
  starter: "starter",
  growth: "growth",
  unlimited: "scale",
  "shopify-test": "none",
};

/**
 * Map a plan handle to internal plan key.
 * Returns undefined for unknown handles (treated as error, not demotion).
 */
export function mapPlanHandleToKey(handle: string | null | undefined): PlanKey | "none" | undefined {
  if (!handle) return undefined;
  return PLAN_HANDLE_TO_KEY[handle.toLowerCase()];
}

/**
 * Partner API configuration from environment variables.
 */
export interface PartnerConfig {
  orgId: string;
  token: string;
  appGid: string;
}

/**
 * Error codes used by Partner API client.
 */
export type PartnerApiErrorCode =
  | "partner_throttled"
  | "partner_http_error"
  | "partner_bad_json"
  | "partner_graphql_error"
  | "partner_malformed";

/**
 * Error thrown by Partner API client.
 * The code is safe for logging (no PII).
 */
export class PartnerApiError extends Error {
  readonly code: PartnerApiErrorCode;
  readonly httpStatus?: number;

  constructor(code: PartnerApiErrorCode, httpStatus?: number) {
    super(`Partner API error: ${code}${httpStatus ? ` (${httpStatus})` : ""}`);
    this.name = "PartnerApiError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const configInvalidLogged = new Set<string>();

/**
 * Read Partner API configuration from environment variables.
 *
 * Required env vars:
 * - SHOPIFY_PARTNER_ORG_ID: Numeric org ID (e.g., "123")
 * - SHOPIFY_PARTNER_API_TOKEN: Partner API token (never logged)
 * - SHOPIFY_APP_GID: App GID in format gid://shopify/App/{id}
 *
 * Returns null if any env var is missing or malformed.
 * Logs each invalid field at most once per isolate.
 */
export function readPartnerConfig(): PartnerConfig | null {
  const orgId = process.env.SHOPIFY_PARTNER_ORG_ID?.trim();
  const token = process.env.SHOPIFY_PARTNER_API_TOKEN?.trim();
  const appGid = process.env.SHOPIFY_APP_GID?.trim();

  if (!orgId || !/^\d+$/.test(orgId)) {
    if (!configInvalidLogged.has("org_id")) {
      configInvalidLogged.add("org_id");
      safeLog("warn", "partner_api_config_invalid", { reason: "org_id" });
    }
    return null;
  }

  if (!token) {
    if (!configInvalidLogged.has("token")) {
      configInvalidLogged.add("token");
      safeLog("warn", "partner_api_config_invalid", { reason: "token" });
    }
    return null;
  }

  if (!appGid || !/^gid:\/\/shopify\/App\/\d+$/.test(appGid)) {
    if (!configInvalidLogged.has("app_gid")) {
      configInvalidLogged.add("app_gid");
      safeLog("warn", "partner_api_config_invalid", { reason: "app_gid" });
    }
    return null;
  }

  return { orgId, token, appGid };
}

/**
 * Reset config invalid log tracking (for testing only).
 * @internal
 */
export function _resetConfigLoggingForTesting(): void {
  configInvalidLogged.clear();
}

/**
 * GraphQL query for active subscription.
 * Data minimization: only fetch fields we actually use (items.handle, legacySubscriptionId).
 */
const ACTIVE_SUBSCRIPTION_QUERY = `
query ActiveSubscription($appId: ID!, $shopId: ID!) {
  activeSubscription(appId: $appId, shopId: $shopId) {
    items { handle }
    legacySubscriptionId
  }
}
`;

/**
 * Shape of the activeSubscription response from Partner API.
 * Only includes fields we query (data minimization).
 */
export interface ActiveSubscription {
  items: Array<{ handle: string | null }>;
  legacySubscriptionId: string | null;
}

interface PartnerApiResponse {
  data?: {
    activeSubscription?: ActiveSubscription | null;
  };
  errors?: Array<{
    message: string;
    extensions?: { code?: string };
  }>;
}

/**
 * Fetch the active subscription from Partner API.
 *
 * @param cfg - Partner API configuration
 * @param shopGid - Shop GID in format gid://shopify/Shop/{id}
 * @param options - Optional abort signal for timeout
 * @returns The active subscription, or null if no subscription
 * @throws PartnerApiError on HTTP errors, throttling, or malformed responses
 */
export async function fetchActiveSubscription(
  cfg: PartnerConfig,
  shopGid: string,
  options?: { signal?: AbortSignal }
): Promise<ActiveSubscription | null> {
  const url = `https://partners.shopify.com/${cfg.orgId}/api/${PARTNER_API_VERSION}/graphql.json`;

  const signal = options?.signal ?? AbortSignal.timeout(5000);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": cfg.token,
      },
      body: JSON.stringify({
        query: ACTIVE_SUBSCRIPTION_QUERY,
        variables: {
          appId: cfg.appGid,
          shopId: shopGid,
        },
      }),
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new PartnerApiError("partner_http_error", 408);
    }
    throw new PartnerApiError("partner_http_error");
  }

  if (res.status === 429) {
    throw new PartnerApiError("partner_throttled", 429);
  }

  if (!res.ok) {
    throw new PartnerApiError("partner_http_error", res.status);
  }

  let body: PartnerApiResponse;
  try {
    body = await res.json();
  } catch {
    throw new PartnerApiError("partner_bad_json");
  }

  if (body.errors?.length) {
    const is429 = body.errors.some((e) => e.extensions?.code === "429");
    if (is429) {
      throw new PartnerApiError("partner_throttled", 429);
    }
    throw new PartnerApiError("partner_graphql_error");
  }

  if (!body.data || !("activeSubscription" in body.data)) {
    throw new PartnerApiError("partner_malformed");
  }

  return body.data.activeSubscription ?? null;
}
