import type { PrismaSessionStorage } from "~/lib/session-storage.server";
import type { ShopifyApp } from "~/shopify.server";

// Augment React Router's AppLoadContext with our per-request instances
declare module "react-router" {
  interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
    sessionStorage: PrismaSessionStorage;
    shopify: ShopifyApp;
  }
}

// Workaround for missing Polaris web component types
// The @shopify/polaris-types package derives types from preact which may not
// include all components. This declares the missing s-app-nav element.
// TODO: Remove this workaround when polaris-types properly exports s-app-nav
declare global {
  namespace JSX {
    interface IntrinsicElements {
      "s-app-nav": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      >;
    }
  }
}
