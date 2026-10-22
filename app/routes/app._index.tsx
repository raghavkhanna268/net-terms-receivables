import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  // Session storage is injected per-request via loadContext in workers/app.ts
  const { shopify } = context;

  const { session } = await shopify.authenticate.admin(request);

  return {
    shopName: session.shop.replace(".myshopify.com", ""),
    shopDomain: session.shop,
  };
};

export default function Index() {
  const { shopName, shopDomain } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Net Terms Receivables">
      <s-section heading={`Welcome, ${shopName}!`}>
        <s-paragraph>
          Your app is successfully installed on <s-text type="strong">{shopDomain}</s-text>.
        </s-paragraph>
        <s-paragraph>
          This B2B wholesale net-terms receivables app will help you:
        </s-paragraph>
        <s-unordered-list>
          <s-list-item>Track unpaid invoices per wholesale buyer</s-list-item>
          <s-list-item>Manage credit limits and automatic credit holds</s-list-item>
          <s-list-item>Send payment reminders</s-list-item>
          <s-list-item>Match Indian bank transfer payments (NEFT/RTGS/IMPS/UPI) to orders</s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section slot="aside" heading="Getting Started">
        <s-paragraph>
          Next steps after S2:
        </s-paragraph>
        <s-unordered-list>
          <s-list-item>Build buyer management UI</s-list-item>
          <s-list-item>Implement credit limit tracking</s-list-item>
          <s-list-item>Add invoice generation</s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section slot="aside" heading="Tech Stack">
        <s-paragraph>
          <s-text>Runtime: </s-text>
          <s-link href="https://workers.cloudflare.com" target="_blank">
            Cloudflare Workers
          </s-link>
        </s-paragraph>
        <s-paragraph>
          <s-text>Framework: </s-text>
          <s-link href="https://reactrouter.com" target="_blank">
            React Router v7
          </s-link>
        </s-paragraph>
        <s-paragraph>
          <s-text>Database: </s-text>
          <s-link href="https://supabase.com" target="_blank">
            Supabase Postgres
          </s-link>
          <s-text> via </s-text>
          <s-link href="https://developers.cloudflare.com/hyperdrive" target="_blank">
            Hyperdrive
          </s-link>
        </s-paragraph>
        <s-paragraph>
          <s-text>UI: </s-text>
          <s-link
            href="https://shopify.dev/docs/api/app-home/using-polaris-components"
            target="_blank"
          >
            Polaris Web Components
          </s-link>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
