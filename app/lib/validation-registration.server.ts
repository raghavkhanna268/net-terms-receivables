/**
 * Validation Registration Service
 *
 * Idempotent registration of the credit-check-validation Shopify Function.
 * Uses validationCreate mutation with functionHandle (per 2026-10 schema).
 * Query results use shopifyFunction { handle } (functionHandle is input-only).
 * write_validations scope is already granted.
 *
 * @see https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/validationCreate
 * @see https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/validationUpdate
 */

import { toErrorCode } from "./log.server";

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
const VALIDATION_TITLE = "Termwise Credit Check";

interface ValidationNode {
  id: string;
  shopifyFunction: {
    handle: string;
  };
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
        shopifyFunction: {
          handle: string;
        };
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
          shopifyFunction {
            handle
          }
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
        shopifyFunction {
          handle
        }
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

const VALIDATION_UPDATE_MUTATION = `#graphql
  mutation ValidationUpdate($id: ID!, $title: String!) {
    validationUpdate(id: $id, validation: { title: $title }) {
      validation {
        id
        title
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface ValidationUpdateResult {
  data?: {
    validationUpdate?: {
      validation?: {
        id: string;
        title: string;
      };
      userErrors?: Array<{
        field?: string[];
        message: string;
      }>;
    };
  };
  errors?: Array<{ message: string }>;
}

/**
 * Ensures the credit check validation function is registered for the shop.
 * This is idempotent - if the validation already exists (matched by handle), it returns the existing one.
 * If an existing validation has a different title, updates only the title (does not change enabled state,
 * blockOnFailure, or metafields). Update failures are logged but do not block the ensure flow.
 *
 * @param admin - The Shopify Admin API context
 * @returns The validation ID (existing or newly created), creation flag, and title update count
 * @throws Error if registration fails (query or create errors)
 */
export async function ensureValidation(
  admin: AdminGraphqlClient,
): Promise<{ id: string; created: boolean; titleUpdateCount: number }> {
  const existingResult = await admin.graphql(VALIDATIONS_QUERY);
  const existingData = (await existingResult.json()) as ValidationsQueryResult;

  if (existingData.errors?.length) {
    throw new Error(
      `Failed to query validations: ${existingData.errors.map((e) => e.message).join(", ")}`,
    );
  }

  const existingValidation = existingData.data?.validations?.edges.find(
    (edge) => edge.node.shopifyFunction.handle === VALIDATION_FUNCTION_HANDLE,
  );

  if (existingValidation) {
    const node = existingValidation.node;
    if (node.title === VALIDATION_TITLE) {
      return { id: node.id, created: false, titleUpdateCount: 0 };
    }

    let titleUpdateCount = 0;
    try {
      const updateResult = await admin.graphql(VALIDATION_UPDATE_MUTATION, {
        variables: { id: node.id, title: VALIDATION_TITLE },
      });
      const updateData = (await updateResult.json()) as ValidationUpdateResult;

      if (updateData.errors?.length) {
        console.warn(`[validation] title_update err=${toErrorCode({ message: updateData.errors[0].message })}`);
      } else if (updateData.data?.validationUpdate?.userErrors?.length) {
        console.warn(`[validation] title_update err=${toErrorCode({ message: updateData.data.validationUpdate.userErrors[0].message })}`);
      } else if (updateData.data?.validationUpdate?.validation) {
        titleUpdateCount = 1;
      }
    } catch (error) {
      console.warn(`[validation] title_update err=${toErrorCode(error)}`);
    }

    return { id: node.id, created: false, titleUpdateCount };
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

  return { id: validation.id, created: true, titleUpdateCount: 0 };
}
