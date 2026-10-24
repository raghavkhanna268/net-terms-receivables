/**
 * Payment Customization Registration Service (S13)
 *
 * Idempotent registration of the hide-terms-payment Shopify Function.
 * Uses paymentCustomizationCreate mutation with functionHandle.
 * write_payment_customizations scope is already granted.
 *
 * @see https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/paymentCustomizationCreate
 */

/**
 * Minimal type for the admin GraphQL client.
 */
interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<unknown> }>;
}

const PAYMENT_CUSTOMIZATION_FUNCTION_HANDLE = "hide-terms-payment";
const PAYMENT_CUSTOMIZATION_TITLE = "Net Terms Payment Hide";

interface PaymentCustomizationNode {
  id: string;
  shopifyFunction: {
    handle: string;
  };
  title: string;
  enabled: boolean;
}

interface PaymentCustomizationsQueryResult {
  data?: {
    paymentCustomizations?: {
      edges: Array<{
        node: PaymentCustomizationNode;
      }>;
    };
  };
  errors?: Array<{ message: string }>;
}

interface PaymentCustomizationCreateResult {
  data?: {
    paymentCustomizationCreate?: {
      paymentCustomization?: {
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
        code?: string;
      }>;
    };
  };
  errors?: Array<{ message: string }>;
}

const PAYMENT_CUSTOMIZATIONS_QUERY = `#graphql
  query GetPaymentCustomizations {
    paymentCustomizations(first: 50) {
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

const PAYMENT_CUSTOMIZATION_CREATE_MUTATION = `#graphql
  mutation PaymentCustomizationCreate($functionHandle: String!, $title: String!) {
    paymentCustomizationCreate(paymentCustomization: {
      functionHandle: $functionHandle,
      title: $title,
      enabled: true
    }) {
      paymentCustomization {
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
        code
      }
    }
  }
`;

/**
 * Ensures the hide-terms-payment function is registered for the shop.
 * This is idempotent - if the customization already exists (matched by handle), it returns the existing one.
 *
 * @param admin - The Shopify Admin API context
 * @returns The payment customization ID (existing or newly created)
 * @throws Error if registration fails
 */
export async function ensurePaymentCustomization(
  admin: AdminGraphqlClient,
): Promise<{ id: string; created: boolean }> {
  const existingResult = await admin.graphql(PAYMENT_CUSTOMIZATIONS_QUERY);
  const existingData = (await existingResult.json()) as PaymentCustomizationsQueryResult;

  if (existingData.errors?.length) {
    throw new Error(
      `Failed to query payment customizations: ${existingData.errors.map((e) => e.message).join(", ")}`,
    );
  }

  const existingCustomization = existingData.data?.paymentCustomizations?.edges.find(
    (edge) => edge.node.shopifyFunction.handle === PAYMENT_CUSTOMIZATION_FUNCTION_HANDLE,
  );

  if (existingCustomization) {
    return { id: existingCustomization.node.id, created: false };
  }

  const createResult = await admin.graphql(PAYMENT_CUSTOMIZATION_CREATE_MUTATION, {
    variables: {
      functionHandle: PAYMENT_CUSTOMIZATION_FUNCTION_HANDLE,
      title: PAYMENT_CUSTOMIZATION_TITLE,
    },
  });

  const createData = (await createResult.json()) as PaymentCustomizationCreateResult;

  if (createData.errors?.length) {
    throw new Error(
      `Failed to create payment customization: ${createData.errors.map((e) => e.message).join(", ")}`,
    );
  }

  const userErrors = createData.data?.paymentCustomizationCreate?.userErrors;
  if (userErrors?.length) {
    // Check for TAKEN error (already exists)
    const takenError = userErrors.find((e) => e.code === "TAKEN");
    if (takenError) {
      // Re-query to get the existing one
      const reQueryResult = await admin.graphql(PAYMENT_CUSTOMIZATIONS_QUERY);
      const reQueryData = (await reQueryResult.json()) as PaymentCustomizationsQueryResult;
      const existing = reQueryData.data?.paymentCustomizations?.edges.find(
        (edge) => edge.node.shopifyFunction.handle === PAYMENT_CUSTOMIZATION_FUNCTION_HANDLE,
      );
      if (existing) {
        return { id: existing.node.id, created: false };
      }
    }

    throw new Error(
      `Payment customization creation failed: ${userErrors.map((e) => e.message).join(", ")}`,
    );
  }

  const customization = createData.data?.paymentCustomizationCreate?.paymentCustomization;
  if (!customization) {
    throw new Error("Payment customization creation returned no customization object");
  }

  return { id: customization.id, created: true };
}
