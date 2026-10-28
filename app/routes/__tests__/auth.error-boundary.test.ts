/**
 * Tests for auth.$.tsx ErrorBoundary handling of route error responses.
 *
 * The Shopify library's boundary.error checks constructor.name, which fails
 * for minified/anonymous error classes in the client bundle. This boundary
 * uses React Router's isRouteErrorResponse (duck-typing) plus an explicit
 * status === 200 check to handle only the embedded re-auth bounce case.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { UNSAFE_ErrorResponseImpl } from "react-router";

describe("auth.$.tsx ErrorBoundary", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders data for 200 string error in HTML", async () => {
    const bounceError = new UNSAFE_ErrorResponseImpl(
      200,
      "OK",
      "<script>window.shopify.reload()</script>"
    );

    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>(
        "react-router"
      );
      return {
        ...actual,
        useRouteError: () => bounceError,
      };
    });

    vi.resetModules();
    const { ErrorBoundary } = await import("../auth.$");

    const html = renderToString(createElement(ErrorBoundary));

    expect(html).toContain("window.shopify.reload()");
  });

  it("rethrows 401 RouteErrorResponse", async () => {
    const unauthorizedError = new UNSAFE_ErrorResponseImpl(
      401,
      "Unauthorized",
      "Access denied"
    );

    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>(
        "react-router"
      );
      return {
        ...actual,
        useRouteError: () => unauthorizedError,
      };
    });

    vi.resetModules();
    const { ErrorBoundary } = await import("../auth.$");

    expect(() => renderToString(createElement(ErrorBoundary))).toThrow();
  });

  it("rethrows 410 RouteErrorResponse", async () => {
    const goneError = new UNSAFE_ErrorResponseImpl(410, "Gone", "Resource gone");

    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>(
        "react-router"
      );
      return {
        ...actual,
        useRouteError: () => goneError,
      };
    });

    vi.resetModules();
    const { ErrorBoundary } = await import("../auth.$");

    expect(() => renderToString(createElement(ErrorBoundary))).toThrow();
  });

  it("rethrows 500 RouteErrorResponse", async () => {
    const serverError = new UNSAFE_ErrorResponseImpl(
      500,
      "Internal Server Error",
      "Server failed"
    );

    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>(
        "react-router"
      );
      return {
        ...actual,
        useRouteError: () => serverError,
      };
    });

    vi.resetModules();
    const { ErrorBoundary } = await import("../auth.$");

    expect(() => renderToString(createElement(ErrorBoundary))).toThrow();
  });

  it("rethrows plain Error", async () => {
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
    const { ErrorBoundary } = await import("../auth.$");

    expect(() => renderToString(createElement(ErrorBoundary))).toThrow(
      "Unexpected failure"
    );
  });

  it("rethrows 200 with non-string data", async () => {
    const nonStringDataError = new UNSAFE_ErrorResponseImpl(200, "OK", {
      message: "object data",
    });

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
    const { ErrorBoundary } = await import("../auth.$");

    expect(() => renderToString(createElement(ErrorBoundary))).toThrow();
  });
});
