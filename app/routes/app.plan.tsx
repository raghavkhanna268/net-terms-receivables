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
import {
  type PlanKey,
  type FeatureKey,
  ALL_PLAN_KEYS,
  ALL_FEATURE_KEYS,
  getPlanConfig,
  planHasFeature,
  planLimit,
} from "~/lib/entitlements";
import {
  PLAN_DISPLAY_NAMES,
  FEATURE_DISPLAY_NAMES,
} from "~/components/UpgradePrompt";
import { buildOverLimitBannerState } from "~/lib/over-limit-banner";
import { safeLog, toErrorCode } from "~/lib/log.server";
import { getAppHandle, buildPlanSelectionUrl } from "~/lib/plan-url";

const FEATURE_DESCRIPTIONS: Record<FeatureKey, string> = {
  aging_dashboard: "Track outstanding receivables with aging buckets",
  unlimited_imports: "Import unlimited bank statements per month",
  matching: "Automatic matching of payments to invoices",
  reminders: "Send payment reminders to buyers",
  credit_holds: "Automatic credit holds for overdue accounts",
  pdf_statements: "Generate PDF statements for buyers",
  payer_memory: "Remember payer preferences and patterns",
  audit_export: "Export audit logs for compliance",
};

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { shopify } = context;
  const { session } = await shopify.authenticate.admin(request);
  const sql = getRequestSql();
  const shopDomain = session.shop;

  const [shop] = await sql<{ id: string }[]>`
    SELECT id FROM "Shop" WHERE domain = ${shopDomain}
  `;

  let planData: ResolvedPlan | null = null;
  let usage: {
    companies: { current: number; limit: number };
    importsThisMonth: { current: number; limit: number };
  } | null = null;
  let gatedCount = 0;
  let error: string | null = null;

  if (shop) {
    try {
      [planData, usage, gatedCount] = await Promise.all([
        resolvePlan(sql, shopDomain),
        getUsageStats(sql, shop.id),
        getGatedAccountCount(sql, shop.id),
      ]);
    } catch (err) {
      safeLog("error", "app.plan.load_plan_data_failed", { err: toErrorCode(err) });
      error = "Failed to load plan information. Please try again.";
    }
  }

  const storeHandle = shopDomain.replace(".myshopify.com", "");
  const gatingEnforced = isGatingEnforced();

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
    usage: usage ?? {
      companies: { current: 0, limit: 3 },
      importsThisMonth: { current: 0, limit: 1 },
    },
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
    error,
  };
};

function formatLimit(limit: number): string {
  return limit === -1 ? "Unlimited" : String(limit);
}

function UsageDisplay({
  current,
  limit,
  label,
}: {
  current: number;
  limit: number;
  label: string;
}) {
  const isUnlimited = limit === -1;
  const isAtLimit = !isUnlimited && current >= limit;
  const isNearLimit = !isUnlimited && current >= limit * 0.8 && current < limit;

  return (
    <s-paragraph>
      <s-text type="strong">{label}: </s-text>
      <s-text>
        {current} / {formatLimit(limit)}
      </s-text>
      {isAtLimit && <s-badge tone="critical">At Limit</s-badge>}
      {!isAtLimit && isNearLimit && <s-badge tone="warning">Near Limit</s-badge>}
    </s-paragraph>
  );
}

