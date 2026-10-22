import type { LoaderFunctionArgs, HeadersFunction } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import styles from "./styles.module.css";

/**
 * Cache-Control headers for the landing page.
 * - public: Can be cached by CDN edge nodes
 * - max-age=3600: Browser cache for 1 hour
 * - s-maxage=86400: Edge cache for 24 hours
 * - stale-while-revalidate: Serve stale while fetching fresh
 * 
 * This eliminates Worker CPU usage for repeat visits.
 */
export const headers: HeadersFunction = () => ({
  "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=3600",
});

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const { shopify } = context;

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(shopify.login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Net Terms Receivables</h1>
        <p className={styles.text}>
          B2B wholesale net-terms management for Shopify. Track invoices, manage credit limits,
          and match Indian bank payments (NEFT/RTGS/IMPS/UPI) to orders.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
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
            <strong>Payment Matching</strong>. Match Indian bank transfers (NEFT/RTGS/IMPS/UPI)
            back to orders automatically.
          </li>
        </ul>
      </div>
    </div>
  );
}
