/**
 * Tag rules management route (S23-03).
 *
 * Provides a UI for merchants on tag-based stores to create tag rules.
 * Tag rules map customer tags to default payment terms for non-B2B wholesale.
 *
 * Mode detection (server-side, checked in both loader and action):
 * - B2B stores: Have any BuyerAccount with kind=COMPANY
 * - Tag-based stores: No COMPANY accounts
 *
 * The create form is shown only for tag-based stores.
 * B2B Company stores see a not-applicable state.
 * The action rejects POSTs from B2B stores with a 400.
 *
 * Validation constraints:
 * - Tag: trimmed, max 255 chars, no commas or control characters
 * - Case-insensitive duplicate check per shop
 * - Default terms days: positive integer, 1-365
 */

import { useState } from "react";
import type {
  HeadersFunction,
  LoaderFunctionArgs,
  ActionFunctionArgs,
} from "react-router";
import { useLoaderData, useActionData, Form, useNavigation, data } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getRequestSql } from "~/lib/request-context.server";
import { safeLog, toErrorCode, shopHash } from "~/lib/log.server";
import { getStoreSetupStatus, type StoreSetupStatus } from "~/lib/store-setup-state";
import { CURRENCY_NOT_SUPPORTED_BANNER_COPY } from "~/lib/shop-currency-copy";
import { StoreSettingUpBanner } from "~/components/StoreSetupState";
import { getUsageStats, isGatingEnforced } from "~/services/gating.server";
import { buildNewAccountsPausedBannerState, type NewAccountsPausedBannerState } from "~/lib/over-limit-banner";
import { getAppHandle, buildPlanSelectionUrl } from "~/lib/plan-url";
import { enqueueReconcileStage } from "~/services/drain/reconcile-handlers.server";

/**
 * Check if a character is forbidden in Shopify tags.
 * Forbidden: commas, control characters (0x00-0x1f, 0x7f), and line/paragraph separators (U+2028/U+2029).
 */
function isForbiddenTagChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    char === "," ||
    (code >= 0x00 && code <= 0x1f) ||
    code === 0x7f ||
    code === 0x2028 ||
    code === 0x2029
  );
}

const TAG_MAX_LENGTH = 255;
const TERMS_DAYS_MIN = 1;
const TERMS_DAYS_MAX = 365;

/**
 * Store mode determines which UI to show.
 */
type StoreMode = "b2b" | "tag_based";

interface TagRule {
  id: string;
  tag: string;
  defaultTermsDays: number;
  createdAt: string;
}

interface LoaderData {
  storeMode: StoreMode;
  tagRules: TagRule[];
  shopId: string | null;
  error: string | null;
  finishingSetup: boolean;
  notSupported: boolean;
  storeSetupStatus: StoreSetupStatus;
  newAccountsPausedBanner: NewAccountsPausedBannerState;
}

interface ActionData {
  success: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  createdRuleId?: string;
}

/**
 * Detect store mode based on existing buyer accounts.
 * B2B: Has any BuyerAccount with kind=COMPANY
 * Tag-based: All other stores
 */
async function detectStoreMode(
  sql: ReturnType<typeof getRequestSql>,
  shopId: string
): Promise<StoreMode> {
  const [companyAccount] = await sql<{ id: string }[]>`
    SELECT id FROM "BuyerAccount"
    WHERE "shopId" = ${shopId} AND kind = 'COMPANY'
    LIMIT 1
  `;

  return companyAccount ? "b2b" : "tag_based";
}

/**
 * Fetch existing tag rules for a shop.
 */
