/**
 * Validation Registration Service
 *
 * Idempotent registration of the credit-check-validation Shopify Function.
 * Uses validationCreate mutation with functionHandle (per 2026-10 docs).
 * write_validations scope is already granted.
 *
 * @see https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/validationCreate
 */

/**
 * Minimal type for the admin GraphQL client.
 * The actual type comes from @shopify/shopify-app-remix but this interface
 * captures only what we need for testing and API compatibility.
 */
interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<unknown> }>;
}

const VALIDATION_FUNCTION_HANDLE = "credit-check-validation";
const VALIDATION_TITLE = "Net Terms Credit Check";

interface ValidationNode {
  id: string;
  functionHandle: string;
  title: string;
  enabled: boolean;
}

interface ValidationsQueryResult {
  data?: {
    validations?: {
      edges: Array<{
        node: ValidationNode;
      }>;
    };
  };
  errors?: Array<{ message: string }>;
}

interface ValidationCreateResult {
  data?: {
    validationCreate?: {
      validation?: {
        id: string;
        functionHandle: string;
        title: string;
        enabled: boolean;
      };
      userErrors?: Array<{
        field?: string[];
        message: string;
      }>;
    };
  };
  errors?: Array<{ message: string }>;
}

const VALIDATIONS_QUERY = `#graphql
  query GetValidations {
    validations(first: 50) {
      edges {
        node {
          id
          functionHandle
          title
          enabled
        }
      }
    }
  }
`;

const VALIDATION_CREATE_MUTATION = `#graphql
  mutation ValidationCreate($functionHandle: String!, $title: String!) {
    validationCreate(validation: {
      functionHandle: $functionHandle,
      title: $title,
      blockOnFailure: false,
      enable: true
    }) {
      validation {
        id
        functionHandle
        title
        enabled
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Ensures the credit check validation function is registered for the shop.
 * This is idempotent - if the validation already exists (matched by handle), it returns the existing one.
 *
 * @param admin - The Shopify Admin API context
 * @returns The validation ID (existing or newly created)
 * @throws Error if registration fails
 */
export async function ensureValidation(
  admin: AdminGraphqlClient,
): Promise<{ id: string; created: boolean }> {
  const existingResult = await admin.graphql(VALIDATIONS_QUERY);
  const existingData = (await existingResult.json()) as ValidationsQueryResult;

  if (existingData.errors?.length) {
    throw new Error(
      `Failed to query validations: ${existingData.errors.map((e) => e.message).join(", ")}`,
    );
  }

  const existingValidation = existingData.data?.validations?.edges.find(
    (edge) => edge.node.functionHandle === VALIDATION_FUNCTION_HANDLE,
  );

  if (existingValidation) {
    return { id: existingValidation.node.id, created: false };
  }

  const createResult = await admin.graphql(VALIDATION_CREATE_MUTATION, {
    variables: {
      functionHandle: VALIDATION_FUNCTION_HANDLE,
      title: VALIDATION_TITLE,
    },
  });

  const createData = (await createResult.json()) as ValidationCreateResult;

  if (createData.errors?.length) {
    throw new Error(
      `Failed to create validation: ${createData.errors.map((e) => e.message).join(", ")}`,
    );
  }

  const userErrors = createData.data?.validationCreate?.userErrors;
  if (userErrors?.length) {
    throw new Error(
      `Validation creation failed: ${userErrors.map((e) => e.message).join(", ")}`,
    );
  }

  const validation = createData.data?.validationCreate?.validation;
  if (!validation) {
    throw new Error("Validation creation returned no validation object");
  }

  return { id: validation.id, created: true };
}
