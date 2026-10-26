/**
 * Welcome Link Redirect Handler (App Pricing)
 *
 * Handles the per-plan welcome link redirect from Shopify App Pricing.
 * After a merchant picks or confirms a plan in the App Pricing flow, Shopify
 * redirects to this embedded route with a `plan_handle` URL parameter.
 *
 * Security:
 * - Shop comes ONLY from authenticated session, never from URL params
 * - plan_handle is validated against a strict allowlist
 * - Foreign-shop params are silently ignored
 *
 * Verification:
 * - Queries currentAppInstallation.activeSubscriptions to verify the plan
 * - On verification: stores as confirmed plan (plan_key, subscription_*, plan_cached_at)
 * - On empty/error: stores handle as pending (plan_pending_handle only)
 *
 * Idempotency:
 * - Re-visits with same handle do not create duplicates or errors
 * - Already-confirmed plans are never downgraded to pending
 *
 * Gating:
 * - Pending plans NEVER gate, redirect, or block anything
 * - Follows existing rule: unknown uses last confirmed, never-confirmed is not gated
 */

import type { LoaderFunctionArgs, HeadersFunction } from "react-router";
import { redirect } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getRequestSql } from "~/lib/request-context.server";
import { ALL_PLAN_KEYS, type PlanKey } from "~/lib/entitlements";
import { adminGraphQL } from "~/services/drain/admin-client.server";
import { safeLog, toErrorCode } from "~/lib/log.server";

const MAX_HANDLE_LENGTH = 32;

const VALID_PLAN_HANDLES: ReadonlySet<string> = new Set(
  ALL_PLAN_KEYS.filter((k) => k !== "none")
);

interface SubscriptionQueryResponse {
  currentAppInstallation: {
    activeSubscriptions: Array<{
      id: string;
      name: string;
      status: string;
      test: boolean;
    }>;
  } | null;
}

const CURRENT_APP_INSTALLATION_QUERY = `
  query CurrentAppInstallation {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        test
      }
    }
  }
`;

function normalizeHandle(handle: string | null): string | null {
  if (!handle || typeof handle !== "string") return null;
  const trimmed = handle.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > MAX_HANDLE_LENGTH) return null;
  if (!VALID_PLAN_HANDLES.has(trimmed)) return null;
  return trimmed as PlanKey;
}

function handleMatchesSubscription(
  handle: string,
  subscriptionName: string | null | undefined
): boolean {
  if (!subscriptionName) return false;
  return subscriptionName.toLowerCase().trim() === handle;
}

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { shopify } = context;
  const { session } = await shopify.authenticate.admin(request);
  const sql = getRequestSql();
  const sessionShop = session.shop;

  const url = new URL(request.url);

  const urlShopParam = url.searchParams.get("shop");
  if (urlShopParam && urlShopParam !== sessionShop) {
    safeLog("warn", "welcome_foreign_shop_ignored", {});
    return redirect("/app");
  }

  const rawHandle = url.searchParams.get("plan_handle");
  const validatedHandle = normalizeHandle(rawHandle);

  if (!validatedHandle) {
    if (rawHandle) {
      safeLog("warn", "welcome_invalid_handle", {});
    }
    return redirect("/app");
  }

  const [shop] = await sql<{ id: string; plan_key: string | null }[]>`
    SELECT id, plan_key FROM "Shop" WHERE domain = ${sessionShop}
  `;

  if (!shop) {
    safeLog("warn", "welcome_shop_not_found", {});
    return redirect("/app");
  }

  const existingPlanKey = shop.plan_key?.toLowerCase().trim() ?? "none";
  if (existingPlanKey === validatedHandle && existingPlanKey !== "none") {
    return redirect("/app");
  }

  let verified = false;
  let subscriptionId: string | null = null;
  let subscriptionName: string | null = null;
  let isTest = false;

  try {
    const result = await adminGraphQL<SubscriptionQueryResponse>(
      sessionShop,
      CURRENT_APP_INSTALLATION_QUERY
    );

    if (result.success && result.data?.currentAppInstallation?.activeSubscriptions) {
      const subscriptions = result.data.currentAppInstallation.activeSubscriptions;
      const matchingSub = subscriptions.find(
        (sub) =>
          sub.status === "ACTIVE" && handleMatchesSubscription(validatedHandle, sub.name)
      );

      if (matchingSub) {
        verified = true;
        subscriptionId = matchingSub.id;
        subscriptionName = matchingSub.name;
        isTest = matchingSub.test;
      }
    }
  } catch (err) {
    safeLog("warn", "welcome_verification_error", { err: toErrorCode(err) });
  }

  if (verified) {
    await sql`
      UPDATE "Shop"
      SET
        plan_key = ${validatedHandle},
        subscription_id = ${subscriptionId},
        subscription_name = ${subscriptionName},
        is_test = ${isTest},
        plan_cached_at = NOW(),
        plan_pending_handle = NULL,
        "updatedAt" = NOW()
      WHERE id = ${shop.id}
    `;
    safeLog("info", "welcome_plan_confirmed", {
      shopId: shop.id,
      isTest,
    });
  } else {
    const currentPlanKey = shop.plan_key?.toLowerCase().trim() ?? "none";
    const currentIsConfirmed = currentPlanKey !== "none" && currentPlanKey !== "free";

    if (currentIsConfirmed) {
      await sql`
        UPDATE "Shop"
        SET
          plan_pending_handle = ${validatedHandle},
          "updatedAt" = NOW()
        WHERE id = ${shop.id}
      `;
    } else {
      await sql`
        UPDATE "Shop"
        SET
          plan_pending_handle = ${validatedHandle},
          "updatedAt" = NOW()
        WHERE id = ${shop.id}
      `;
    }
    safeLog("info", "welcome_plan_pending", {
      shopId: shop.id,
    });
  }

  return redirect("/app");
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