async function getTagRules(
  sql: ReturnType<typeof getRequestSql>,
  shopId: string
): Promise<TagRule[]> {
  const rules = await sql<{
    id: string;
    tag: string;
    defaultTermsDays: number;
    createdAt: Date;
  }[]>`
    SELECT id, tag, "defaultTermsDays", "createdAt"
    FROM "AccountSource"
    WHERE "shopId" = ${shopId}
    ORDER BY "createdAt" DESC
  `;

  return rules.map((r) => ({
    id: r.id,
    tag: r.tag,
    defaultTermsDays: r.defaultTermsDays,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Validate tag format per Shopify rules.
 * Returns error message or null if valid.
 */
export function validateTag(tag: string): string | null {
  const trimmed = tag.trim();

  if (trimmed.length === 0) {
    return "Tag is required";
  }

  if (trimmed.length > TAG_MAX_LENGTH) {
    return `Tag must be at most ${TAG_MAX_LENGTH} characters`;
  }

  for (const char of trimmed) {
    if (isForbiddenTagChar(char)) {
      return "Tag cannot contain commas or control characters";
    }
  }

  return null;
}

/**
 * Validate default terms days.
 */
export function validateTermsDays(value: string): string | null {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return "Default terms days is required";
  }

  const parsed = parseInt(trimmed, 10);

  if (isNaN(parsed) || trimmed !== String(parsed)) {
    return "Default terms days must be a whole number";
  }

  if (parsed < TERMS_DAYS_MIN) {
    return `Default terms days must be at least ${TERMS_DAYS_MIN}`;
  }

  if (parsed > TERMS_DAYS_MAX) {
    return `Default terms days must be at most ${TERMS_DAYS_MAX}`;
  }

  return null;
}

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { shopify } = context;
  const { session } = await shopify.authenticate.admin(request);
  const sql = getRequestSql();
  const shopDomain = session.shop;

  const [shop] = await sql<{ id: string; currency: string | null }[]>`
    SELECT id, currency FROM "Shop" WHERE domain = ${shopDomain}
  `;

  const storeSetupStatus = getStoreSetupStatus(shop);

  if (storeSetupStatus !== "supported") {
    return {
      storeMode: "tag_based" as StoreMode,
      tagRules: [],
      shopId: shop?.id ?? null,
      error: null,
      finishingSetup: storeSetupStatus === "setting_up",
      notSupported: storeSetupStatus === "not_supported",
      storeSetupStatus,
      newAccountsPausedBanner: {
        show: false,
        heading: "",
        bodyText: "",
        upgradeUrl: null,
      },
    } satisfies LoaderData;
  }

  try {
    const [storeMode, tagRules] = await Promise.all([
      detectStoreMode(sql, shop.id),
      getTagRules(sql, shop.id),
    ]);

    const gatingEnforced = isGatingEnforced();
    const upgradeUrl = (() => {
      const handle = getAppHandle();
      if (handle === null) return null;
      return buildPlanSelectionUrl(shopDomain, handle);
    })();

    // Only call getUsageStats when gating is enforced (fail-soft on error)
    let newAccountsPausedBanner: NewAccountsPausedBannerState = {
      show: false,
      heading: "",
      bodyText: "",
      upgradeUrl: null,
    };

    if (gatingEnforced) {
      try {
        const usage = await getUsageStats(sql, shop.id);
        newAccountsPausedBanner = buildNewAccountsPausedBannerState(
          usage.companies.current,
          usage.companies.limit,
          gatingEnforced,
          upgradeUrl
        );
      } catch (err) {
        safeLog("warn", "usage_stats_error", { shopId: shop.id, err: toErrorCode(err) });
        // Fail soft: no banner on error
      }
    }

    return {
      storeMode,
      tagRules,
      shopId: shop.id,
      error: null,
      finishingSetup: false,
      notSupported: false,
      storeSetupStatus: "supported" as const,
      newAccountsPausedBanner,
    } satisfies LoaderData;
  } catch (err) {
    safeLog("error", "tag_rules_load_error", {
      shopId: shop.id,
      err: toErrorCode(err),
    });

    return {
      storeMode: "tag_based" as StoreMode,
      tagRules: [],
      shopId: shop.id,
      error: "Failed to load tag rules",
      finishingSetup: false,
      notSupported: false,
      storeSetupStatus: "supported" as const,
      newAccountsPausedBanner: {
        show: false,
        heading: "",
        bodyText: "",
        upgradeUrl: null,
      },
    } satisfies LoaderData;
  }
};

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shopify } = context;
  const { session } = await shopify.authenticate.admin(request);
  const sql = getRequestSql();
  const shopDomain = session.shop;

  const [shop] = await sql<{ id: string; domain: string; currency: string | null }[]>`
    SELECT id, domain, currency FROM "Shop" WHERE domain = ${shopDomain}
  `;

  const storeSetupStatus = getStoreSetupStatus(shop);

  if (storeSetupStatus === "setting_up") {
    return data(
      {
        success: false,
        error: "Your store is still being set up. Please wait a moment and try again.",
      } satisfies ActionData,
      { status: 400 }
    );
  }

  if (storeSetupStatus === "not_supported") {
    return data(
      {
        success: false,
        error: "Only INR currency is supported",
      } satisfies ActionData,
      { status: 400 }
    );
  }

  const storeMode = await detectStoreMode(sql, shop!.id);
  if (storeMode === "b2b") {
    return data(
      {
        success: false,
        error: "Tag rules are not available for B2B stores",
      } satisfies ActionData,
      { status: 400 }
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return data(
      {
        success: false,
        error: "Invalid request body",
      } satisfies ActionData,
      { status: 400 }
    );
  }

  const intent = formData.get("intent");

  if (intent !== "create_tag_rule") {
    return data(
      { success: false, error: "Unknown action" } satisfies ActionData,
      { status: 400 }
    );
  }

  const tagRaw = formData.get("tag");
  const termsDaysRaw = formData.get("defaultTermsDays");

  const fieldErrors: Record<string, string> = {};

  if (tagRaw === null || typeof tagRaw !== "string") {
    fieldErrors.tag = "Tag is required";
  }

  if (termsDaysRaw === null || typeof termsDaysRaw !== "string") {
    fieldErrors.defaultTermsDays = "Default terms days is required";
  }

  if (Object.keys(fieldErrors).length > 0) {
    return data(
      { success: false, fieldErrors } satisfies ActionData,
      { status: 400 }
    );
  }

  const tag = (tagRaw as string).trim();
  const termsDays = (termsDaysRaw as string).trim();

  const tagError = validateTag(tag);
  if (tagError) {
    fieldErrors.tag = tagError;
  }

  const termsDaysError = validateTermsDays(termsDays);
  if (termsDaysError) {
    fieldErrors.defaultTermsDays = termsDaysError;
  }

  if (Object.keys(fieldErrors).length > 0) {
    return data(
      { success: false, fieldErrors } satisfies ActionData,
      { status: 400 }
    );
  }

  try {
    const parsedTermsDays = parseInt(termsDays, 10);

    // Pre-check for case-insensitive duplicate (no matching unique index for LOWER)
    const [existingRule] = await sql<{ id: string }[]>`
      SELECT id FROM "AccountSource"
      WHERE "shopId" = ${shop.id} AND LOWER(tag) = LOWER(${tag})
      LIMIT 1
    `;

    if (existingRule) {
      return data(
        {
          success: false,
          fieldErrors: {
            tag: "A tag rule with this tag already exists (case-insensitive match)",
          },
        } satisfies ActionData,
        { status: 400 }
      );
    }

    // Insert with ON CONFLICT on existing unique index ("shopId", tag)
    const result = await sql<{ id: string }[]>`
      INSERT INTO "AccountSource" ("shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")
      VALUES (${shop.id}, ${tag}, ${parsedTermsDays}, NOW(), NOW())
      ON CONFLICT ("shopId", tag) DO NOTHING
      RETURNING id
    `;

    if (result.length === 0) {
      // Exact-case duplicate detected via ON CONFLICT
      return data(
        {
          success: false,
          fieldErrors: {
            tag: "A tag rule with this tag already exists",
          },
        } satisfies ActionData,
        { status: 400 }
      );
    }

    safeLog("info", "tag_rule_created", {
      shopId: shop.id,
      ruleId: result[0].id,
      termsDays: parsedTermsDays,
    });

    const [alreadyQueued] = await sql<{ msg_id: string }[]>`
      SELECT msg_id::text FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${shop.domain}
        AND message->>'topic' = 'RECONCILE_CUSTOMERS'
      LIMIT 1
    `;
    if (!alreadyQueued) {
      const manualKey = `manual:${Date.now()}`;
      await enqueueReconcileStage(sql, shop.domain, "customers", manualKey);
      safeLog("info", "first_tag_rule_customers_enqueued", {
        shopHash: await shopHash(shop.domain),
      });
    }

    return {
      success: true,
      createdRuleId: result[0].id,
    } satisfies ActionData;
  } catch (err) {
    const errCode = toErrorCode(err);

    // Catch 23505 unique violation (race condition fallback)
    if (
      errCode === "pg_unique_violation" ||
      (err instanceof Error && err.message.includes("23505"))
    ) {
      return data(
        {
          success: false,
          fieldErrors: {
            tag: "A tag rule with this tag already exists",
          },
        } satisfies ActionData,
        { status: 400 }
      );
    }

    safeLog("error", "tag_rule_create_error", {
      shopId: shop.id,
      err: errCode,
    });

    return data(
      {
        success: false,
        error: "Failed to create tag rule",
      } satisfies ActionData,
      { status: 500 }
    );
  }
};

function TagRuleTable({ rules }: { rules: TagRule[] }) {
  if (rules.length === 0) {
    return (
      <s-empty-state heading="No tag rules configured">
        <s-text slot="subheading">
          Create a tag rule to enable net terms for customers with specific
          tags.
        </s-text>
      </s-empty-state>
    );
  }

  return (
    <s-table>
      <s-table-header-row>
        <s-table-header listSlot="primary">Customer Tag</s-table-header>
        <s-table-header listSlot="labeled">Default Terms</s-table-header>
        <s-table-header listSlot="labeled">Created</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {rules.map((rule) => (
          <s-table-row key={rule.id}>
            <s-table-cell>
              <s-badge>{rule.tag}</s-badge>
            </s-table-cell>
            <s-table-cell>Net {rule.defaultTermsDays} days</s-table-cell>
            <s-table-cell>
              {new Date(rule.createdAt).toLocaleDateString("en-IN", {
                timeZone: "Asia/Kolkata",
              })}
            </s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}

export default function TagRulesPage() {
  const { storeMode, tagRules, error, finishingSetup, notSupported, newAccountsPausedBanner } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [tag, setTag] = useState("");
  const [termsDays, setTermsDays] = useState("");

  if (finishingSetup) {
    return (
      <s-page heading="Tag Rules">
        <s-link href="/app" slot="breadcrumb-actions">
          Back to Dashboard
        </s-link>

        <s-section>
          <StoreSettingUpBanner />
        </s-section>
      </s-page>
    );
  }

  if (notSupported) {
    return (
      <s-page heading="Tag Rules">
        <s-link href="/" slot="breadcrumb-actions">
          Back to Dashboard
        </s-link>

        <s-section>
          <s-banner tone="critical" heading="Currency Not Supported">
            {CURRENCY_NOT_SUPPORTED_BANNER_COPY}
          </s-banner>
        </s-section>
      </s-page>
    );
  }

  if (storeMode === "b2b") {
    return (
      <s-page heading="Tag Rules">
        <s-link href="/app" slot="breadcrumb-actions">
          Back to Dashboard
        </s-link>

        <s-section>
          <s-banner tone="info" heading="Not applicable for B2B stores">
            <s-text>
              Tag rules are for stores that identify net-terms buyers using
              customer tags instead of Shopify B2B Companies. Your store uses
              B2B Companies for buyer accounts.
            </s-text>
          </s-banner>
        </s-section>

        <s-section slot="aside" heading="About Tag Rules">
          <s-paragraph>
            Tag rules are an alternative to B2B Companies for identifying
            wholesale buyers. They are useful when:
          </s-paragraph>
          <s-unordered-list>
            <s-list-item>Your buyers are not set up as B2B Companies</s-list-item>
            <s-list-item>You tag customers manually with wholesale tiers</s-list-item>
            <s-list-item>You use tags like &quot;net30&quot; or &quot;wholesale-gold&quot;</s-list-item>
          </s-unordered-list>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Tag Rules">
      <s-link href="/app" slot="breadcrumb-actions">
        Back to Dashboard
      </s-link>

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

      {error && (
        <s-section>
          <s-banner tone="critical" heading="Error">
            {error}
          </s-banner>
        </s-section>
      )}

      {actionData?.success && (
        <s-section>
          <s-banner tone="success" heading="Tag rule saved">
            Matching customers are picked up on the next sync.
          </s-banner>
        </s-section>
      )}

      {actionData && !actionData.success && "error" in actionData && actionData.error && (
        <s-section>
          <s-banner tone="critical" heading="Error">
            {actionData.error}
          </s-banner>
        </s-section>
      )}

      <s-section heading="Create Tag Rule">
        <Form method="post">
          <input type="hidden" name="intent" value="create_tag_rule" />
          <s-stack gap="base">
            <s-text-field
              label="Customer Tag"
              name="tag"
              placeholder="e.g., net30, wholesale-gold"
              value={tag}
              error={actionData && "fieldErrors" in actionData ? (actionData.fieldErrors as Record<string, string> | undefined)?.tag : undefined}
              onChange={(e: Event) => {
                const target = e.currentTarget as HTMLInputElement | null;
                setTag(target?.value ?? "");
              }}
            ></s-text-field>
            <s-paragraph>
              Enter the exact customer tag that identifies net-terms buyers.
              Tags are matched case-insensitively.
            </s-paragraph>

            <s-text-field
              label="Default Terms (Days)"
              name="defaultTermsDays"
              placeholder="e.g., 30"
              value={termsDays}
              error={actionData && "fieldErrors" in actionData ? (actionData.fieldErrors as Record<string, string> | undefined)?.defaultTermsDays : undefined}
              onChange={(e: Event) => {
                const target = e.currentTarget as HTMLInputElement | null;
                setTermsDays(target?.value ?? "");
              }}
            ></s-text-field>
            <s-paragraph>
              The default payment terms for customers with this tag (1-365
              days).
            </s-paragraph>

            <s-button type="submit" variant="primary" disabled={isSubmitting}>
              {isSubmitting ? "Creating..." : "Create Tag Rule"}
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Existing Tag Rules">
        <TagRuleTable rules={tagRules} />
      </s-section>

      <s-section slot="aside" heading="About Tag Rules">
        <s-paragraph>
          Tag rules allow you to offer net terms to customers based on their
          tags, without needing Shopify B2B Companies.
        </s-paragraph>
        <s-unordered-list>
          <s-list-item>
            <s-text type="strong">Customer Tag</s-text>: The tag that identifies
            a buyer (e.g., &quot;net30&quot;, &quot;wholesale&quot;)
          </s-list-item>
          <s-list-item>
            <s-text type="strong">Default Terms</s-text>: Payment due date in
            days from order date
          </s-list-item>
        </s-unordered-list>
        <s-paragraph>
          When an order is placed by a customer with a matching tag, they become
          eligible for net terms.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
