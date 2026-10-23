import type { LightSessionStorage } from "~/lib/session-storage-light.server";
import type { ShopifyApp } from "~/shopify.server";

// Augment React Router's AppLoadContext with our per-request instances
declare module "react-router" {
  interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
    sessionStorage: LightSessionStorage;
    shopify: ShopifyApp;
  }
}

// Workaround for missing Polaris web component types
// The @shopify/polaris-types package derives types from preact which may not
// include all components. This declares missing elements.
// TODO: Remove this workaround when polaris-types properly exports these
declare global {
  namespace JSX {
    interface IntrinsicElements {
      "s-app-nav": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      >;
      "s-table-header-row": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      >;
      "s-inline-stack": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { gap?: string },
        HTMLElement
      >;
      "s-horizontal-stack": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { gap?: string; align?: string },
        HTMLElement
      >;
    }
  }
}
