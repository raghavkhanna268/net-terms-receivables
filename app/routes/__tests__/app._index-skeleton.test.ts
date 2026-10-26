/**
 * Tests for DashboardSkeleton component (#290).
 *
 * Validates that the skeleton component renders correctly while
 * deferred data is loading.
 */
import { describe, it, expect } from "vitest";
import * as React from "react";
import { renderToString } from "react-dom/server";
import { DashboardSkeleton } from "../app._index";

describe("DashboardSkeleton (#290 LCP fix)", () => {
  it("renders three sections with loading spinners", () => {
    const html = renderToString(React.createElement(DashboardSkeleton));

    // Check for three sections
    expect(html).toContain('heading="Your Plan"');
    expect(html).toContain('heading="Receivables Summary"');
    expect(html).toContain('heading="Buyer Ledger"');

    // Check for spinners (s-spinner)
    const spinnerCount = (html.match(/s-spinner/g) || []).length;
    expect(spinnerCount).toBeGreaterThanOrEqual(3);
  });

  it("renders loading text for each section", () => {
    const html = renderToString(React.createElement(DashboardSkeleton));

    expect(html).toContain("Loading plan information");
    expect(html).toContain("Loading receivables data");
    expect(html).toContain("Loading buyer ledger");
  });

  it("does not include any data or money values", () => {
    const html = renderToString(React.createElement(DashboardSkeleton));

    // Should not contain any currency symbols or data
    expect(html).not.toContain("₹");
    expect(html).not.toContain("INR");
    expect(html).not.toContain("paise");
    expect(html).not.toContain("outstanding");
    expect(html).not.toMatch(/\d{6,}/); // No large numbers
  });

  it("uses Polaris components with valid props", () => {
    const html = renderToString(React.createElement(DashboardSkeleton));

    // Check for valid Polaris components
    expect(html).toContain("s-section");
    expect(html).toContain("s-box");
    expect(html).toContain("s-stack");
    expect(html).toContain("s-text");
    expect(html).toContain("s-spinner");

    // Check spinner uses valid size prop
    expect(html).toContain('size="base"');
  });
});
