import type { LoaderFunctionArgs, HeadersFunction } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import styles from "./styles.module.css";

/**
 * Cache-Control for the landing page.
 * - private: response may contain user-specific content (login form)
 * - max-age=60: browser caches for 1 minute
 */
export const headers: HeadersFunction = () => ({
  "Cache-Control": "private, max-age=60",
});

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  // Redirect shop parameter to /app without loading heavy Shopify modules
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  // For App Store distribution apps, login form is always available.
  // We access shopify.login to determine this, but for public apps
  // this is a lightweight check (no DB access, no session).
  const { shopify } = context;
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
