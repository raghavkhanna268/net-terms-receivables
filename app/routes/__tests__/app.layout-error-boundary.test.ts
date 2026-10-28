/**
 * Tests for app.tsx ErrorBoundary.
 *
 * Verifies that:
 * - ErrorResponses with status 200 and string data render the embedded HTML
 *   (the re-auth bounce case from #532)
 * - 401/403 auth errors rethrow for Shopify auth flow (preserved from original)
 * - Non-auth 4xx/5xx errors render in-layout with nav (v1.1 behavior)
 * - Plain Errors render in-layout with generic message
 * - 200 with non-string data rethrows to root boundary
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

  function setupRouterMocks(errorValue: unknown, options: { mockNavigate?: boolean; mockApiKey?: string } = {}) {
    const apiKey = options.mockApiKey ?? "test-api-key";
    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>("react-router");
      return {
        ...actual,
        useRouteError: () => errorValue,
        useRouteLoaderData: () => ({ apiKey }),
        ...(options.mockNavigate ? { useNavigate: () => vi.fn() } : {}),
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

  describe("rethrows auth errors for Shopify auth flow", () => {
    it("rethrows status 401 for re-auth flow", async () => {
      const errorResponse = new ErrorResponseImpl(401, "Unauthorized", null);
      setupRouterMocks(errorResponse);

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      expect(() => renderToString(createElement(ErrorBoundary))).toThrow();
    });

    it("rethrows status 403 for permission flow", async () => {
      const errorResponse = new ErrorResponseImpl(403, "Forbidden", null);
      setupRouterMocks(errorResponse);

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      expect(() => renderToString(createElement(ErrorBoundary))).toThrow();
    });
  });

  describe("renders non-auth 4xx/5xx errors in-layout with nav", () => {
    it("renders status 404 ErrorResponse in-layout", async () => {
      const errorResponse = new ErrorResponseImpl(404, "Not Found", null);
      setupRouterMocks(errorResponse, { mockNavigate: true, mockApiKey: "test-key" });

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      const html = renderToString(createElement(ErrorBoundary));

      expect(html).toContain("s-app-nav");
      expect(html).toContain("Page not found");
    });

    it("renders status 500 ErrorResponse in-layout", async () => {
      const errorResponse = new ErrorResponseImpl(500, "Internal Server Error", null);
      setupRouterMocks(errorResponse, { mockNavigate: true, mockApiKey: "test-key" });

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      const html = renderToString(createElement(ErrorBoundary));

      expect(html).toContain("s-app-nav");
      expect(html).toContain("Something went wrong");
    });

    it("renders plain Error in-layout with generic message", async () => {
      setupRouterMocks(new Error("Unexpected failure"), { mockNavigate: true, mockApiKey: "test-key" });

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      const html = renderToString(createElement(ErrorBoundary));

      expect(html).toContain("s-app-nav");
      expect(html).toContain("Something went wrong");
      expect(html).not.toContain("Unexpected failure");
    });
  });

  describe("rethrows edge cases to root boundary", () => {
    it("rethrows status 200 with non-string data", async () => {
      const errorResponse = new ErrorResponseImpl(200, "OK", { message: "object" });
      setupRouterMocks(errorResponse);

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      expect(() => renderToString(createElement(ErrorBoundary))).toThrow();
    });
  });
});
