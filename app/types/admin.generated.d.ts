/* eslint-disable eslint-comments/disable-enable-pair */
/* eslint-disable eslint-comments/no-unlimited-disable */
/* eslint-disable */
import type * as AdminTypes from './admin.types.js';

export type MetafieldDefinitionCreateMutationVariables = AdminTypes.Exact<{
  namespace: AdminTypes.Scalars['String']['input'];
  key: AdminTypes.Scalars['String']['input'];
  name: AdminTypes.Scalars['String']['input'];
  description: AdminTypes.Scalars['String']['input'];
  type: AdminTypes.Scalars['String']['input'];
  ownerType: AdminTypes.MetafieldOwnerType;
}>;


export type MetafieldDefinitionCreateMutation = { metafieldDefinitionCreate?: AdminTypes.Maybe<{ createdDefinition?: AdminTypes.Maybe<Pick<AdminTypes.MetafieldDefinition, 'id'>>, userErrors: Array<Pick<AdminTypes.MetafieldDefinitionCreateUserError, 'field' | 'message' | 'code'>> }> };

export type GetValidationsQueryVariables = AdminTypes.Exact<{ [key: string]: never; }>;


export type GetValidationsQuery = { validations: { edges: Array<{ node: (
        Pick<AdminTypes.Validation, 'id' | 'title' | 'enabled'>
        & { shopifyFunction: Pick<AdminTypes.ShopifyFunction, 'handle'> }
      ) }> } };

export type ValidationCreateMutationVariables = AdminTypes.Exact<{
  functionHandle: AdminTypes.Scalars['String']['input'];
  title: AdminTypes.Scalars['String']['input'];
}>;


export type ValidationCreateMutation = { validationCreate?: AdminTypes.Maybe<{ validation?: AdminTypes.Maybe<(
      Pick<AdminTypes.Validation, 'id' | 'title' | 'enabled'>
      & { shopifyFunction: Pick<AdminTypes.ShopifyFunction, 'handle'> }
    )>, userErrors: Array<Pick<AdminTypes.ValidationUserError, 'field' | 'message'>> }> };

interface GeneratedQueryTypes {
  "#graphql\n  query GetValidations {\n    validations(first: 50) {\n      edges {\n        node {\n          id\n          shopifyFunction {\n            handle\n          }\n          title\n          enabled\n        }\n      }\n    }\n  }\n": {return: GetValidationsQuery, variables: GetValidationsQueryVariables},
}

interface GeneratedMutationTypes {
  "#graphql\n  mutation MetafieldDefinitionCreate(\n    $namespace: String!,\n    $key: String!,\n    $name: String!,\n    $description: String!,\n    $type: String!,\n    $ownerType: MetafieldOwnerType!\n  ) {\n    metafieldDefinitionCreate(definition: {\n      namespace: $namespace,\n      key: $key,\n      name: $name,\n      description: $description,\n      type: $type,\n      ownerType: $ownerType,\n      access: { admin: MERCHANT_READ }\n    }) {\n      createdDefinition {\n        id\n      }\n      userErrors {\n        field\n        message\n        code\n      }\n    }\n  }\n": {return: MetafieldDefinitionCreateMutation, variables: MetafieldDefinitionCreateMutationVariables},
  "#graphql\n  mutation ValidationCreate($functionHandle: String!, $title: String!) {\n    validationCreate(validation: {\n      functionHandle: $functionHandle,\n      title: $title,\n      blockOnFailure: false,\n      enable: true\n    }) {\n      validation {\n        id\n        shopifyFunction {\n          handle\n        }\n        title\n        enabled\n      }\n      userErrors {\n        field\n        message\n      }\n    }\n  }\n": {return: ValidationCreateMutation, variables: ValidationCreateMutationVariables},
}
declare module '@shopify/admin-api-client' {
  type InputMaybe<T> = AdminTypes.InputMaybe<T>;
  interface AdminQueries extends GeneratedQueryTypes {}
  interface AdminMutations extends GeneratedMutationTypes {}
}
