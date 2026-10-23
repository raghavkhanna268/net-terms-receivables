import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getRequestSql } from "~/lib/request-context.server";
import { resolvePlan, type ResolvedPlan } from "~/services/plan.server";
import { getUsageStats } from "~/services/gating.server";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  // Session storage is injected per-request via loadContext in workers/app.ts
  const { shopify } = context;

  const { session } = await shopify.authenticate.admin(request);
  const sql = getRequestSql();
  const shopDomain = session.shop;

  // Get shop ID for usage stats
  const [shop] = await sql<{ id: string }[]>`
    SELECT id FROM "Shop" WHERE domain = ${shopDomain}
  `;

  // Load plan and usage data
  let planData: ResolvedPlan | null = null;
  let usage: { companies: { current: number; limit: number }; importsThisMonth: { current: number; limit: number } } | null = null;

  if (shop) {
    try {
      planData = await resolvePlan(sql, shopDomain);
      usage = await getUsageStats(sql, shop.id);
    } catch (error) {
      console.error("[app._index] Error loading plan/usage:", error);
    }
  }

  // Extract store handle for upgrade URL
  const storeHandle = shopDomain.replace(".myshopify.com", "");

  return {
    shopName: storeHandle,
    shopDomain,
    storeHandle,
    plan: planData ? {
      key: planData.plan.key,
      name: planData.subscriptionName ?? planData.plan.key,
      isTest: planData.isTest,
    } : null,
    usage: usage ?? {
      companies: { current: 0, limit: 3 },
      importsThisMonth: { current: 0, limit: 1 },
    },
    appHandle: process.env.APP_HANDLE ?? "net-terms-receivables",
  };
};

/**
 * Format limit for display. Returns "Unlimited" for -1.
 */
function formatLimit(limit: number): string {
  return limit === -1 ? "Unlimited" : String(limit);
}

export default function Index() {
  const { shopName, shopDomain, storeHandle, plan, usage, appHandle } = useLoaderData<typeof loader>();

  const planKey = plan?.key ?? "free";
  const planName = plan?.name ?? "Free";
  const isTest = plan?.isTest ?? false;

  // Build upgrade URL for managed pricing page
  const upgradeUrl = `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;

  // Calculate usage percentages for display
  const companiesUsed = usage.companies.current;
  const companiesLimit = usage.companies.limit;
  const companiesText = companiesLimit === -1
    ? `${companiesUsed} companies`
    : `${companiesUsed} / ${formatLimit(companiesLimit)} companies`;
  const companiesAtLimit = companiesLimit !== -1 && companiesUsed >= companiesLimit;

  // Capitalize plan name for display
  const displayPlanName = planName.charAt(0).toUpperCase() + planName.slice(1);

  return (
    <s-page heading="Net Terms Receivables">
      {/* S21: Plan Banner */}
      <s-section heading="Your Plan">
        <s-stack>
          <s-paragraph>
            <s-text type="strong">Current Plan: </s-text>
            <s-text>{displayPlanName}{isTest ? " (Test)" : ""}</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">Companies: </s-text>
            <s-text>{companiesText}</s-text>
            {companiesAtLimit && (
              <s-text> — Limit reached, upgrade to add more</s-text>
            )}
          </s-paragraph>
          {planKey !== "scale" && (
            <s-button href={upgradeUrl} target="_top">
              Upgrade Plan
            </s-button>
          )}
        </s-stack>
      </s-section>

      <s-section heading={`Welcome, ${shopName}!`}>
        <s-paragraph>
          Your app is successfully installed on <s-text type="strong">{shopDomain}</s-text>.
        </s-paragraph>
        <s-paragraph>
          This B2B wholesale net-terms receivables app will help you:
        </s-paragraph>
        <s-unordered-list>
          <s-list-item>Track unpaid invoices per wholesale buyer</s-list-item>
          <s-list-item>Manage credit limits and automatic credit holds</s-list-item>
          <s-list-item>Send payment reminders</s-list-item>
          <s-list-item>Match Indian bank transfer payments (NEFT/RTGS/IMPS/UPI) to orders</s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section slot="aside" heading="Getting Started">
        <s-paragraph>
          Next steps after S2:
        </s-paragraph>
        <s-unordered-list>
          <s-list-item>Build buyer management UI</s-list-item>
          <s-list-item>Implement credit limit tracking</s-list-item>
          <s-list-item>Add invoice generation</s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section slot="aside" heading="Tech Stack">
        <s-paragraph>
          <s-text>Runtime: </s-text>
          <s-link href="https://workers.cloudflare.com" target="_blank">
            Cloudflare Workers
          </s-link>
        </s-paragraph>
        <s-paragraph>
          <s-text>Framework: </s-text>
          <s-link href="https://reactrouter.com" target="_blank">
            React Router v7
          </s-link>
        </s-paragraph>
        <s-paragraph>
          <s-text>Database: </s-text>
          <s-link href="https://supabase.com" target="_blank">
            Supabase Postgres
          </s-link>
          <s-text> via </s-text>
          <s-link href="https://developers.cloudflare.com/hyperdrive" target="_blank">
            Hyperdrive
          </s-link>
        </s-paragraph>
        <s-paragraph>
          <s-text>UI: </s-text>
          <s-link
            href="https://shopify.dev/docs/api/app-home/using-polaris-components"
            target="_blank"
          >
            Polaris Web Components
          </s-link>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
