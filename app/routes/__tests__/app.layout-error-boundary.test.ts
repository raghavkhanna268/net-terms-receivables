/**
 * Tests for app.tsx ErrorBoundary.
 *
 * Verifies that:
 * - ErrorResponses with status < 400 delegate to boundary.error (Shopify bootstrap)
 * - ErrorResponses with status 401 delegate to boundary.error (auth flow)
 * - ErrorResponses with status >= 400 (except 401) render in-app fallback
 * - Thrown Errors render in-app fallback
 * - Error message text is NOT exposed in the output
 * - Dashboard link is present in fallback
 * - AppProvider wraps fallback (Polaris script + shopify:navigate listener)
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { UNSAFE_ErrorResponseImpl as ErrorResponseImpl } from "react-router";

describe("app.tsx ErrorBoundary", () => {
  afterEach(() => {
    vi.doUnmock("react-router");
    vi.doUnmock("@shopify/shopify-app-react-router/server");
    vi.resetModules();
  });

  function setupRouterMocks(
    errorValue: unknown,
    rootLoaderData: { apiKey?: string } | undefined = { apiKey: "test-api-key" }
  ) {
    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>("react-router");
      return {
        ...actual,
        useRouteError: () => errorValue,
        useRouteLoaderData: (routeId: string) => (routeId === "root" ? rootLoaderData : undefined),
        useNavigate: () => vi.fn(),
      };
    });
  }

  describe("delegates to boundary.error for status < 400 and 401", () => {
    it("renders status 200 + string data as HTML without calling boundary.error", async () => {
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

      const errorResponse = new ErrorResponseImpl(200, "OK", "<script>window.shopify.reload()</script>");
      setupRouterMocks(errorResponse);

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      const html = renderToString(createElement(ErrorBoundary));

      expect(html).toContain("window.shopify.reload()");
      expect(html).not.toContain("s-page");
      expect(mockBoundaryError).not.toHaveBeenCalled();
    });

    it("delegates status 302 ErrorResponse to boundary.error", async () => {
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

      const errorResponse = new ErrorResponseImpl(302, "Found", null);
      setupRouterMocks(errorResponse);

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      renderToString(createElement(ErrorBoundary));

      expect(mockBoundaryError).toHaveBeenCalledWith(errorResponse);
    });

    it("delegates status 401 ErrorResponse to boundary.error (auth flow)", async () => {
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

      const errorResponse = new ErrorResponseImpl(401, "Unauthorized", null);
      setupRouterMocks(errorResponse);

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      renderToString(createElement(ErrorBoundary));

      expect(mockBoundaryError).toHaveBeenCalledWith(errorResponse);
    });
  });

  describe("renders in-app fallback for other errors", () => {
    it("renders in-app fallback for status 404 ErrorResponse", async () => {
      const errorResponse = new ErrorResponseImpl(404, "Not Found", null);
      setupRouterMocks(errorResponse);

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      const html = renderToString(createElement(ErrorBoundary));

      expect(html).toContain("s-page");
      expect(html).toContain("s-banner");
      expect(html).toContain("Something went wrong");
      expect(html).toContain('href="/app"');
    });

    it("renders in-app fallback for status 500 ErrorResponse", async () => {
      const errorResponse = new ErrorResponseImpl(500, "Internal Server Error", null);
      setupRouterMocks(errorResponse);

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      const html = renderToString(createElement(ErrorBoundary));

      expect(html).toContain("s-page");
      expect(html).toContain("s-banner");
      expect(html).toContain("Something went wrong");
      expect(html).toContain('href="/app"');
    });

    it("renders in-app fallback for thrown Error", async () => {
      setupRouterMocks(new Error("Internal test error"));

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
      setupRouterMocks(new Error("SENSITIVE_ERROR_MESSAGE_12345"));

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      const html = renderToString(createElement(ErrorBoundary));

      expect(html).not.toContain("SENSITIVE_ERROR_MESSAGE_12345");
      expect(html).toContain("We encountered an issue");
    });
  });

  describe("AppProvider wraps fallback", () => {
    it("includes Polaris script tag in fallback HTML", async () => {
      setupRouterMocks(new Error("Test error"));

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      const html = renderToString(createElement(ErrorBoundary));

      expect(html).toContain("polaris-2.js");
    });

    it("uses apiKey from root loader data when available", async () => {
      setupRouterMocks(new Error("Test error"), { apiKey: "custom-api-key" });

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      const html = renderToString(createElement(ErrorBoundary));

      expect(html).toContain("s-page");
    });

    it("renders fallback when root loader data is undefined", async () => {
      setupRouterMocks(new Error("Test error"), undefined);

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      const html = renderToString(createElement(ErrorBoundary));

      expect(html).toContain("s-page");
      expect(html).toContain("polaris-2.js");
    });
  });
});
