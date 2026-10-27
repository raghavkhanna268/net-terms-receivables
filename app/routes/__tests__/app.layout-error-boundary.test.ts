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
 * - AppProvider wraps fallback so Polaris script loads
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

  describe("delegates to boundary.error for status < 400 and 401", () => {
    it("delegates status 200 ErrorResponse to boundary.error (Shopify bootstrap)", async () => {
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

      const errorResponse = new ErrorResponseImpl(200, "OK", "<html>bootstrap</html>");

      vi.doMock("react-router", async () => {
        const actual = await vi.importActual<typeof import("react-router")>("react-router");
        return {
          ...actual,
          useRouteError: () => errorResponse,
        };
      });

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      renderToString(createElement(ErrorBoundary));

      expect(mockBoundaryError).toHaveBeenCalledWith(errorResponse);
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

      vi.doMock("react-router", async () => {
        const actual = await vi.importActual<typeof import("react-router")>("react-router");
        return {
          ...actual,
          useRouteError: () => errorResponse,
        };
      });

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

      vi.doMock("react-router", async () => {
        const actual = await vi.importActual<typeof import("react-router")>("react-router");
        return {
          ...actual,
          useRouteError: () => errorResponse,
        };
      });

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      renderToString(createElement(ErrorBoundary));

      expect(mockBoundaryError).toHaveBeenCalledWith(errorResponse);
    });
  });

  describe("renders in-app fallback for other errors", () => {
    it("renders in-app fallback for status 404 ErrorResponse", async () => {
      const errorResponse = new ErrorResponseImpl(404, "Not Found", null);

      vi.doMock("react-router", async () => {
        const actual = await vi.importActual<typeof import("react-router")>("react-router");
        return {
          ...actual,
          useRouteError: () => errorResponse,
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

    it("renders in-app fallback for status 500 ErrorResponse", async () => {
      const errorResponse = new ErrorResponseImpl(500, "Internal Server Error", null);

      vi.doMock("react-router", async () => {
        const actual = await vi.importActual<typeof import("react-router")>("react-router");
        return {
          ...actual,
          useRouteError: () => errorResponse,
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

    it("renders in-app fallback for thrown Error", async () => {
      vi.doMock("react-router", async () => {
        const actual = await vi.importActual<typeof import("react-router")>("react-router");
        return {
          ...actual,
          useRouteError: () => new Error("Internal test error"),
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
        };
      });

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      const html = renderToString(createElement(ErrorBoundary));

      expect(html).not.toContain("SENSITIVE_ERROR_MESSAGE_12345");
      expect(html).toContain("We encountered an issue");
    });
  });

  describe("Polaris script in fallback", () => {
    it("includes Polaris script tag in fallback HTML for shopify:navigate handling", async () => {
      vi.doMock("react-router", async () => {
        const actual = await vi.importActual<typeof import("react-router")>("react-router");
        return {
          ...actual,
          useRouteError: () => new Error("Test error"),
        };
      });

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      const html = renderToString(createElement(ErrorBoundary));

      expect(html).toContain("polaris-2.js");
    });
  });
});
