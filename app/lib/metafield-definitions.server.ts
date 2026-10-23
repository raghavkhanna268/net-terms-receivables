/**
 * Metafield Definitions Service
 *
 * Idempotent creation of app-owned metafield definitions for:
 * - credit_status (JSON): Credit status including hold flag, limit, and exposure
 * - hold (boolean): Simple hold flag for quick lookups by fulfillment-hold path
 *
 * Both definitions are created on COMPANY_LOCATION and CUSTOMER owner types.
 * Uses the $app namespace which is app-owned and resolved at deploy time.
 *
 * @see https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/metafieldDefinitionCreate
 * @see docs/metafields-contract.md
 */

import { METAFIELD } from "./metafields-contract";

/**
 * Minimal type for the admin GraphQL client.
 */
interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<unknown> }>;
}

/**
 * Owner types that need metafield definitions.
 */
const OWNER_TYPES = ["COMPANY_LOCATION", "CUSTOMER"] as const;
type OwnerType = (typeof OWNER_TYPES)[number];

/**
 * Metafield definitions to create.
 */
interface MetafieldDefinitionSpec {
  namespace: string;
  key: string;
  name: string;
  description: string;
  type: string;
}

const CREDIT_STATUS_DEFINITION: MetafieldDefinitionSpec = {
  namespace: METAFIELD.namespace,
  key: METAFIELD.key,
  name: "Credit Status",
  description:
    "Net terms credit status including hold flag, limit, and exposure",
  type: METAFIELD.type,
};

const HOLD_DEFINITION: MetafieldDefinitionSpec = {
  namespace: METAFIELD.namespace,
  key: "hold",
  name: "Hold Status",
  description:
    "Simple boolean flag indicating if the buyer is on hold for fulfillment",
  type: "boolean",
};

/**
 * All metafield definitions that need to be created.
 */
const METAFIELD_DEFINITIONS = [CREDIT_STATUS_DEFINITION, HOLD_DEFINITION];

interface MetafieldDefinitionCreateResult {
  data?: {
    metafieldDefinitionCreate?: {
      createdDefinition?: {
        id: string;
      };
      userErrors?: Array<{
        field?: string[];
        message: string;
        code?: string;
      }>;
    };
  };
  errors?: Array<{ message: string }>;
}

const METAFIELD_DEFINITION_CREATE_MUTATION = `#graphql
  mutation MetafieldDefinitionCreate(
    $namespace: String!,
    $key: String!,
    $name: String!,
    $description: String!,
    $type: String!,
    $ownerType: MetafieldOwnerType!
  ) {
    metafieldDefinitionCreate(definition: {
      namespace: $namespace,
      key: $key,
      name: $name,
      description: $description,
      type: $type,
      ownerType: $ownerType,
      access: { admin: MERCHANT_READ }
    }) {
      createdDefinition {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

/**
 * Result of creating a single metafield definition.
 */
export interface MetafieldDefinitionResult {
  namespace: string;
  key: string;
  ownerType: OwnerType;
  id?: string;
  created: boolean;
  alreadyExists: boolean;
  error?: string;
}

/**
 * Creates a single metafield definition.
 * Treats TAKEN error code as success (idempotent behavior).
 *
 * @param admin - The Shopify Admin API client
 * @param definition - The metafield definition spec
 * @param ownerType - The owner type for this definition
 * @returns Result indicating success, already-exists, or error
 */
async function createMetafieldDefinition(
  admin: AdminGraphqlClient,
  definition: MetafieldDefinitionSpec,
  ownerType: OwnerType,
): Promise<MetafieldDefinitionResult> {
  const result: MetafieldDefinitionResult = {
    namespace: definition.namespace,
    key: definition.key,
    ownerType,
    created: false,
    alreadyExists: false,
  };

  try {
    const response = await admin.graphql(METAFIELD_DEFINITION_CREATE_MUTATION, {
      variables: {
        namespace: definition.namespace,
        key: definition.key,
        name: definition.name,
        description: definition.description,
        type: definition.type,
        ownerType,
      },
    });

    const data = (await response.json()) as MetafieldDefinitionCreateResult;

    if (data.errors?.length) {
      result.error = `GraphQL errors: ${data.errors.map((e) => e.message).join(", ")}`;
      return result;
    }

    const mutation = data.data?.metafieldDefinitionCreate;
    const userErrors = mutation?.userErrors;

    if (userErrors?.length) {
      const takenError = userErrors.find((e) => e.code === "TAKEN");
      if (takenError) {
        result.alreadyExists = true;
        return result;
      }

      result.error = `userErrors: ${userErrors.map((e) => `[${e.code ?? "UNKNOWN"}] ${e.message}`).join("; ")}`;
      return result;
    }

    if (mutation?.createdDefinition?.id) {
      result.id = mutation.createdDefinition.id;
      result.created = true;
    }

    return result;
  } catch (error) {
    result.error = `Exception: ${error instanceof Error ? error.message : String(error)}`;
    return result;
  }
}

/**
 * Ensures all metafield definitions exist for the shop.
 * Creates definitions for credit_status and hold on both COMPANY_LOCATION and CUSTOMER.
 * This operation is idempotent - TAKEN errors are treated as success.
 *
 * @param admin - The Shopify Admin API client
 * @returns Array of results for each definition
 * @throws Error if any definition fails to create (excluding TAKEN)
 */
export async function ensureMetafieldDefinitions(
  admin: AdminGraphqlClient,
): Promise<MetafieldDefinitionResult[]> {
  const results: MetafieldDefinitionResult[] = [];
  const errors: string[] = [];

  for (const definition of METAFIELD_DEFINITIONS) {
    for (const ownerType of OWNER_TYPES) {
      const result = await createMetafieldDefinition(
        admin,
        definition,
        ownerType,
      );
      results.push(result);

      if (result.error) {
        console.error(
          `[metafieldDefinitions] Failed to create ${definition.namespace}:${definition.key} for ${ownerType}: ${result.error}`,
        );
        errors.push(
          `${definition.namespace}:${definition.key}@${ownerType}: ${result.error}`,
        );
      } else if (result.created) {
        console.log(
          `[metafieldDefinitions] Created ${definition.namespace}:${definition.key} for ${ownerType} (id: ${result.id})`,
        );
      } else if (result.alreadyExists) {
        console.log(
          `[metafieldDefinitions] ${definition.namespace}:${definition.key} for ${ownerType} already exists`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Failed to create metafield definitions: ${errors.join("; ")}`,
    );
  }

  return results;
}

/**
 * Get the list of metafield definitions that would be created.
 * Useful for documentation and testing.
 */
export function getMetafieldDefinitionSpecs(): Array<{
  definition: MetafieldDefinitionSpec;
  ownerTypes: readonly OwnerType[];
}> {
  return METAFIELD_DEFINITIONS.map((definition) => ({
    definition,
    ownerTypes: OWNER_TYPES,
  }));
}
