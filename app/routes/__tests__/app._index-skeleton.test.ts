/**
 * Tests for DashboardSkeleton and DashboardErrorBanner components (#290).
 *
 * Validates that:
 * - Skeleton renders correctly while deferred data is loading
 * - Error banner renders with retry button when promise rejects
 * - Error banner keeps the page usable (header, nav, sections remain)
 */
import { describe, it, expect, vi } from "vitest";
import * as React from "react";
import { renderToString } from "react-dom/server";
import { DashboardSkeleton } from "../app._index";

vi.mock("react-router", async () => {
  const actual = await vi.importActual("react-router");
  return {
    ...actual,
    useRevalidator: () => ({ state: "idle", revalidate: vi.fn() }),
  };
});

describe("DashboardSkeleton (#290 LCP fix)", () => {
  it("renders three sections with loading spinners", () => {
    const html = renderToString(React.createElement(DashboardSkeleton));

    expect(html).toContain('heading="Your Plan"');
    expect(html).toContain('heading="Receivables Summary"');
    expect(html).toContain('heading="Buyer Ledger"');

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

    expect(html).not.toContain("₹");
    expect(html).not.toContain("INR");
    expect(html).not.toContain("paise");
    expect(html).not.toContain("outstanding");
    expect(html).not.toMatch(/\d{6,}/);
  });

  it("uses Polaris components with valid props", () => {
    const html = renderToString(React.createElement(DashboardSkeleton));

    expect(html).toContain("s-section");
    expect(html).toContain("s-box");
    expect(html).toContain("s-stack");
    expect(html).toContain("s-text");
    expect(html).toContain("s-spinner");
    expect(html).toContain('size="base"');
  });

  it("skeleton layout footprint matches DashboardContent structure (avoids CLS)", () => {
    const html = renderToString(React.createElement(DashboardSkeleton));

    const sectionMatches = html.match(/s-section/g) || [];
    expect(sectionMatches.length).toBeGreaterThanOrEqual(3);

    expect(html).toContain('heading="Your Plan"');
    expect(html).toContain('heading="Receivables Summary"');
    expect(html).toContain('heading="Buyer Ledger"');
  });
});

describe("DashboardErrorBanner (#290 P1: error handling)", () => {
  it("renders error message with fixed copy", async () => {
    const { DashboardErrorBanner } = await import("../app._index");
    const html = renderToString(React.createElement(DashboardErrorBanner));

    expect(html).toContain("Failed to load aging data. Please try again.");
  });

  it("renders retry button", async () => {
    const { DashboardErrorBanner } = await import("../app._index");
    const html = renderToString(React.createElement(DashboardErrorBanner));

    expect(html).toContain("Retry");
    expect(html).toContain("s-button");
  });

  it("renders all three sections to maintain layout structure", async () => {
    const { DashboardErrorBanner } = await import("../app._index");
    const html = renderToString(React.createElement(DashboardErrorBanner));

    expect(html).toContain('heading="Your Plan"');
    expect(html).toContain('heading="Receivables Summary"');
    expect(html).toContain('heading="Buyer Ledger"');
  });

  it("uses critical tone for error banner", async () => {
    const { DashboardErrorBanner } = await import("../app._index");
    const html = renderToString(React.createElement(DashboardErrorBanner));

    expect(html).toContain('tone="critical"');
  });

  it("provides empty states for data sections while error is shown", async () => {
    const { DashboardErrorBanner } = await import("../app._index");
    const html = renderToString(React.createElement(DashboardErrorBanner));

    expect(html).toContain("Data unavailable");
    expect(html).toContain("load receivables");
    expect(html).toContain("Select Retry to try again");
  });
});
