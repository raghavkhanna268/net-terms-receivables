import type { LoaderFunctionArgs, HeadersFunction } from "react-router";
import { redirect } from "react-router";

import styles from "./styles.module.css";

/**
 * Cache-Control for the landing page.
 * - public: no user-specific content (no login form)
 * - max-age=300: browser caches for 5 minutes
 *
 * App Store compliance: Per Shopify requirement 2.3.1, App Store apps must not
 * request manual entry of a myshopify.com URL or shop domain during installation
 * or configuration. Install/login must start from the Shopify App Store or admin.
 * @see https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements
 */
export const headers: HeadersFunction = () => ({
  "Cache-Control": "public, max-age=300",
});

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  // Redirect shop parameter to /app for OAuth flow (managed installation)
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

export default function App() {
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Net Terms Receivables</h1>
        <p className={styles.text}>
          B2B wholesale net-terms management for Shopify. Track invoices, manage credit limits,
          and match Indian bank payments (NEFT/RTGS/IMPS/UPI/CMS) to orders.
        </p>
        <p className={styles.text}>
          <strong>Install from the Shopify App Store</strong> to get started.
        </p>
        <ul className={styles.list}>
          <li>
            <strong>Invoice Tracking</strong>. Track unpaid invoices per wholesale buyer
            with automated aging reports.
          </li>
          <li>
            <strong>Credit Management</strong>. Set credit limits per buyer with automatic
            credit holds when limits are exceeded.
          </li>
          <li>
            <strong>Payment Matching</strong>. Match Indian bank transfers (NEFT/RTGS/IMPS/UPI/CMS)
            back to orders automatically.
          </li>
        </ul>
      </div>
    </div>
  );
}
