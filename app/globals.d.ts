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
// Only declare elements that @shopify/polaris-types genuinely doesn't export.
// Verified by typecheck failure when removed.
declare global {
  namespace JSX {
    interface IntrinsicElements {
      "s-app-nav": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      >;
      "ui-save-bar": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { id: string },
        HTMLElement
      >;
    }
  }

  namespace React {
    interface ButtonHTMLAttributes<T> {
      variant?: "primary" | "secondary";
    }
  }

  interface ShopifySaveBar {
    show: (id: string) => Promise<void>;
    hide: (id: string) => Promise<void>;
    toggle: (id: string) => Promise<void>;
    leaveConfirmation: () => Promise<void>;
  }

  interface Shopify {
    saveBar: ShopifySaveBar;
  }

  const shopify: Shopify | undefined;
}
