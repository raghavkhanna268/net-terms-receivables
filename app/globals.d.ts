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

// Generic Polaris props with permissive slot attribute
type PolarisBaseProps = React.HTMLAttributes<HTMLElement> & {
  slot?: string;
};

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "s-app-nav": React.DetailedHTMLProps<PolarisBaseProps, HTMLElement>;
      "s-link": React.DetailedHTMLProps<
        PolarisBaseProps & { href?: string; tone?: string },
        HTMLElement
      >;
      "s-money-field": React.DetailedHTMLProps<
        PolarisBaseProps & {
          label?: string;
          name?: string;
          min?: number;
          max?: number;
          placeholder?: string;
        },
        HTMLElement
      >;
      "s-grid": React.DetailedHTMLProps<
        PolarisBaseProps & {
          gridTemplateColumns?: string;
          gap?: string;
          alignItems?: string;
        },
        HTMLElement
      >;
    }
  }
}
