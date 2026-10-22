import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";

import { login, sessionStorage } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  // Inject KV namespace for session storage
  const env = context.cloudflare?.env;
  if (env?.SESSIONS) {
    sessionStorage.setNamespace(env.SESSIONS);
  }

  const errors = loginErrorMessage(await login(request));

  return { errors };
};

export const action = async ({ request, context }: ActionFunctionArgs) => {
  // Inject KV namespace for session storage
  const env = context.cloudflare?.env;
  if (env?.SESSIONS) {
    sessionStorage.setNamespace(env.SESSIONS);
  }

  const errors = loginErrorMessage(await login(request));

  return {
    errors,
  };
};

export default function Auth() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [shop, setShop] = useState("");
  const { errors } = actionData || loaderData;

  return (
    <>
      <script src="https://cdn.shopify.com/shopifycloud/polaris.js" />
      <s-page>
        <Form method="post">
          <s-section heading="Log in to Net Terms Receivables">
            <s-text-field
              name="shop"
              label="Shop domain"
              details="example.myshopify.com"
              value={shop}
              onChange={(e) => setShop(e.currentTarget.value)}
              autocomplete="on"
              error={errors.shop}
            ></s-text-field>
            <s-button type="submit">Log in</s-button>
          </s-section>
        </Form>
      </s-page>
    </>
  );
}
