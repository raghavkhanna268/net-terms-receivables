/**
 * Plan management page (S21).
 *
 * Displays current plan state, usage statistics, and feature comparison.
 * Uses existing plan.server.ts exports for plan resolution.
 * Upgrade prompts are inert when PLAN_GATING_ENFORCED is off.
 */

import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getRequestSql } from "~/lib/request-context.server";
import { resolvePlan, type ResolvedPlan } from "~/services/plan.server";
import {
  getUsageStats,
  getGatedAccountCount,
  isGatingEnforced,
} from "~/services/gating.server";
import type { PlanKey } from "~/lib/entitlements";
import { PLAN_DISPLAY_NAMES } from "~/components/UpgradePrompt";
import { buildOverLimitBannerState, buildNewAccountsPausedBannerState } from "~/lib/over-limit-banner";
import { safeLog, toErrorCode } from "~/lib/log.server";
import { getAppHandle, buildPlanSelectionUrl } from "~/lib/plan-url";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { shopify } = context;
  const { session } = await shopify.authenticate.admin(request);
  const sql = getRequestSql();
  const shopDomain = session.shop;

  const [shop] = await sql<{ id: string; plan_pending_handle: string | null }[]>`
    SELECT id, plan_pending_handle FROM "Shop" WHERE domain = ${shopDomain}
  `;

  let planData: ResolvedPlan | null = null;
  let usage: {
    companies: { current: number; limit: number };
    importsThisMonth: { current: number; limit: number };
  } | null = null;
  let gatedCount = 0;
  let error: string | null = null;

  const gatingEnforced = isGatingEnforced();

  if (shop) {
    try {
      // Always call getUsageStats for usage display. Only skip getGatedAccountCount when flag off.
      const results = await Promise.all([
        resolvePlan(sql, shopDomain),
        getUsageStats(sql, shop.id).catch((err) => {
          safeLog("warn", "usage_stats_error", { shopId: shop.id, err: toErrorCode(err) });
          return null;
        }),
        gatingEnforced ? getGatedAccountCount(sql, shop.id) : Promise.resolve(0),
      ]);
      planData = results[0];
      usage = results[1];
      gatedCount = results[2];
    } catch (err) {
      safeLog("error", "app.plan.load_plan_data_failed", { err: toErrorCode(err) });
      error = "Failed to load plan information. Please try again.";
    }
  }

  const storeHandle = shopDomain.replace(".myshopify.com", "");

  return {
    storeHandle,
    shopDomain,
    plan: planData
      ? {
          key: planData.plan.key,
          name: planData.subscriptionName ?? planData.plan.key,
          isTest: planData.isTest,
        }
      : null,
    usage,
    gatedCount,
    gatingEnforced,
    upgradeUrl: (() => {
      const handle = getAppHandle();
      if (handle === null) {
        safeLog("warn", "plan_url_app_handle_missing", {});
        return null;
      }
      return buildPlanSelectionUrl(shopDomain, handle);
    })(),
    newAccountsPausedBanner: (gatingEnforced && usage)
      ? buildNewAccountsPausedBannerState(
          usage.companies.current,
          usage.companies.limit,
          gatingEnforced,
          (() => {
            const handle = getAppHandle();
            if (handle === null) return null;
            return buildPlanSelectionUrl(shopDomain, handle);
          })()
        )
      : { show: false, heading: "", bodyText: "", upgradeUrl: null },
    error,
    pendingPlanHandle: shop?.plan_pending_handle ?? null,
  };
};

function formatLimit(limit: number): string {
  return limit === -1 ? "Unlimited" : String(limit);
}

/**
 * UsageDisplay component for showing usage statistics with optional badges.
 * Exported for testing.
 */
export function UsageDisplay({
  current,
  limit,
  label,
  gatingEnforced,
}: {
  current: number;
  limit: number;
  label: string;
  gatingEnforced: boolean;
}) {
  const isUnlimited = limit === -1;
  const isAtLimit = !isUnlimited && current >= limit;
  const isNearLimit = !isUnlimited && current >= limit * 0.8 && current < limit;

  // When gating is off, just show the count without limit comparison
  // This avoids showing confusing '0 / 0' for no-plan shops
  const usageText = gatingEnforced
    ? `${current} / ${formatLimit(limit)}`
    : `${current}`;

  return (
    <s-paragraph>
      <s-text type="strong">{label}: </s-text>
      <s-text>{usageText}</s-text>
      {gatingEnforced && isAtLimit && <s-badge tone="critical">At Limit</s-badge>}
      {gatingEnforced && !isAtLimit && isNearLimit && <s-badge tone="warning">Near Limit</s-badge>}
    </s-paragraph>
  );
}

