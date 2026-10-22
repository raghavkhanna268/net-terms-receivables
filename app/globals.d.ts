import type { PrismaClient } from "@prisma/client";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";

// Augment React Router's AppLoadContext with our per-request instances
declare module "react-router" {
  interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
    prisma: PrismaClient;
    sessionStorage: SessionStorage;
    shopify: ReturnType<typeof import("./shopify.server").createShopifyApp>;
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
