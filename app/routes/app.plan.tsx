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
  getPlanConfig,
  planHasFeature,
  planLimit,
} from "~/lib/entitlements";

const PLAN_DISPLAY_NAMES: Record<PlanKey, string> = {
  free: "Free",
  starter: "Starter",
  growth: "Growth",
  scale: "Scale",
};

const FEATURE_DISPLAY_NAMES: Record<FeatureKey, string> = {
  aging_dashboard: "Aging Dashboard",
  unlimited_imports: "Unlimited Bank Imports",
  matching: "Payment Matching",
  reminders: "Payment Reminders",
  credit_holds: "Credit Holds",
  pdf_statements: "PDF Statements",
  payer_memory: "Payer Memory",
  audit_export: "Audit Export",
};

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

const PLAN_ORDER: PlanKey[] = ["free", "starter", "growth", "scale"];

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
      console.error("[app.plan] Error loading plan data:", err);
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
          subscriptionId: planData.subscriptionId,
          fromCache: planData.fromCache,
        }
      : null,
    usage: usage ?? {
      companies: { current: 0, limit: 3 },
      importsThisMonth: { current: 0, limit: 1 },
    },
    gatedCount,
    gatingEnforced,
    appHandle: process.env.APP_HANDLE ?? "net-terms-receivables",
    error,
  };
};

function formatLimit(limit: number): string {
  return limit === -1 ? "Unlimited" : String(limit);
}

function UsageBar({
  current,
  limit,
  label,
}: {
  current: number;
  limit: number;
  label: string;
}) {
  const isUnlimited = limit === -1;
  const percentage = isUnlimited ? 0 : Math.min((current / limit) * 100, 100);
  const isAtLimit = !isUnlimited && current >= limit;
  const isNearLimit = !isUnlimited && current >= limit * 0.8;

  return (
    <s-stack>
      <s-paragraph>
        <s-text type="strong">{label}: </s-text>
        <s-text>
          {current} / {formatLimit(limit)}
        </s-text>
        {isAtLimit && <s-badge tone="critical">At Limit</s-badge>}
        {!isAtLimit && isNearLimit && <s-badge tone="warning">Near Limit</s-badge>}
      </s-paragraph>
      {!isUnlimited && (
        <div
          style={{
            height: "8px",
            backgroundColor: "var(--p-color-bg-fill-tertiary)",
            borderRadius: "4px",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${percentage}%`,
              backgroundColor: isAtLimit
                ? "var(--p-color-bg-fill-critical)"
                : isNearLimit
                  ? "var(--p-color-bg-fill-warning)"
                  : "var(--p-color-bg-fill-success)",
              transition: "width 0.3s ease",
            }}
          />
        </div>
      )}
    </s-stack>
  );
}

function FeatureComparisonTable({ currentPlanKey }: { currentPlanKey: PlanKey }) {
  const features: FeatureKey[] = [
    "aging_dashboard",
    "unlimited_imports",
    "matching",
    "reminders",
    "credit_holds",
    "pdf_statements",
    "payer_memory",
    "audit_export",
  ];

  return (
    <s-table>
      <s-table-header-row>
        <s-table-header>Feature</s-table-header>
        {PLAN_ORDER.map((planKey) => (
          <s-table-header key={planKey}>
            {PLAN_DISPLAY_NAMES[planKey]}
            {planKey === currentPlanKey && " ✓"}
          </s-table-header>
        ))}
      </s-table-header-row>
      <s-table-body>
        {features.map((feature) => (
          <s-table-row key={feature}>
            <s-table-cell>
              <s-text type="strong">{FEATURE_DISPLAY_NAMES[feature]}</s-text>
              <br />
              <s-text>{FEATURE_DESCRIPTIONS[feature]}</s-text>
            </s-table-cell>
            {PLAN_ORDER.map((planKey) => {
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
          {PLAN_ORDER.map((planKey) => {
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
          {PLAN_ORDER.map((planKey) => {
            const plan = getPlanConfig(planKey);
            const limit = planLimit(plan, "importsPerMonth");
            return (
              <s-table-cell key={`imports-${planKey}`}>
                <s-text>{formatLimit(limit)}</s-text>
              </s-table-cell>
            );
          })}
        </s-table-row>
        <s-table-row>
          <s-table-cell>
            <s-text type="strong">Price</s-text>
          </s-table-cell>
          {PLAN_ORDER.map((planKey) => (
            <s-table-cell key={`price-${planKey}`}>
              <s-text>TBD</s-text>
            </s-table-cell>
          ))}
        </s-table-row>
      </s-table-body>
    </s-table>
  );
}

export default function PlanPage() {
  const {
    storeHandle,
    plan,
    usage,
    gatedCount,
    gatingEnforced,
    appHandle,
    error,
  } = useLoaderData<typeof loader>();

  const planKey = (plan?.key ?? "free") as PlanKey;
  const planName = plan?.name ?? "Free";
  const isTest = plan?.isTest ?? false;
  const displayPlanName = PLAN_DISPLAY_NAMES[planKey] || planName;

  const upgradeUrl = `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;

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

              {plan?.subscriptionId && (
                <s-paragraph>
                  <s-text>
                    Subscription ID: {plan.subscriptionId}
                  </s-text>
                </s-paragraph>
              )}

              {plan?.fromCache && (
                <s-paragraph>
                  <s-text>
                    Plan data loaded from cache
                  </s-text>
                </s-paragraph>
              )}
            </s-stack>
          </s-section>

          {/* Usage Statistics */}
          <s-section heading="Usage">
            <s-stack>
              <UsageBar
                current={companiesUsed}
                limit={companiesLimit}
                label="Buyer Accounts"
              />
              <UsageBar
                current={importsUsed}
                limit={importsLimit}
                label="Bank Imports This Month"
              />

              {gatingEnforced && gatedCount > 0 && (
                <s-banner tone="warning" heading="Gated Accounts">
                  <s-text>
                    {gatedCount} buyer account{gatedCount !== 1 ? "s are" : " is"} currently
                    gated due to plan limits. Upgrade to reactivate them.
                  </s-text>
                </s-banner>
              )}

              {!gatingEnforced && gatedCount > 0 && (
                <s-paragraph>
                  <s-text>
                    {gatedCount} account{gatedCount !== 1 ? "s" : ""} pending (gating not enforced)
                  </s-text>
                </s-paragraph>
              )}
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
                      enforced. Consider upgrading before enforcement begins.
                    </s-text>
                  </s-banner>
                ) : (
                  <s-paragraph>
                    <s-text>
                      Upgrade to unlock more features and higher limits.
                    </s-text>
                  </s-paragraph>
                )}

                <s-button href={upgradeUrl} target="_top" variant="primary">
                  View Plans & Upgrade
                </s-button>
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
            <s-paragraph>
              <s-text>
                Pricing is not yet finalized. Contact us for current pricing information.
              </s-text>
            </s-paragraph>
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

      <s-section slot="aside" heading="Need Help?">
        <s-paragraph>
          Contact support if you have questions about plans or need assistance
          with your subscription.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
