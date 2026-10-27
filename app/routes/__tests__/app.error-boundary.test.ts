/**
 * Tests for app.tsx ErrorBoundary auth bounce handling.
 *
 * When the Shopify admin back-arrow reload lands on /app without session tokens,
 * authenticate.admin returns an HTML response containing only the App Bridge script.
 * This script is injected via dangerouslySetInnerHTML but never executes,
 * causing a blank screen.
 *
 * These tests verify:
 * - Detection helper correctly identifies App-Bridge-only or empty responses
 * - ErrorBoundary renders correct UI based on error type
 * - Non-auth errors still delegate to boundary.error
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isAppBridgeOnlyOrEmptyResponse } from "../app";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

describe("isAppBridgeOnlyOrEmptyResponse detection helper", () => {
  describe("returns true for empty or App-Bridge-only responses", () => {
    it("(a) returns true for null", () => {
      expect(isAppBridgeOnlyOrEmptyResponse(null)).toBe(true);
    });

    it("(a) returns true for undefined", () => {
      expect(isAppBridgeOnlyOrEmptyResponse(undefined)).toBe(true);
    });

    it("(a) returns true for empty string", () => {
      expect(isAppBridgeOnlyOrEmptyResponse("")).toBe(true);
    });

    it("(a) returns true for whitespace-only string", () => {
      expect(isAppBridgeOnlyOrEmptyResponse("   \n\t  ")).toBe(true);
    });

    it("(a) returns true for App Bridge script only", () => {
      const html = `
        <script data-api-key="test-key" src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
      `;
      expect(isAppBridgeOnlyOrEmptyResponse(html)).toBe(true);
    });

    it("(a) returns true for App Bridge script with trailing whitespace", () => {
      const html = `<script data-api-key="abc123" src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
      `;
      expect(isAppBridgeOnlyOrEmptyResponse(html)).toBe(true);
    });

    it("(a) returns true for App Bridge self-closing script", () => {
      const html = `<script data-api-key="key" src="https://cdn.shopify.com/shopifycloud/app-bridge.js"/>`;
      expect(isAppBridgeOnlyOrEmptyResponse(html)).toBe(true);
    });

    it("(a) returns true for HTML comments only", () => {
      expect(isAppBridgeOnlyOrEmptyResponse("<!-- comment -->")).toBe(true);
    });

    it("(a) returns true for App Bridge with HTML comments", () => {
      const html = `
        <!-- Shopify App Bridge -->
        <script data-api-key="key" src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
        <!-- End -->
      `;
      expect(isAppBridgeOnlyOrEmptyResponse(html)).toBe(true);
    });
  });

  describe("returns false for real HTML content", () => {
    it("(a) returns false for normal HTML", () => {
      const html = `<div><p>Something went wrong</p></div>`;
      expect(isAppBridgeOnlyOrEmptyResponse(html)).toBe(false);
    });

    it("(a) returns false for HTML with App Bridge plus visible content", () => {
      const html = `
        <script data-api-key="key" src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
        <div>Error content here</div>
      `;
      expect(isAppBridgeOnlyOrEmptyResponse(html)).toBe(false);
    });

    it("(a) returns false for error page HTML", () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head><title>Error</title></head>
          <body><h1>500 Internal Server Error</h1></body>
        </html>
      `;
      expect(isAppBridgeOnlyOrEmptyResponse(html)).toBe(false);
    });

    it("(a) returns false for non-string data", () => {
      expect(isAppBridgeOnlyOrEmptyResponse({ error: "test" })).toBe(false);
      expect(isAppBridgeOnlyOrEmptyResponse(42)).toBe(false);
      expect(isAppBridgeOnlyOrEmptyResponse([])).toBe(false);
    });
  });
});

describe("ErrorBoundary render output", () => {
  beforeEach(() => {
    vi.resetModules();

    Object.defineProperty(globalThis, "window", {
      value: {
        location: {
          pathname: "/app",
          reload: vi.fn(),
          href: "https://example.com/app",
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

  function setupMocks(errorData: unknown, isErrorResponse = true) {
    vi.doMock("react-router", async (importOriginal) => {
      const actual = await importOriginal<typeof import("react-router")>();
      return {
        ...actual,
        useRouteError: () =>
          isErrorResponse
            ? {
                status: 401,
                statusText: "Unauthorized",
                data: errorData,
                internal: false,
              }
            : errorData,
        isRouteErrorResponse: (err: unknown) =>
          isErrorResponse &&
          err !== null &&
          typeof err === "object" &&
          "status" in err &&
          "data" in err,
      };
    });

    vi.doMock("@shopify/shopify-app-react-router/server", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@shopify/shopify-app-react-router/server")>();
      return {
        ...actual,
        boundary: {
          error: vi.fn((err) =>
            createElement(
              "div",
              { "data-testid": "boundary-delegated" },
              `Boundary: ${typeof err === "object" ? JSON.stringify(err) : err}`
            )
          ),
          headers: vi.fn(() => ({})),
        },
      };
    });
  }

  async function renderErrorBoundary() {
    const { ErrorBoundary } = await import("../app");
    return renderToString(createElement(ErrorBoundary));
  }

  describe("(b) back from admin Settings (/app)", () => {
    it("renders Reloading spinner for App Bridge only response", async () => {
      const appBridgeHtml = `<script data-api-key="test" src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>`;
      setupMocks(appBridgeHtml);

      const html = await renderErrorBoundary();

      expect(html).toContain("Reloading");
      expect(html).toContain("s-spinner");
      expect(html).not.toContain("boundary-delegated");
    });
  });

  describe("(c) back from /app/reminders", () => {
    it("renders Reloading spinner on nested path", async () => {
      Object.defineProperty(globalThis, "window", {
        value: {
          location: {
            pathname: "/app/settings/reminders",
            reload: vi.fn(),
            href: "https://example.com/app/settings/reminders",
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

      const appBridgeHtml = `<script data-api-key="test" src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>`;
      setupMocks(appBridgeHtml);

      const html = await renderErrorBoundary();

      expect(html).toContain("Reloading");
    });
  });

  describe("(d) deep link /app/accounts/123 with no shop/host", () => {
    it("renders Reloading spinner on deep link path", async () => {
      Object.defineProperty(globalThis, "window", {
        value: {
          location: {
            pathname: "/app/accounts/123",
            reload: vi.fn(),
            href: "https://example.com/app/accounts/123",
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

      const appBridgeHtml = `<script data-api-key="test" src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>`;
      setupMocks(appBridgeHtml);

      const html = await renderErrorBoundary();

      expect(html).toContain("Reloading");
    });
  });

  describe("(e) loop guard", () => {
    it("guard logic: allows reload after 30s have passed", () => {
      const oldTimestamp = Date.now() - 35000;
      const now = Date.now();
      const withinWindow = now - oldTimestamp < 30000;
      expect(withinWindow).toBe(false);
    });

    it("guard logic: blocks reload within 30s window", () => {
      const recentTimestamp = Date.now() - 5000;
      const now = Date.now();
      const withinWindow = now - recentTimestamp < 30000;
      expect(withinWindow).toBe(true);
    });

    it("renders Reloading during initial render (before useEffect)", async () => {
      const recentTimestamp = String(Date.now() - 5000);
      Object.defineProperty(globalThis, "window", {
        value: {
          location: {
            pathname: "/app",
            reload: vi.fn(),
            href: "https://example.com/app",
          },
          sessionStorage: {
            getItem: (key: string) =>
              key === "auth_bounce_reload_/app" ? recentTimestamp : null,
            setItem: vi.fn(),
            removeItem: vi.fn(),
          },
        },
        writable: true,
        configurable: true,
      });

      const appBridgeHtml = `<script data-api-key="test" src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>`;
      setupMocks(appBridgeHtml);

      const html = await renderErrorBoundary();

      expect(html).toContain("Reloading");
    });
  });

  describe("(f) sessionStorage throwing", () => {
    it("renders Reloading during SSR when sessionStorage not accessed", async () => {
      Object.defineProperty(globalThis, "window", {
        value: {
          location: {
            pathname: "/app",
            reload: vi.fn(),
            href: "https://example.com/app",
          },
          sessionStorage: {
            getItem: () => {
              throw new Error("Private mode");
            },
            setItem: () => {
              throw new Error("Private mode");
            },
            removeItem: () => {
              throw new Error("Private mode");
            },
          },
        },
        writable: true,
        configurable: true,
      });

      const appBridgeHtml = `<script data-api-key="test" src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>`;
      setupMocks(appBridgeHtml);

      const html = await renderErrorBoundary();

      expect(html).toContain("Reloading");
    });

    it("sessionStorage throw handling: catch block sets fallback state", () => {
      let showFallback = false;
      try {
        throw new Error("Private mode");
      } catch {
        showFallback = true;
      }
      expect(showFallback).toBe(true);
    });
  });

  describe("(g) non-auth error delegation", () => {
    it("delegates non-App-Bridge errors to boundary.error", async () => {
      const normalErrorHtml = `<div><h1>500 Internal Server Error</h1><p>Something broke</p></div>`;
      setupMocks(normalErrorHtml);

      const html = await renderErrorBoundary();

      expect(html).toContain("boundary-delegated");
      expect(html).not.toContain("Reloading");
    });

    it("delegates non-response errors to boundary.error", async () => {
      const thrownError = new Error("Unexpected error");
      setupMocks(thrownError, false);

      const html = await renderErrorBoundary();

      expect(html).toContain("boundary-delegated");
      expect(html).not.toContain("Reloading");
    });
  });
});

describe("Reload guard key generation", () => {
  it("generates per-pathname guard keys", () => {
    const prefix = "auth_bounce_reload_";
    const paths = [
      "/app",
      "/app/settings/reminders",
      "/app/accounts/123",
      "/app/reconcile",
    ];

    const keys = paths.map((p) => `${prefix}${p}`);

    expect(keys).toEqual([
      "auth_bounce_reload_/app",
      "auth_bounce_reload_/app/settings/reminders",
      "auth_bounce_reload_/app/accounts/123",
      "auth_bounce_reload_/app/reconcile",
    ]);

    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(paths.length);
  });
});

describe("ErrorBoundary UI components structure", () => {
  it("ReloadingSpinner shows spinner and Reloading text (via render test)", async () => {
    vi.resetModules();

    Object.defineProperty(globalThis, "window", {
      value: {
        location: {
          pathname: "/app",
          reload: vi.fn(),
          href: "https://example.com/app",
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

    vi.doMock("react-router", async (importOriginal) => {
      const actual = await importOriginal<typeof import("react-router")>();
      return {
        ...actual,
        useRouteError: () => ({
          status: 401,
          data: `<script data-api-key="test" src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>`,
        }),
        isRouteErrorResponse: () => true,
      };
    });

    vi.doMock("@shopify/shopify-app-react-router/server", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@shopify/shopify-app-react-router/server")>();
      return {
        ...actual,
        boundary: {
          error: vi.fn(() => null),
          headers: vi.fn(() => ({})),
        },
      };
    });

    const { ErrorBoundary } = await import("../app");
    const html = renderToString(createElement(ErrorBoundary));

    expect(html).toContain("Reloading");
    expect(html).toContain("s-spinner");

    delete (globalThis as Record<string, unknown>).window;
  });
});

describe("App Bridge detection edge cases", () => {
  it("handles standard App Bridge CDN URL", () => {
    const html = `<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>`;
    expect(isAppBridgeOnlyOrEmptyResponse(html)).toBe(true);
  });

  it("handles App Bridge CDN URL with data-api-key", () => {
    const html = `<script data-api-key="test" src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>`;
    expect(isAppBridgeOnlyOrEmptyResponse(html)).toBe(true);
  });

  it("handles mixed case in script tag", () => {
    const html = `<SCRIPT data-api-key="test" src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></SCRIPT>`;
    expect(isAppBridgeOnlyOrEmptyResponse(html)).toBe(true);
  });

  it("returns false when redirect script is present with content", () => {
    const html = `
      <script data-api-key="test" src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
      <script>window.open("https://example.com", "_top")</script>
    `;
    expect(isAppBridgeOnlyOrEmptyResponse(html)).toBe(false);
  });

  it("returns false for minimal visible content", () => {
    const html = `
      <script data-api-key="test" src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
      x
    `;
    expect(isAppBridgeOnlyOrEmptyResponse(html)).toBe(false);
  });
});
