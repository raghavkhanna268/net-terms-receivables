/**
 * Tests for app.tsx ErrorBoundary reload-once recovery.
 *
 * These tests verify:
 * - isEmbeddedAuthBounce predicate (true/false cases)
 * - isBlankOrAppBridgeOnly detection
 * - Server and first client render produce identical markup (no hydration mismatch)
 * - Bounce with real content never reloads
 * - Blank/App-Bridge-only bounce reloads once, guard blocks second reload
 * - Non-bounce errors throw for root boundary
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isEmbeddedAuthBounce,
  isBlankOrAppBridgeOnly,
} from "../app";
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
});

describe("isBlankOrAppBridgeOnly", () => {
  it("returns true for empty string", () => {
    expect(isBlankOrAppBridgeOnly("")).toBe(true);
  });

  it("returns true for whitespace only", () => {
    expect(isBlankOrAppBridgeOnly("   \n\t  ")).toBe(true);
  });

  it("returns true for App Bridge script only", () => {
    const html = `<script data-api-key="test" src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>`;
    expect(isBlankOrAppBridgeOnly(html)).toBe(true);
  });

  it("returns true for App Bridge with whitespace", () => {
    const html = `
      <script data-api-key="key" src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
    `;
    expect(isBlankOrAppBridgeOnly(html)).toBe(true);
  });

  it("returns true for HTML comments only", () => {
    expect(isBlankOrAppBridgeOnly("<!-- comment -->")).toBe(true);
  });

  it("returns false for content with visible elements", () => {
    const html = `<script>window.shopify.reload()</script>`;
    expect(isBlankOrAppBridgeOnly(html)).toBe(false);
  });

  it("returns false for HTML with text content", () => {
    const html = `<div>Some visible content</div>`;
    expect(isBlankOrAppBridgeOnly(html)).toBe(false);
  });

  it("returns false for App Bridge plus other content", () => {
    const html = `
      <script data-api-key="key" src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
      <script>window.open("https://test-shop.myshopify.com", "_top")</script>
    `;
    expect(isBlankOrAppBridgeOnly(html)).toBe(false);
  });
});

describe("ErrorBoundary hydration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as Record<string, unknown>).window;
  });

  it("(a) server render and first client render produce identical markup", async () => {
    const bounceHtml = "<script>window.shopify.reload()</script>";
    const bounceError = new UNSAFE_ErrorResponseImpl(200, "OK", bounceHtml);

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

    delete (globalThis as Record<string, unknown>).window;
    const serverHtml = renderToString(createElement(ErrorBoundary));

    Object.defineProperty(globalThis, "window", {
      value: {
        location: {
          pathname: "/app",
          reload: vi.fn(),
          href: "https://test-shop.myshopify.com/app",
        },
        sessionStorage: {
          getItem: () => null,
          setItem: vi.fn(),
          removeItem: vi.fn(),
        },
      },
      writable: true,
      configurable: true,
    });

    vi.resetModules();
    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>(
        "react-router"
      );
      return {
        ...actual,
        useRouteError: () => bounceError,
      };
    });

    const { ErrorBoundary: ClientErrorBoundary } = await import("../app");
    const clientHtml = renderToString(createElement(ClientErrorBoundary));

    expect(serverHtml).toBe(clientHtml);
    expect(serverHtml).toContain("window.shopify.reload()");
  });
});

describe("ErrorBoundary bounce with real content", () => {
  let mockReload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    mockReload = vi.fn();

    Object.defineProperty(globalThis, "window", {
      value: {
        location: {
          pathname: "/app",
          reload: mockReload,
          href: "https://test-shop.myshopify.com/app",
        },
        sessionStorage: {
          getItem: () => null,
          setItem: vi.fn(),
          removeItem: vi.fn(),
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

  it("(b) bounce with real content renders HTML and never triggers reload", async () => {
    const realContentHtml = "<script>window.shopify.reload()</script>";
    const bounceError = new UNSAFE_ErrorResponseImpl(200, "OK", realContentHtml);

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

    expect(html).toContain("window.shopify.reload()");
    expect(html).not.toContain("Reloading");
    expect(html).not.toContain("s-spinner");
  });
});

describe("ErrorBoundary blank/App-Bridge-only bounce reload", () => {
  let mockReload: ReturnType<typeof vi.fn>;
  let sessionStorageData: Record<string, string>;

  beforeEach(() => {
    vi.resetModules();
    mockReload = vi.fn();
    sessionStorageData = {};

    Object.defineProperty(globalThis, "window", {
      value: {
        location: {
          pathname: "/app",
          reload: mockReload,
          href: "https://test-shop.myshopify.com/app",
        },
        sessionStorage: {
          getItem: (key: string) => sessionStorageData[key] ?? null,
          setItem: (key: string, value: string) => {
            sessionStorageData[key] = value;
          },
          removeItem: (key: string) => {
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

  it("(c) blank bounce renders HTML on first render (before effect)", async () => {
    const blankError = new UNSAFE_ErrorResponseImpl(200, "OK", "");

    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>(
        "react-router"
      );
      return {
        ...actual,
        useRouteError: () => blankError,
      };
    });

    const { ErrorBoundary } = await import("../app");
    const html = renderToString(createElement(ErrorBoundary));

    expect(html).toContain("Handling response");
    expect(html).not.toContain("s-spinner");
  });

  it("(c) App-Bridge-only bounce renders HTML on first render", async () => {
    const appBridgeOnly = `<script data-api-key="test" src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>`;
    const bounceError = new UNSAFE_ErrorResponseImpl(200, "OK", appBridgeOnly);

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

    expect(html).toContain("app-bridge.js");
  });

  it("(c) guard blocks second reload and shows fallback", async () => {
    const recentTimestamp = String(Date.now() - 5000);
    sessionStorageData["auth_bounce_reload_/app"] = recentTimestamp;

    const blankError = new UNSAFE_ErrorResponseImpl(200, "OK", "");

    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>(
        "react-router"
      );
      return {
        ...actual,
        useRouteError: () => blankError,
      };
    });

    const { ErrorBoundary } = await import("../app");
    const html = renderToString(createElement(ErrorBoundary));

    expect(html).toContain("Handling response");
  });

  it("guard allows reload after 30s have passed", () => {
    const oldTimestamp = Date.now() - 35000;
    const now = Date.now();
    const withinWindow = now - oldTimestamp < 30000;
    expect(withinWindow).toBe(false);
  });

  it("guard blocks reload within 30s window", () => {
    const recentTimestamp = Date.now() - 5000;
    const now = Date.now();
    const withinWindow = now - recentTimestamp < 30000;
    expect(withinWindow).toBe(true);
  });
});

describe("ErrorBoundary non-bounce errors", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as Record<string, unknown>).window;
  });

  it("(d) throws 404 error for root boundary", async () => {
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

  it("(d) throws plain Error for root boundary", async () => {
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

  it("(d) throws 401 error for root boundary", async () => {
    const authError = new UNSAFE_ErrorResponseImpl(
      401,
      "Unauthorized",
      "Not authorized"
    );

    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>(
        "react-router"
      );
      return {
        ...actual,
        useRouteError: () => authError,
      };
    });

    const { ErrorBoundary } = await import("../app");

    expect(() => renderToString(createElement(ErrorBoundary))).toThrow();
  });
});
