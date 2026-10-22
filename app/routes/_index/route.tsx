import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
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
