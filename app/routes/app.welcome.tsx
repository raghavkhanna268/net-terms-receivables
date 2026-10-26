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
import { processPlanWelcome } from "~/services/plan-welcome.server";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { shopify } = context;
  const { session } = await shopify.authenticate.admin(request);
  const sql = getRequestSql();
  const sessionShop = session.shop;

  const url = new URL(request.url);
  const urlShopParam = url.searchParams.get("shop");
  const rawPlanHandle = url.searchParams.get("plan_handle");

  await processPlanWelcome(sql, sessionShop, urlShopParam, rawPlanHandle);

  return redirect("/app");
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
