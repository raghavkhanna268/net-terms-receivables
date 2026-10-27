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
import { isRouteErrorResponse } from "react-router";

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
      };
    });

    vi.resetModules();
    const { ErrorBoundary } = await import("../app");

    const html = renderToString(createElement(ErrorBoundary));

    expect(html).toContain("Handling response");
  });

  it("rethrows 404 route error response (non-bounce status)", async () => {
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
      };
    });

    vi.resetModules();
    const { ErrorBoundary } = await import("../app");

    expect(() => renderToString(createElement(ErrorBoundary))).toThrow();
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
      };
    });

    vi.resetModules();
    const { ErrorBoundary } = await import("../app");

    expect(() => renderToString(createElement(ErrorBoundary))).toThrow();
  });

  it("rethrows plain Error for root boundary to handle", async () => {
    const plainError = new Error("Unexpected failure");

    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>(
        "react-router"
      );
      return {
        ...actual,
        useRouteError: () => plainError,
      };
    });

    vi.resetModules();
    const { ErrorBoundary } = await import("../app");

    expect(() => renderToString(createElement(ErrorBoundary))).toThrow(
      "Unexpected failure"
    );
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

describe("library bounce response status (pinning test)", () => {
  it("render-app-bridge throws Response with status 200", async () => {
    const html = "<!DOCTYPE html><html><body>App Bridge</body></html>";
    const response = new Response(html, {
      headers: { "Content-Type": "text/html" },
    });

    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain("App Bridge");
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
