/**
 * Welcome Link Redirect Handler (App Pricing)
 *
 * Handles the per-plan welcome link redirect from Shopify App Pricing.
 * When plan_handle or charge_id is present, force-refreshes the plan cache
 * using the existing resolvePlan path, then redirects to /app preserving
 * embedded params (shop, host, embedded, etc.).
 *
 * Security:
 * - Shop comes ONLY from authenticated session, never from URL params
 * - plan_handle validated against strict allowlist (starter, growth, unlimited)
 * - Foreign-shop params are silently ignored
 *
 * Failure handling:
 * - If refresh fails, falls back silently to existing semantics
 * - Never throws, never gates
 */

import type { LoaderFunctionArgs, HeadersFunction } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getRequestSql } from "~/lib/request-context.server";
import { processPlanWelcome } from "~/services/plan-welcome.server";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { shopify } = context;
  const { session, redirect: shopifyRedirect } = await shopify.authenticate.admin(request);
  const sql = getRequestSql();
  const sessionShop = session.shop;

  const url = new URL(request.url);
  const urlShopParam = url.searchParams.get("shop");
  const planHandle = url.searchParams.get("plan_handle");
  const chargeId = url.searchParams.get("charge_id");

  await processPlanWelcome(sql, sessionShop, urlShopParam, planHandle, chargeId);

  throw shopifyRedirect("/app?plan_handle=&charge_id=");
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
