/**
 * #292: Shop config metafield writer for Rust functions.
 *
 * Provides a shared writer for the $app:shop_config metafield that is used by
 * both after-auth (install) and app._index (currency recovery). The metafield
 * contains shop currency for INR-only validation in Rust functions.
 */

import { SHOP_CONFIG_METAFIELD, serializeShopConfig } from "~/lib/metafields-contract";
import { toErrorCode } from "~/lib/log.server";

/**
 * GraphQL mutation to write shop_config metafield.
 * Defined at module level for static validation.
 */
const WRITE_SHOP_CONFIG_MUTATION = `
  mutation WriteShopConfig($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }
`;

/**
 * Admin GraphQL client interface for type safety.
 * Accepts both the full Response type (from authenticate.admin) and the
 * simpler { json: () => Promise<unknown> } type (from after-auth wrappers).
 */
type AdminGraphqlClient = {
  graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<{ json: () => Promise<unknown> }>;
};

/**
 * Result of a shop config write operation.
 */
export interface WriteShopConfigResult {
  success: boolean;
  metafieldId?: string;
  error?: string;
}

/**
 * #292: Write shop_config metafield with shop currency for Rust functions.
 *
 * Called during:
 * - OAuth (after-auth): Write initial currency on install/reinstall
 * - /app load (currency recovery): Update currency when shop switches to INR
 *
 * @param admin - Admin GraphQL client
 * @param shopId - Shop GID (e.g., "gid://shopify/Shop/12345")
 * @param currencyCode - ISO 4217 currency code (e.g., "INR", "USD")
 * @returns Result indicating success/failure with optional metafield ID
 */
export async function writeShopConfigMetafield(
  admin: AdminGraphqlClient,
  shopId: string,
  currencyCode: string,
): Promise<WriteShopConfigResult> {
  const metafieldValue = serializeShopConfig(currencyCode);

  try {
    const response = await admin.graphql(WRITE_SHOP_CONFIG_MUTATION, {
      variables: {
        metafields: [{
          ownerId: shopId,
          namespace: SHOP_CONFIG_METAFIELD.namespace,
          key: SHOP_CONFIG_METAFIELD.key,
          type: SHOP_CONFIG_METAFIELD.type,
          value: metafieldValue,
        }],
      },
    });

    const result = await response.json() as {
      data?: {
        metafieldsSet?: {
          metafields?: Array<{ id: string }>;
          userErrors?: Array<{ field: string; message: string }>;
        };
      };
      errors?: Array<{ message: string }>;
    };

    if (result.errors?.length) {
      return {
        success: false,
        error: "graphql_errors",
      };
    }

    const userErrors = result.data?.metafieldsSet?.userErrors;
    if (userErrors?.length) {
      return {
        success: false,
        error: "user_errors",
      };
    }

    const metafieldId = result.data?.metafieldsSet?.metafields?.[0]?.id;
    return {
      success: true,
      metafieldId,
    };
  } catch (error) {
    return {
      success: false,
      error: toErrorCode(error),
    };
  }
}
