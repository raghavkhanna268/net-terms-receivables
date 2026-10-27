/**
 * Tests for app.tsx ErrorBoundary.
 *
 * Verifies that:
 * - Non-auth errors render in-app Polaris fallback
 * - Auth (401) errors delegate to boundary.error
 * - Error message text is NOT exposed in the output
 * - Dashboard link is present in fallback
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";

describe("app.tsx ErrorBoundary", () => {
  afterEach(() => {
    vi.doUnmock("react-router");
    vi.doUnmock("@shopify/shopify-app-react-router/server");
    vi.resetModules();
  });

  it("renders in-app Polaris fallback for non-auth errors", async () => {
    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>("react-router");
      return {
        ...actual,
        useRouteError: () => new Error("Internal test error"),
        isRouteErrorResponse: () => false,
      };
    });

    vi.resetModules();
    const { ErrorBoundary } = await import("../app");

    const html = renderToString(createElement(ErrorBoundary));

    expect(html).toContain("s-page");
    expect(html).toContain("s-banner");
    expect(html).toContain("Something went wrong");
    expect(html).toContain('href="/app"');
    expect(html).toContain("Go to Dashboard");
  });

  it("does not expose error message text in output", async () => {
    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>("react-router");
      return {
        ...actual,
        useRouteError: () => new Error("SENSITIVE_ERROR_MESSAGE_12345"),
        isRouteErrorResponse: () => false,
      };
    });

    vi.resetModules();
    const { ErrorBoundary } = await import("../app");

    const html = renderToString(createElement(ErrorBoundary));

    expect(html).not.toContain("SENSITIVE_ERROR_MESSAGE_12345");
    expect(html).toContain("We encountered an issue");
  });

  it("delegates 401 auth errors to boundary.error", async () => {
    const mockBoundaryError = vi.fn().mockReturnValue(null);

    vi.doMock("@shopify/shopify-app-react-router/server", async () => {
      const actual = await vi.importActual<typeof import("@shopify/shopify-app-react-router/server")>("@shopify/shopify-app-react-router/server");
      return {
        ...actual,
        boundary: {
          ...actual.boundary,
          error: mockBoundaryError,
        },
      };
    });

    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>("react-router");
      return {
        ...actual,
        useRouteError: () => ({ status: 401, statusText: "Unauthorized", data: null }),
        isRouteErrorResponse: () => true,
      };
    });

    vi.resetModules();
    const { ErrorBoundary } = await import("../app");

    renderToString(createElement(ErrorBoundary));

    expect(mockBoundaryError).toHaveBeenCalledWith(
      expect.objectContaining({ status: 401 })
    );
  });

  it("renders in-app fallback for 500 errors (not auth)", async () => {
    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>("react-router");
      return {
        ...actual,
        useRouteError: () => ({ status: 500, statusText: "Internal Server Error", data: null }),
        isRouteErrorResponse: () => true,
      };
    });

    vi.resetModules();
    const { ErrorBoundary } = await import("../app");

    const html = renderToString(createElement(ErrorBoundary));

    expect(html).toContain("s-page");
    expect(html).toContain("s-banner");
    expect(html).toContain("Something went wrong");
    expect(html).toContain('href="/app"');
  });

  it("renders in-app fallback for 404 errors", async () => {
    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>("react-router");
      return {
        ...actual,
        useRouteError: () => ({ status: 404, statusText: "Not Found", data: null }),
        isRouteErrorResponse: () => true,
      };
    });

    vi.resetModules();
    const { ErrorBoundary } = await import("../app");

    const html = renderToString(createElement(ErrorBoundary));

    expect(html).toContain("s-page");
    expect(html).toContain("Something went wrong");
    expect(html).toContain('href="/app"');
  });

  it("includes Dashboard link in fallback", async () => {
    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>("react-router");
      return {
        ...actual,
        useRouteError: () => new Error("Test error"),
        isRouteErrorResponse: () => false,
      };
    });

    vi.resetModules();
    const { ErrorBoundary } = await import("../app");

    const html = renderToString(createElement(ErrorBoundary));

    expect(html).toContain('href="/app"');
    expect(html).toContain("Go to Dashboard");
  });
});
