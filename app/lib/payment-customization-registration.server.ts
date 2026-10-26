/**
 * Payment Customization Registration Service (S13)
 *
 * Idempotent registration of the hide-terms-payment Shopify Function.
 * Uses paymentCustomizationCreate mutation with functionHandle.
 * write_payment_customizations scope is already granted.
 *
 * @see https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/paymentCustomizationCreate
 * @see https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/paymentCustomizationUpdate
 */

import { safeLog, toErrorCode } from "./log.server";

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
const PAYMENT_CUSTOMIZATION_TITLE = "Termwise Payment Hide";

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

const PAYMENT_CUSTOMIZATION_UPDATE_MUTATION = `#graphql
  mutation PaymentCustomizationUpdate($id: ID!, $title: String!) {
    paymentCustomizationUpdate(id: $id, paymentCustomization: { title: $title }) {
      paymentCustomization {
        id
        title
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

interface PaymentCustomizationUpdateResult {
  data?: {
    paymentCustomizationUpdate?: {
      paymentCustomization?: {
        id: string;
        title: string;
      };
      userErrors?: Array<{
        field?: string[];
        message: string;
        code?: string;
      }>;
    };
  };
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

export type TitleUpdateOutcome = "updated" | "skipped" | "failed";

export interface EnsurePaymentCustomizationResult {
  id: string;
  created: boolean;
  titleUpdate: TitleUpdateOutcome;
  errCode?: string;
}

/**
 * Try to update the payment customization title. Logs failures via safeLog.
 */
async function tryUpdateTitle(
  admin: AdminGraphqlClient,
  id: string,
): Promise<{ outcome: TitleUpdateOutcome; errCode?: string }> {
  let errCode: string | undefined;

  try {
    const updateResult = await admin.graphql(PAYMENT_CUSTOMIZATION_UPDATE_MUTATION, {
      variables: { id, title: PAYMENT_CUSTOMIZATION_TITLE },
    });
    const updateData = (await updateResult.json()) as PaymentCustomizationUpdateResult;

    if (updateData.errors?.length) {
      errCode = toErrorCode({ code: updateData.errors[0].extensions?.code });
    } else if (updateData.data?.paymentCustomizationUpdate?.userErrors?.length) {
      errCode = toErrorCode({
        code: updateData.data.paymentCustomizationUpdate.userErrors[0].code,
      });
    } else if (updateData.data?.paymentCustomizationUpdate?.paymentCustomization) {
      return { outcome: "updated" };
    } else {
      errCode = "no_customization_returned";
    }
  } catch (error) {
    errCode = toErrorCode(error);
  }

  safeLog("warn", "payment_customization.title_update_failed", { err: errCode });
  return { outcome: "failed", errCode };
}

/**
 * Check title and update if needed. Returns the outcome.
 */
async function handleExistingCustomization(
  admin: AdminGraphqlClient,
  node: PaymentCustomizationNode,
): Promise<EnsurePaymentCustomizationResult> {
  if (node.title === PAYMENT_CUSTOMIZATION_TITLE) {
    return { id: node.id, created: false, titleUpdate: "skipped" };
  }

  const { outcome, errCode } = await tryUpdateTitle(admin, node.id);
  return { id: node.id, created: false, titleUpdate: outcome, errCode };
}

/**
 * Ensures the hide-terms-payment function is registered for the shop.
 * This is idempotent - if the customization already exists (matched by handle), it returns the existing one.
 * If an existing customization has a different title, updates only the title (does not change enabled state
 * or metafields). Update failures do not block the ensure flow.
 *
 * @param admin - The Shopify Admin API context
 * @returns The payment customization ID, creation flag, title update outcome, and error code if failed
 * @throws Error if registration fails (query or create errors)
 */
export async function ensurePaymentCustomization(
  admin: AdminGraphqlClient,
): Promise<EnsurePaymentCustomizationResult> {
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
    return handleExistingCustomization(admin, existingCustomization.node);
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
    const takenError = userErrors.find((e) => e.code === "TAKEN");
    if (takenError) {
      const reQueryResult = await admin.graphql(PAYMENT_CUSTOMIZATIONS_QUERY);
      const reQueryData = (await reQueryResult.json()) as PaymentCustomizationsQueryResult;
      const existing = reQueryData.data?.paymentCustomizations?.edges.find(
        (edge) => edge.node.shopifyFunction.handle === PAYMENT_CUSTOMIZATION_FUNCTION_HANDLE,
      );
      if (existing) {
        return handleExistingCustomization(admin, existing.node);
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

  return { id: customization.id, created: true, titleUpdate: "skipped" };
}