function FeatureComparisonTable({ currentPlanKey }: { currentPlanKey: PlanKey }) {
  return (
    <s-table>
      <s-table-header-row>
        <s-table-header listSlot="primary">Feature</s-table-header>
        {ALL_PLAN_KEYS.map((planKey) => (
          <s-table-header listSlot="labeled" key={planKey}>
            {PLAN_DISPLAY_NAMES[planKey]}
            {planKey === currentPlanKey && " ✓"}
          </s-table-header>
        ))}
      </s-table-header-row>
      <s-table-body>
        {ALL_FEATURE_KEYS.map((feature) => (
          <s-table-row key={feature}>
            <s-table-cell>
              <s-text type="strong">{FEATURE_DISPLAY_NAMES[feature]}</s-text>
              <br />
              <s-text>{FEATURE_DESCRIPTIONS[feature]}</s-text>
            </s-table-cell>
            {ALL_PLAN_KEYS.map((planKey) => {
              const plan = getPlanConfig(planKey);
              const hasFeature = planHasFeature(plan, feature);
              return (
                <s-table-cell key={`${feature}-${planKey}`}>
                  {hasFeature ? (
                    <s-text tone="success">✓</s-text>
                  ) : (
                    <s-text>—</s-text>
                  )}
                </s-table-cell>
              );
            })}
          </s-table-row>
        ))}
        <s-table-row>
          <s-table-cell>
            <s-text type="strong">Company Limit</s-text>
            <br />
            <s-text>Maximum buyer accounts</s-text>
          </s-table-cell>
          {ALL_PLAN_KEYS.map((planKey) => {
            const plan = getPlanConfig(planKey);
            const limit = planLimit(plan, "companies");
            return (
              <s-table-cell key={`companies-${planKey}`}>
                <s-text>{formatLimit(limit)}</s-text>
              </s-table-cell>
            );
          })}
        </s-table-row>
        <s-table-row>
          <s-table-cell>
            <s-text type="strong">Monthly Import Limit</s-text>
            <br />
            <s-text>Bank statement imports per month</s-text>
          </s-table-cell>
          {ALL_PLAN_KEYS.map((planKey) => {
            const plan = getPlanConfig(planKey);
            const limit = planLimit(plan, "importsPerMonth");
            return (
              <s-table-cell key={`imports-${planKey}`}>
                <s-text>{formatLimit(limit)}</s-text>
              </s-table-cell>
            );
          })}
        </s-table-row>
      </s-table-body>
    </s-table>
  );
}

export default function PlanPage() {
  const {
    plan,
    usage,
    gatedCount,
    gatingEnforced,
    upgradeUrl,
    error,
  } = useLoaderData<typeof loader>();

  const planKey = (plan?.key ?? "free") as PlanKey;
  const planName = plan?.name ?? "Free";
  const isTest = plan?.isTest ?? false;
  const displayPlanName = PLAN_DISPLAY_NAMES[planKey] || planName;

  const companiesUsed = usage.companies.current;
  const companiesLimit = usage.companies.limit;
  const companiesAtLimit = companiesLimit !== -1 && companiesUsed >= companiesLimit;

  const importsUsed = usage.importsThisMonth.current;
  const importsLimit = usage.importsThisMonth.limit;
  const importsAtLimit = importsLimit !== -1 && importsUsed >= importsLimit;

  const canUpgrade = planKey !== "scale";
  const hasLimitReached = companiesAtLimit || importsAtLimit;

  return (
    <s-page heading="Plan & Usage">
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

          {/* Usage Statistics */}
          <s-section heading="Usage">
            <s-stack>
              <UsageDisplay
                current={companiesUsed}
                limit={companiesLimit}
                label="Buyer Accounts"
              />
              <UsageDisplay
                current={importsUsed}
                limit={importsLimit}
                label="Bank Imports This Month"
              />

              {(() => {
                const bannerState = buildOverLimitBannerState(gatedCount, gatingEnforced);
                return bannerState.show && (
                  <s-banner tone="warning" heading={bannerState.heading}>
                    <s-text>
                      {bannerState.bodyText}
                      {bannerState.enforcementNote && ` ${bannerState.enforcementNote}`}
                    </s-text>
                  </s-banner>
                );
              })()}
            </s-stack>
          </s-section>

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
                ) : hasLimitReached && !gatingEnforced ? (
                  <s-banner tone="info" heading="Usage Note">
                    <s-text>
                      You&apos;ve reached the plan limit, but limits are not currently
                      enforced.
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

          {planKey === "scale" && (
            <s-section heading="Plan Status">
              <s-banner tone="success" heading="Scale Plan">
                <s-text>
                  You&apos;re on the Scale plan with unlimited companies and all features.
                </s-text>
              </s-banner>
            </s-section>
          )}

          {/* Feature Comparison */}
          <s-section heading="Plan Comparison">
            <FeatureComparisonTable currentPlanKey={planKey} />
          </s-section>
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
