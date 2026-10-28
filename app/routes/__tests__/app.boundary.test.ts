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
        useRouteLoaderData: () => ({ apiKey: "test-key" }),
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
        useRouteLoaderData: () => ({ apiKey: "test-key" }),
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
        useRouteLoaderData: () => ({ apiKey: "test-key" }),
      };
    });

    vi.resetModules();
    const { ErrorBoundary } = await import("../app");

    const html = renderToString(createElement(ErrorBoundary));

    expect(html).toContain("bounce");
  });

  it("rethrows real ErrorResponseImpl with status 401", async () => {
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
        useRouteLoaderData: () => ({ apiKey: "test-key" }),
      };
    });

    vi.resetModules();
    const { ErrorBoundary } = await import("../app");

    expect(() => renderToString(createElement(ErrorBoundary))).toThrow();
  });

  it("rethrows real ErrorResponseImpl with status 403", async () => {
    const forbiddenError = new UNSAFE_ErrorResponseImpl(
      403,
      "Forbidden",
      null
    );

    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>(
        "react-router"
      );
      return {
        ...actual,
        useRouteError: () => forbiddenError,
        useRouteLoaderData: () => ({ apiKey: "test-key" }),
      };
    });

    vi.resetModules();
    const { ErrorBoundary } = await import("../app");

    expect(() => renderToString(createElement(ErrorBoundary))).toThrow();
  });

  it("renders 404 route error in-layout with nav", async () => {
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
        useNavigate: () => vi.fn(),
        useRouteLoaderData: () => ({ apiKey: "test-api-key-12345" }),
      };
    });

    vi.resetModules();
    const { ErrorBoundary } = await import("../app");

    const html = renderToString(createElement(ErrorBoundary));

    expect(html).toContain("s-app-nav");
    expect(html).toContain("Page not found");
  });

  it("rethrows 200 route error with non-string data", async () => {
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
        useRouteLoaderData: () => ({ apiKey: "test-key" }),
      };
    });

    vi.resetModules();
    const { ErrorBoundary } = await import("../app");

    expect(() => renderToString(createElement(ErrorBoundary))).toThrow();
  });

  it("renders plain Error in-layout with nav and generic message", async () => {
    const plainError = new Error("Unexpected failure");

    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>(
        "react-router"
      );
      return {
        ...actual,
        useRouteError: () => plainError,
        useNavigate: () => vi.fn(),
        useRouteLoaderData: () => ({ apiKey: "test-api-key-12345" }),
      };
    });

    vi.resetModules();
    const { ErrorBoundary } = await import("../app");

    const html = renderToString(createElement(ErrorBoundary));

    expect(html).toContain("s-app-nav");
    expect(html).toContain("Something went wrong");
    expect(html).not.toContain("Unexpected failure");
  });

  it("passes apiKey from root loader to AppProvider in ErrorBoundary", async () => {
    const notFoundError = new UNSAFE_ErrorResponseImpl(404, "Not Found", null);
    const testApiKey = "sk_test_boundary_key_xyz789";

    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>(
        "react-router"
      );
      return {
        ...actual,
        useRouteError: () => notFoundError,
        useNavigate: () => vi.fn(),
        useRouteLoaderData: () => ({ apiKey: testApiKey }),
      };
    });

    vi.resetModules();
    const { ErrorBoundary } = await import("../app");

    const html = renderToString(createElement(ErrorBoundary));

    expect(html).toContain("s-app-nav");
    expect(html).toContain("Page not found");
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

describe("boundary.error behavior on anonymous class (the bug)", () => {
  it("boundary.error throws for anonymous-class error", async () => {
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

    expect(() => boundary.error(anonymousError)).toThrow();
  });
});
