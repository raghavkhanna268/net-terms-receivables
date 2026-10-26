import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getRequestSql } from "~/lib/request-context.server";
import { verifyWebhook, normalizeWebhookTopic } from "~/lib/webhook-verify.server";
import { shopifyGraphQLQueue, type ShopifyClientResult } from "~/services/shopify-client.server";
import { writeShopConfigMetafield } from "~/services/shop-config.server";
import { validateCurrencyCode, NO_CURRENCY_SENTINEL, SUPPORTED_SHOP_CURRENCY } from "~/lib/shop-currency.server";
import { safeLog, shopHash } from "~/lib/log.server";
import { decideShopCurrencyUpdate, hasFinancialRows } from "~/lib/shop-currency-guard.server";
import type { Sql } from "~/lib/db-light.server";

/**
 * #342: Webhook handler for SHOP_UPDATE events.
 *
 * When a shop's currency changes (INR to non-INR or back), this webhook:
 * 1. Re-reads the live currencyCode from the Admin API (don't trust payload alone)
 * 2. Checks currency flip guard (#364): blocks flip to INR when shop has
 *    financial rows (Invoice, Payment, s8_draft_orders) via decideShopCurrencyUpdate
 * 3. Writes the $app:shop_config metafield FIRST (fail-closed)
 * 4. Updates Shop.currency only if metafield write succeeds
 *
 * Idempotency:
 * - Duplicate deliveries: If nothing changed, no writes occur
 * - Out-of-order deliveries: Re-read from Admin API ensures latest state
 * - Failed writes: Left for /app-load recovery (still the backstop)
 *
 * Fail-closed:
 * - Never write XXX (unknown) currency
 * - Block flip to INR when shop has financial rows (guard, #364)
 * - If shop_config write fails, don't update Shop.currency
 * - If Admin API read fails, do nothing
 *
 * Handles:
 * - Uninstalled shops: shopifyGraphQLQueue returns no_session, graceful exit
 * - Missing sessions: Same as above
 *
 * Uses shopifyGraphQLQueue for Admin API calls with offline tokens.
 * Returns 200 immediately; processing via waitUntil.
 */

const ALLOWED_TOPICS = new Set(["SHOP_UPDATE"]);

const SHOP_CURRENCY_QUERY = `
  query ShopCurrencyForUpdate {
    shop {
      id
      currencyCode
    }
  }
`;

interface ShopCurrencyData {
  shop?: {
    id?: string;
    currencyCode?: string;
  };
}

interface ProcessResult {
  status: "success" | "no_change" | "skipped" | "error";
  reason?: string;
}

async function processShopUpdate(
  sql: Sql,
  shop: string,
): Promise<ProcessResult> {
  const hash = await shopHash(shop);

  const [shopRow] = await sql<{ id: string; currency: string }[]>`
    SELECT id, currency FROM "Shop" WHERE domain = ${shop}
  `;

  if (!shopRow) {
    safeLog("info", "shop_update_webhook_shop_not_found", { shopHash: hash });
    return { status: "skipped", reason: "shop_not_found" };
  }

  const dbCurrency = shopRow.currency;

  const result: ShopifyClientResult<ShopCurrencyData> = await shopifyGraphQLQueue(
    shop,
    SHOP_CURRENCY_QUERY,
  );

  if (!result.success) {
    if (result.errorCode === "no_session" || result.errorCode === "invalid_session") {
      safeLog("info", "shop_update_webhook_no_session", { shopHash: hash });
      return { status: "skipped", reason: "no_session" };
    }
    safeLog("warn", "shop_update_webhook_api_failed", {
      shopHash: hash,
      err: result.errorCode ?? "unknown",
    });
    return { status: "error", reason: result.errorCode ?? "api_error" };
  }

  const shopId = result.data?.shop?.id;
  const liveCurrency = validateCurrencyCode(result.data?.shop?.currencyCode);

  if (!shopId || !liveCurrency) {
    safeLog("warn", "shop_update_webhook_invalid_response", { shopHash: hash });
    return { status: "error", reason: "invalid_response" };
  }

  if (liveCurrency === NO_CURRENCY_SENTINEL) {
    safeLog("info", "shop_update_webhook_xxx_currency", { shopHash: hash });
    return { status: "skipped", reason: "xxx_currency" };
  }

  if (liveCurrency === dbCurrency) {
    return { status: "no_change" };
  }

  if (liveCurrency === SUPPORTED_SHOP_CURRENCY && dbCurrency !== SUPPORTED_SHOP_CURRENCY) {
    const hasRows = await hasFinancialRows(sql, shopRow.id);
    const guardDecision = decideShopCurrencyUpdate({
      storedCurrency: dbCurrency,
      liveCurrency,
      hasFinancialRows: hasRows,
    });
    if (guardDecision.blocked) {
      safeLog("info", "shop_update_webhook_flip_blocked", { shopHash: hash });
      return { status: "skipped", reason: "flip_blocked" };
    }
  }

  const adminClient = {
    graphql: async (query: string, opts?: { variables?: Record<string, unknown> }) => {
      const r = await shopifyGraphQLQueue<unknown>(shop, query, opts?.variables);
      return {
        json: async () => {
          if (!r.success) {
            return { errors: [{ message: r.error ?? "Unknown error" }] };
          }
          return { data: r.data };
        },
      };
    },
  };

  const writeResult = await writeShopConfigMetafield(adminClient, shopId, liveCurrency);

  if (!writeResult.success) {
    safeLog("warn", "shop_update_webhook_metafield_failed", {
      shopHash: hash,
      err: writeResult.error ?? "unknown",
    });
    return { status: "error", reason: "metafield_write_failed" };
  }

  await sql`
    UPDATE "Shop" SET currency = ${liveCurrency}, "updatedAt" = NOW()
    WHERE domain = ${shop}
  `;

  if (liveCurrency === "INR" && dbCurrency !== "INR") {
    safeLog("info", "shop_update_webhook_currency_to_inr", { shopHash: hash });
  } else if (liveCurrency !== "INR" && dbCurrency === "INR") {
    safeLog("info", "shop_update_webhook_currency_from_inr", { shopHash: hash });
  } else {
    safeLog("info", "shop_update_webhook_currency_changed", { shopHash: hash });
  }

  return { status: "success" };
}

export const loader = async (_args: LoaderFunctionArgs) => {
  return new Response(null, { status: 405, statusText: "Method Not Allowed" });
};

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (!apiSecret) {
    console.error("[webhooks.shop.update] SHOPIFY_API_SECRET not configured");
    return new Response(null, { status: 500 });
  }

  const { shop, topic } = await verifyWebhook(request, apiSecret);
  const normalizedTopic = normalizeWebhookTopic(topic);

  if (!ALLOWED_TOPICS.has(normalizedTopic)) {
    console.warn(
      `[webhooks.shop.update] Unexpected topic ${normalizedTopic}, ignoring`
    );
    return new Response(null, { status: 200 });
  }

  const sql = getRequestSql();

  const cloudflare = context.cloudflare as {
    ctx: { waitUntil: (promise: Promise<unknown>) => void };
  };

  const processPromise = (async () => {
    try {
      await processShopUpdate(sql, shop);
    } catch (error) {
      const hash = await shopHash(shop);
      const errInfo = (error as { code?: string; name?: string }).code ?? (error as Error).name ?? "unknown";
      safeLog("error", "shop_update_webhook_exception", {
        shopHash: hash,
        err: errInfo,
      });
    }
  })();

  cloudflare.ctx.waitUntil(processPromise);

  return new Response(null, { status: 200 });
};
