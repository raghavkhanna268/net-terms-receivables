/**
 * Custom AppProvider that renders Polaris + shopify:navigate handler WITHOUT
 * injecting app-bridge.js, since it's already loaded in <head> by root.tsx.
 *
 * This avoids the duplicate script tag issue where both root.tsx and the
 * upstream @shopify/shopify-app-react-router AppProvider inject app-bridge.js.
 *
 * Evidence: node_modules/@shopify/shopify-app-react-router/src/react/components/AppProvider/AppProvider.tsx
 * lines 70-76 show AppProvider always renders <script src="...app-bridge.js" />.
 * There is no prop to disable this injection.
 *
 * The official Shopify React Router template (github.com/Shopify/shopify-app-template-react-router)
 * uses AppProvider which injects the script in body. Our BFS 3.1.1 compliance
 * requirement (PR #255) mandates the script be in <head> as the first script.
 * By keeping our head injection and using this custom provider, we satisfy
 * both requirements: one tag, in head, first script position.
 */
import React, { useEffect } from "react";
import { useNavigate } from "react-router";

const POLARIS_URL = "https://cdn.shopify.com/shopifycloud/polaris-2.js";

export interface AppProviderProps {
  children: React.ReactNode;
  apiKey: string;
  polarisUrl?: string;
}

export function AppProvider({
  children,
  polarisUrl = POLARIS_URL,
}: AppProviderProps) {
  const navigate = useNavigate();

  useEffect(() => {
    const handleNavigate = (event: Event) => {
      const href = (event.target as HTMLElement)?.getAttribute("href");
      if (href) {
        navigate(href);
      }
    };

    document.addEventListener("shopify:navigate", handleNavigate);

    return () => {
      document.removeEventListener("shopify:navigate", handleNavigate);
    };
  }, [navigate]);

  return (
    <>
      <script src={polarisUrl} />
      {children}
    </>
  );
}
