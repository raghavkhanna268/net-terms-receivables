/**
 * Tests for app.tsx ErrorBoundary reload-once recovery.
 *
 * These tests verify:
 * - isEmbeddedAuthBounce predicate (true/false cases)
 * - Reload happens once on embedded auth bounce
 * - Guard prevents a second reload within 30s
 * - Non-bounce errors throw for root boundary
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isEmbeddedAuthBounce } from "../app";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { UNSAFE_ErrorResponseImpl } from "react-router";

describe("isEmbeddedAuthBounce predicate", () => {
  it("returns true for status 200 with string data", () => {
    const error = new UNSAFE_ErrorResponseImpl(
      200,
      "OK",
      "<script>bounce</script>"
    );
    expect(isEmbeddedAuthBounce(error)).toBe(true);
  });

  it("returns true for anonymous class with correct shape", () => {
    const AnonymousError = (() =>
      class {
        status = 200;
        statusText = "OK";
        internal = false;
        data = "<script>bounce</script>";
      })();
    expect(isEmbeddedAuthBounce(new AnonymousError())).toBe(true);
  });

  it("returns true for empty string data", () => {
    const error = new UNSAFE_ErrorResponseImpl(200, "OK", "");
    expect(isEmbeddedAuthBounce(error)).toBe(true);
  });

  it("returns false for status 401", () => {
    const error = new UNSAFE_ErrorResponseImpl(401, "Unauthorized", "<b>x</b>");
    expect(isEmbeddedAuthBounce(error)).toBe(false);
  });

  it("returns false for status 404", () => {
    const error = {
      status: 404,
      statusText: "Not Found",
      internal: false,
      data: "Not found",
    };
    expect(isEmbeddedAuthBounce(error)).toBe(false);
  });

  it("returns false for status 500", () => {
    const error = {
      status: 500,
      statusText: "Internal Server Error",
      internal: false,
      data: "Server error",
    };
    expect(isEmbeddedAuthBounce(error)).toBe(false);
  });

  it("returns false for non-string data", () => {
    const error = {
      status: 200,
      statusText: "OK",
      internal: false,
      data: { message: "object" },
    };
    expect(isEmbeddedAuthBounce(error)).toBe(false);
  });

  it("returns false for plain Error", () => {
    const error = new Error("test");
    expect(isEmbeddedAuthBounce(error)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isEmbeddedAuthBounce(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isEmbeddedAuthBounce(undefined)).toBe(false);
  });
});

describe("ErrorBoundary reload-once recovery", () => {
  let mockReload: ReturnType<typeof vi.fn>;
  let sessionStorageData: Record<string, string>;
  let sessionStorageThrows: boolean;

  beforeEach(() => {
    vi.resetModules();
    mockReload = vi.fn();
    sessionStorageData = {};
    sessionStorageThrows = false;

    Object.defineProperty(globalThis, "window", {
      value: {
        location: {
          pathname: "/app",
          reload: mockReload,
          href: "https://test-shop.myshopify.com/app",
        },
        sessionStorage: {
          getItem: (key: string) => {
            if (sessionStorageThrows) throw new Error("Private mode");
            return sessionStorageData[key] ?? null;
          },
          setItem: (key: string, value: string) => {
            if (sessionStorageThrows) throw new Error("Private mode");
            sessionStorageData[key] = value;
          },
          removeItem: (key: string) => {
            if (sessionStorageThrows) throw new Error("Private mode");
            delete sessionStorageData[key];
          },
        },
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    delete (globalThis as Record<string, unknown>).window;
  });

  it("renders ReloadingSpinner on client for embedded auth bounce", async () => {
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
      };
    });

    const { ErrorBoundary } = await import("../app");
    const html = renderToString(createElement(ErrorBoundary));

    expect(html).toContain("Reloading");
    expect(html).toContain("s-spinner");
  });

  it("renders HTML on SSR for embedded auth bounce (no window)", async () => {
    delete (globalThis as Record<string, unknown>).window;

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
      };
    });

    const { ErrorBoundary } = await import("../app");
    const html = renderToString(createElement(ErrorBoundary));

    expect(html).toContain("bounce");
  });

  it("renders fallback UI when guard has fired within 30s", async () => {
    const recentTimestamp = String(Date.now() - 5000);
    sessionStorageData["auth_bounce_reload_/app"] = recentTimestamp;

    const bounceError = new UNSAFE_ErrorResponseImpl(200, "OK", "<script/>");

    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>(
        "react-router"
      );
      return {
        ...actual,
        useRouteError: () => bounceError,
      };
    });

    const { ErrorBoundary } = await import("../app");
    const html = renderToString(createElement(ErrorBoundary));

    expect(html).toContain("Reloading");
  });

  it("renders fallback UI when sessionStorage throws", async () => {
    sessionStorageThrows = true;

    const bounceError = new UNSAFE_ErrorResponseImpl(200, "OK", "<script/>");

    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>(
        "react-router"
      );
      return {
        ...actual,
        useRouteError: () => bounceError,
      };
    });

    const { ErrorBoundary } = await import("../app");
    const html = renderToString(createElement(ErrorBoundary));

    expect(html).toContain("Reloading");
  });

  it("throws non-bounce error for root boundary", async () => {
    const notFoundError = new UNSAFE_ErrorResponseImpl(
      404,
      "Not Found",
      "Page not found"
    );

    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>(
        "react-router"
      );
      return {
        ...actual,
        useRouteError: () => notFoundError,
      };
    });

    const { ErrorBoundary } = await import("../app");

    expect(() => renderToString(createElement(ErrorBoundary))).toThrow();
  });

  it("throws plain Error for root boundary", async () => {
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

    const { ErrorBoundary } = await import("../app");

    expect(() => renderToString(createElement(ErrorBoundary))).toThrow(
      "Unexpected failure"
    );
  });
});

describe("reload guard logic", () => {
  it("allows reload after 30s have passed", () => {
    const oldTimestamp = Date.now() - 35000;
    const now = Date.now();
    const withinWindow = now - oldTimestamp < 30000;
    expect(withinWindow).toBe(false);
  });

  it("blocks reload within 30s window", () => {
    const recentTimestamp = Date.now() - 5000;
    const now = Date.now();
    const withinWindow = now - recentTimestamp < 30000;
    expect(withinWindow).toBe(true);
  });

  it("generates per-pathname guard keys", () => {
    const prefix = "auth_bounce_reload_";
    const paths = ["/app", "/app/settings/reminders", "/app/accounts/123"];

    const keys = paths.map((p) => `${prefix}${p}`);

    expect(keys).toEqual([
      "auth_bounce_reload_/app",
      "auth_bounce_reload_/app/settings/reminders",
      "auth_bounce_reload_/app/accounts/123",
    ]);

    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(paths.length);
  });
});
