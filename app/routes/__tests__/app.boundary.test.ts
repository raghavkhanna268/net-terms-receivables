/**
 * Tests for app.tsx ErrorBoundary handling of route error responses.
 *
 * The Shopify library's boundary.error checks constructor.name, which fails
 * for minified/anonymous error classes in the client bundle. This boundary
 * uses React Router's isRouteErrorResponse (duck-typing) plus an explicit
 * status === 200 check to handle only the embedded re-auth bounce case.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { isRouteErrorResponse, UNSAFE_ErrorResponseImpl } from "react-router";

describe("app.tsx ErrorBoundary", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders data for anonymous-class bounce response (status 200, string data)", async () => {
    const AnonymousErrorResponse = (() =>
      class {
        status = 200;
        statusText = "OK";
        internal = false;
        data = "<script>window.shopify.reload()</script>";
      })();

    const anonymousError = new AnonymousErrorResponse();

    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>(
        "react-router"
      );
      return {
        ...actual,
        useRouteError: () => anonymousError,
        useRouteLoaderData: (routeId: string) =>
          routeId === "root" ? { apiKey: "test-key" } : undefined,
      };
    });

    vi.resetModules();
    const { ErrorBoundary } = await import("../app");

    const html = renderToString(createElement(ErrorBoundary));

    expect(html).toContain("window.shopify.reload()");
  });

  it("renders fallback 'Handling response' when data is empty string", async () => {
    const AnonymousErrorResponse = (() =>
      class {
        status = 200;
        statusText = "OK";
        internal = false;
        data = "";
      })();

    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>(
        "react-router"
      );
      return {
        ...actual,
        useRouteError: () => new AnonymousErrorResponse(),
        useRouteLoaderData: (routeId: string) =>
          routeId === "root" ? { apiKey: "test-key" } : undefined,
      };
    });

    vi.resetModules();
    const { ErrorBoundary } = await import("../app");

    const html = renderToString(createElement(ErrorBoundary));

    expect(html).toContain("Handling response");
  });

  it("renders data for real ErrorResponseImpl with status 200", async () => {
    const bounceError = new UNSAFE_ErrorResponseImpl(
      200,
      "OK",
      "<script>bounce</script>"
    );

    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>(
        "react-router"
      );
      return {
        ...actual,
        useRouteError: () => bounceError,
        useRouteLoaderData: (routeId: string) =>
          routeId === "root" ? { apiKey: "test-key" } : undefined,
      };
    });

    vi.resetModules();
    const { ErrorBoundary } = await import("../app");

    const html = renderToString(createElement(ErrorBoundary));

    expect(html).toContain("bounce");
  });

  it("delegates status 401 ErrorResponseImpl to boundary.error (auth flow)", async () => {
    const mockBoundaryError = vi.fn().mockReturnValue(null);

    vi.doMock("@shopify/shopify-app-react-router/server", async () => {
      const actual = await vi.importActual<
        typeof import("@shopify/shopify-app-react-router/server")
      >("@shopify/shopify-app-react-router/server");
      return {
        ...actual,
        boundary: {
          ...actual.boundary,
          error: mockBoundaryError,
        },
      };
    });

    const reauthError = new UNSAFE_ErrorResponseImpl(
      401,
      "Unauthorized",
      "<b>x</b>"
    );

    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>(
        "react-router"
      );
      return {
        ...actual,
        useRouteError: () => reauthError,
        useRouteLoaderData: (routeId: string) =>
          routeId === "root" ? { apiKey: "test-key" } : undefined,
      };
    });

    vi.resetModules();
    const { ErrorBoundary } = await import("../app");

    renderToString(createElement(ErrorBoundary));

    expect(mockBoundaryError).toHaveBeenCalledWith(reauthError);
  });

  it("renders in-app fallback for 404 route error response", async () => {
    const notFoundError = {
      status: 404,
      statusText: "Not Found",
      internal: false,
      data: "Page not found",
    };

    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>(
        "react-router"
      );
      return {
        ...actual,
        useRouteError: () => notFoundError,
        useRouteLoaderData: (routeId: string) =>
          routeId === "root" ? { apiKey: "test-key" } : undefined,
        useNavigate: () => vi.fn(),
      };
    });

    vi.resetModules();
    const { ErrorBoundary } = await import("../app");

    const html = renderToString(createElement(ErrorBoundary));

    expect(html).toContain("s-page");
    expect(html).toContain("Something went wrong");
    expect(html).toContain('href="/app"');
  });

  it("delegates status 200 with non-string data to boundary.error", async () => {
    const mockBoundaryError = vi.fn().mockReturnValue(null);

    vi.doMock("@shopify/shopify-app-react-router/server", async () => {
      const actual = await vi.importActual<
        typeof import("@shopify/shopify-app-react-router/server")
      >("@shopify/shopify-app-react-router/server");
      return {
        ...actual,
        boundary: {
          ...actual.boundary,
          error: mockBoundaryError,
        },
      };
    });

    const nonStringDataError = {
      status: 200,
      statusText: "OK",
      internal: false,
      data: { message: "object data" },
    };

    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>(
        "react-router"
      );
      return {
        ...actual,
        useRouteError: () => nonStringDataError,
        useRouteLoaderData: (routeId: string) =>
          routeId === "root" ? { apiKey: "test-key" } : undefined,
      };
    });

    vi.resetModules();
    const { ErrorBoundary } = await import("../app");

    renderToString(createElement(ErrorBoundary));

    expect(mockBoundaryError).toHaveBeenCalledWith(nonStringDataError);
  });

  it("renders in-app fallback for plain Error", async () => {
    const plainError = new Error("Unexpected failure");

    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>(
        "react-router"
      );
      return {
        ...actual,
        useRouteError: () => plainError,
        useRouteLoaderData: (routeId: string) =>
          routeId === "root" ? { apiKey: "test-key" } : undefined,
        useNavigate: () => vi.fn(),
      };
    });

    vi.resetModules();
    const { ErrorBoundary } = await import("../app");

    const html = renderToString(createElement(ErrorBoundary));

    expect(html).toContain("s-page");
    expect(html).toContain("Something went wrong");
    expect(html).not.toContain("Unexpected failure");
  });
});

describe("isRouteErrorResponse structural check", () => {
  it("accepts anonymous class with correct shape", () => {
    const AnonymousErrorResponse = (() =>
      class {
        status = 200;
        statusText = "OK";
        internal = false;
        data = "<html>bounce</html>";
      })();

    const anonymousError = new AnonymousErrorResponse();

    expect(isRouteErrorResponse(anonymousError)).toBe(true);
  });

  it("rejects plain Error", () => {
    const plainError = new Error("test");

    expect(isRouteErrorResponse(plainError)).toBe(false);
  });
});

describe("boundary.error behavior on anonymous class", () => {
  it("boundary.error handles anonymous-class error without throwing", async () => {
    const { boundary } = await import(
      "@shopify/shopify-app-react-router/server"
    );

    const AnonymousErrorResponse = (() =>
      class {
        status = 200;
        statusText = "OK";
        internal = false;
        data = "<script>bounce</script>";
      })();

    const anonymousError = new AnonymousErrorResponse();

    expect(() => boundary.error(anonymousError)).not.toThrow();
  });
});