export default function PlanPage() {
  const {
    plan,
    usage,
    gatedCount,
    gatingEnforced,
    upgradeUrl,
    newAccountsPausedBanner,
    error,
    pendingPlanHandle,
  } = useLoaderData<typeof loader>();

  const planKey = (plan?.key ?? "none") as PlanKey;
  const planName = plan?.name ?? "No Plan";
  const isTest = plan?.isTest ?? false;
  const displayPlanName = PLAN_DISPLAY_NAMES[planKey] || planName;

  const companiesUsed = usage?.companies.current ?? 0;
  const companiesLimit = usage?.companies.limit ?? -1;
  // Plan-limit checks only apply when gating is enforced AND usage is available
  // With none=0, every shop would show "at limit" if we didn't gate this
  const companiesAtLimit = gatingEnforced && usage && companiesLimit !== -1 && companiesUsed >= companiesLimit;

  const importsUsed = usage?.importsThisMonth.current ?? 0;
  const importsLimit = usage?.importsThisMonth.limit ?? -1;
  const importsAtLimit = gatingEnforced && usage && importsLimit !== -1 && importsUsed >= importsLimit;

  const canUpgrade = planKey !== "unlimited";
  const hasLimitReached = companiesAtLimit || importsAtLimit;

  return (
    <s-page heading="Plan & Usage">
      {/* T4: New accounts paused banner */}
      {newAccountsPausedBanner.show && (
        <s-section>
          <s-banner tone="warning" heading={newAccountsPausedBanner.heading}>
            {newAccountsPausedBanner.bodyText}
            {newAccountsPausedBanner.upgradeUrl && (
              <>
                {" "}
                <a href={newAccountsPausedBanner.upgradeUrl} target="_top">
                  Upgrade your plan
                </a>
              </>
            )}
          </s-banner>
        </s-section>
      )}

      {/* Pending Plan Banner */}
      {pendingPlanHandle && (
        <s-section>
          <s-banner tone="info" heading="Plan Selection Received">
            Your plan selection has been received and is being confirmed with Shopify.
            This may take a few moments.
          </s-banner>
        </s-section>
      )}

      {/* Error State */}
      {error && (
        <s-section>
          <s-banner tone="critical" heading="Error">
            {error}
          </s-banner>
        </s-section>
      )}

      {!error && (
        <>
          {/* Current Plan */}
          <s-section heading="Current Plan">
            <s-stack>
              <s-paragraph>
                <s-text type="strong">Plan: </s-text>
                <s-text>
                  {displayPlanName}
                  {isTest && <s-badge tone="info">Test</s-badge>}
                </s-text>
              </s-paragraph>
            </s-stack>
          </s-section>

          {/* Usage Statistics - only show when usage data is available */}
          {usage && (
            <s-section heading="Usage">
              <s-stack>
                <UsageDisplay
                  current={companiesUsed}
                  limit={companiesLimit}
                  label="Buyer Accounts"
                  gatingEnforced={gatingEnforced}
                />
                <UsageDisplay
                  current={importsUsed}
                  limit={importsLimit}
                  label="Bank Imports This Month"
                  gatingEnforced={gatingEnforced}
                />
              </s-stack>
            </s-section>
          )}

          {/* Over-limit banner - shows gated accounts even when usage unavailable */}
          {(() => {
            const bannerState = buildOverLimitBannerState(gatedCount, gatingEnforced);
            return bannerState.show && (
              <s-section>
                <s-banner tone="warning" heading={bannerState.heading}>
                  <s-text>
                    {bannerState.bodyText}
                    {bannerState.enforcementNote && ` ${bannerState.enforcementNote}`}
                  </s-text>
                </s-banner>
              </s-section>
            );
          })()}

          {/* Upgrade Prompt */}
          {canUpgrade && (
            <s-section heading="Upgrade">
              <s-stack>
                {hasLimitReached && gatingEnforced ? (
                  <s-banner tone="warning" heading="Limit Reached">
                    <s-text>
                      You&apos;ve reached your plan limit. Upgrade to continue adding
                      {companiesAtLimit ? " buyer accounts" : ""}
                      {companiesAtLimit && importsAtLimit ? " and" : ""}
                      {importsAtLimit ? " importing bank statements" : ""}.
                    </s-text>
                  </s-banner>
                ) : (
                  <s-paragraph>
                    <s-text>
                      Upgrade to unlock more features and higher limits.
                    </s-text>
                  </s-paragraph>
                )}

                {upgradeUrl && (
                  <s-button href={upgradeUrl} target="_top" variant="primary">
                    View Plans & Upgrade
                  </s-button>
                )}
              </s-stack>
            </s-section>
          )}

          {planKey === "unlimited" && (
            <s-section heading="Plan Status">
              <s-banner tone="success" heading="Unlimited Plan">
                <s-text>
                  You&apos;re on the Unlimited plan with unlimited buyer accounts and priority support.
                </s-text>
              </s-banner>
            </s-section>
          )}
        </>
      )}

      {/* Aside: Gating Status */}
      <s-section slot="aside" heading="Plan Gating">
        <s-stack>
          <s-paragraph>
            <s-text type="strong">Enforcement: </s-text>
            <s-text>
              {gatingEnforced ? (
                <s-badge tone="critical">Active</s-badge>
              ) : (
                <s-badge>Not Enforced</s-badge>
              )}
            </s-text>
          </s-paragraph>
          {!gatingEnforced && (
            <s-paragraph>
              <s-text>
                Plan limits are currently not enforced. All features are available
                regardless of plan tier.
              </s-text>
            </s-paragraph>
          )}
          {gatingEnforced && (
            <s-paragraph>
              <s-text>
                Plan limits are enforced. New accounts over your limit will be
                gated until you upgrade.
              </s-text>
            </s-paragraph>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
