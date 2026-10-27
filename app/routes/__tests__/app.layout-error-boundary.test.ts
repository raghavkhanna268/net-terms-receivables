/**
 * Tests for app.tsx ErrorBoundary.
 *
 * Verifies that:
 * - ErrorResponses with status 200 and string data render the embedded HTML
 *   (the re-auth bounce case from #532)
 * - Other errors are rethrown for the root boundary to handle
 *
 * Note: The in-app error fallback for the /app layout is deferred to v1.1;
 * this PR keeps the current app route error boundary unchanged.
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

  function setupRouterMocks(errorValue: unknown) {
    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>("react-router");
      return {
        ...actual,
        useRouteError: () => errorValue,
      };
    });
  }

  describe("handles status 200 + string data (embedded re-auth bounce)", () => {
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
      expect(mockBoundaryError).not.toHaveBeenCalled();
    });

    it("renders 'Handling response' fallback when data is empty string", async () => {
      const errorResponse = new ErrorResponseImpl(200, "OK", "");
      setupRouterMocks(errorResponse);

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      const html = renderToString(createElement(ErrorBoundary));

      expect(html).toContain("Handling response");
    });
  });

  describe("rethrows other errors for root boundary", () => {
    it("rethrows status 404 ErrorResponse", async () => {
      const errorResponse = new ErrorResponseImpl(404, "Not Found", null);
      setupRouterMocks(errorResponse);

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      expect(() => renderToString(createElement(ErrorBoundary))).toThrow();
    });

    it("rethrows status 500 ErrorResponse", async () => {
      const errorResponse = new ErrorResponseImpl(500, "Internal Server Error", null);
      setupRouterMocks(errorResponse);

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      expect(() => renderToString(createElement(ErrorBoundary))).toThrow();
    });

    it("rethrows plain Error", async () => {
      setupRouterMocks(new Error("Unexpected failure"));

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      expect(() => renderToString(createElement(ErrorBoundary))).toThrow("Unexpected failure");
    });

    it("rethrows status 200 with non-string data", async () => {
      const errorResponse = new ErrorResponseImpl(200, "OK", { message: "object" });
      setupRouterMocks(errorResponse);

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      expect(() => renderToString(createElement(ErrorBoundary))).toThrow();
    });
  });
});
