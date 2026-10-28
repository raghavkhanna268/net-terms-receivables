/**
 * RouteErrorBoundary unit tests.
 *
 * Tests:
 * (a) Thrown Error renders generic message and /app link; raw error NOT in output
 * (b) Route error responses: 404, 401, 403, 500, 200 with object data
 * (c) 200 auth redirect (route error response with HTML data) is re-thrown (same object identity)
 * (d) Two-way coverage: routes WITH default export must have ErrorBoundary;
 *     routes WITHOUT default export must NOT have ErrorBoundary
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import * as fs from "fs";
import * as path from "path";
import { isRouteErrorResponse } from "react-router";

const mockUseRouteError = vi.fn();

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useRouteError: () => mockUseRouteError(),
  };
});

import { RouteErrorBoundary } from "../RouteErrorBoundary";

interface RouteErrorResponse {
  status: number;
  statusText: string;
  data: unknown;
  internal: boolean;
}

function createRouteErrorResponse(
  status: number,
  data: unknown,
  statusText = ""
): RouteErrorResponse {
  return {
    status,
    statusText,
    data,
    internal: true,
  };
}

describe("RouteErrorBoundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("(a) Thrown Error renders generic message", () => {
    it("shows generic message for Error objects", () => {
      const secretMessage = "INTERNAL_SECRET_ERROR_MESSAGE_XYZ123";
      const error = new Error(secretMessage);
      mockUseRouteError.mockReturnValue(error);

      const html = renderToString(createElement(RouteErrorBoundary));

      expect(html).toContain("Something went wrong");
      expect(html).toContain("Something went wrong loading this page.");
      expect(html).not.toContain(secretMessage);
      expect(html).not.toContain("INTERNAL");
      expect(html).not.toContain("SECRET");
      expect(html).not.toMatch(/Error \d{3}/);
    });

    it("includes link back to dashboard", () => {
      mockUseRouteError.mockReturnValue(new Error("test error"));

      const html = renderToString(createElement(RouteErrorBoundary));

      expect(html).toContain('href="/app"');
      expect(html).toContain("Back to Dashboard");
    });

    it("never exposes stack trace", () => {
      const error = new Error("test");
      error.stack = "Error: test\n    at SECRET_FUNCTION (/secret/path.ts:123:45)";
      mockUseRouteError.mockReturnValue(error);

      const html = renderToString(createElement(RouteErrorBoundary));

      expect(html).not.toContain("stack");
      expect(html).not.toContain("SECRET_FUNCTION");
      expect(html).not.toContain("/secret/path");
      expect(html).not.toMatch(/Error \d{3}/);
    });

    it("renders with Polaris components", () => {
      mockUseRouteError.mockReturnValue(new Error("test"));

      const html = renderToString(createElement(RouteErrorBoundary));

      expect(html).toContain("<s-page");
      expect(html).toContain("<s-section");
      expect(html).toContain("<s-banner");
      expect(html).toContain('tone="critical"');
      expect(html).toContain("<s-link");
    });
  });

  describe("(b) Route error responses", () => {
    it("404 shows 'Page not found'", () => {
      const routeError = createRouteErrorResponse(404, null, "Not Found");
      mockUseRouteError.mockReturnValue(routeError);
      expect(isRouteErrorResponse(routeError)).toBe(true);

      const html = renderToString(createElement(RouteErrorBoundary));

      expect(html).toContain("Page not found");
      expect(html).toContain("The page you are looking for could not be found.");
      expect(html).toContain('href="/app"');
      expect(html).not.toMatch(/Error \d{3}/);
    });

    it("401 shows 'Reconnecting to Shopify…'", () => {
      const routeError = createRouteErrorResponse(401, null, "Unauthorized");
      mockUseRouteError.mockReturnValue(routeError);
      expect(isRouteErrorResponse(routeError)).toBe(true);

      const html = renderToString(createElement(RouteErrorBoundary));

      expect(html).toContain("Reconnecting to Shopify…");
      expect(html).toContain("Please wait while we reconnect your session.");
      expect(html).not.toMatch(/Error \d{3}/);
    });

    it("403 shows 'Access denied'", () => {
      const routeError = createRouteErrorResponse(403, null, "Forbidden");
      mockUseRouteError.mockReturnValue(routeError);
      expect(isRouteErrorResponse(routeError)).toBe(true);

      const html = renderToString(createElement(RouteErrorBoundary));

      expect(html).toContain("Access denied");
      expect(html).toContain("You don&#x27;t have access to this page.");
      expect(html).not.toMatch(/Error \d{3}/);
    });

    it("500 shows generic message with no status code", () => {
      const routeError = createRouteErrorResponse(500, null, "Internal Server Error");
      mockUseRouteError.mockReturnValue(routeError);
      expect(isRouteErrorResponse(routeError)).toBe(true);

      const html = renderToString(createElement(RouteErrorBoundary));

      expect(html).toContain("Something went wrong");
      expect(html).toContain("Something went wrong loading this page.");
      expect(html).not.toMatch(/Error \d{3}/);
      expect(html).not.toContain("500");
    });

    it("200 with object data shows generic message with no status code", () => {
      const routeError = createRouteErrorResponse(200, { some: "object" }, "OK");
      mockUseRouteError.mockReturnValue(routeError);
      expect(isRouteErrorResponse(routeError)).toBe(true);

      const html = renderToString(createElement(RouteErrorBoundary));

      expect(html).toContain("Something went wrong");
      expect(html).toContain("Something went wrong loading this page.");
      expect(html).not.toMatch(/Error \d{3}/);
      expect(html).not.toContain("200");
    });

    it("does not expose route error data field", () => {
      const secretData = "SECRET_INTERNAL_DATA_RESPONSE";
      const routeError = createRouteErrorResponse(400, secretData, "Bad Request");
      mockUseRouteError.mockReturnValue(routeError);

      const html = renderToString(createElement(RouteErrorBoundary));

      expect(html).not.toContain(secretData);
      expect(html).not.toContain("SECRET");
      expect(html).not.toMatch(/Error \d{3}/);
    });
  });

  describe("(c) Auth redirect re-throw", () => {
    it("re-throws SAME 200 status route error object with string data (identity check)", () => {
      const authRedirectHtml = '<html><script>redirect()</script></html>';
      const routeError = createRouteErrorResponse(200, authRedirectHtml, "OK");
      mockUseRouteError.mockReturnValue(routeError);
      expect(isRouteErrorResponse(routeError)).toBe(true);

      let thrownError: unknown;
      try {
        renderToString(createElement(RouteErrorBoundary));
      } catch (e) {
        thrownError = e;
      }

      expect(thrownError).toBe(routeError);
    });

    it("does not re-throw 200 status with non-string data", () => {
      const routeError = createRouteErrorResponse(200, { some: "object" }, "OK");
      mockUseRouteError.mockReturnValue(routeError);

      expect(() => {
        renderToString(createElement(RouteErrorBoundary));
      }).not.toThrow();
    });

    it("does not re-throw non-200 status even with string data", () => {
      const routeError = createRouteErrorResponse(400, "some string error", "Bad Request");
      mockUseRouteError.mockReturnValue(routeError);

      expect(() => {
        renderToString(createElement(RouteErrorBoundary));
      }).not.toThrow();
    });
  });
});

describe("(d) App route ErrorBoundary coverage (two-way)", () => {
  const ROUTES_DIR = path.join(__dirname, "../../routes");

  const ROUTES_WITH_INLINE_BOUNDARY = new Set([
    "app.tsx",
    "app.$.tsx",
    "app.onboarding.tsx",
  ]);

  it("routes WITH default export must export ErrorBoundary (except app.tsx)", () => {
    const routeFiles = fs
      .readdirSync(ROUTES_DIR)
      .filter((f) => f.startsWith("app.") && f.endsWith(".tsx") && !f.includes("test"));

    const missing: string[] = [];

    for (const routeFile of routeFiles) {
      if (routeFile === "app.tsx") {
        continue;
      }

      const content = fs.readFileSync(path.join(ROUTES_DIR, routeFile), "utf-8");
      const hasDefaultExport = /export\s+default\s+/.test(content);

      if (!hasDefaultExport) {
        continue;
      }

      const hasErrorBoundaryExport =
        /export\s+(function|const)\s+ErrorBoundary/.test(content) ||
        /export\s*\{[^}]*ErrorBoundary[^}]*\}/.test(content);

      if (!hasErrorBoundaryExport) {
        missing.push(routeFile);
      }
    }

    expect(
      missing,
      `App child routes WITH default export missing ErrorBoundary: ${missing.join(", ")}. ` +
        `Add \`export { RouteErrorBoundary as ErrorBoundary } from "~/components/RouteErrorBoundary"\` to each.`
    ).toHaveLength(0);
  });

  it("routes WITHOUT default export must NOT export ErrorBoundary", () => {
    const routeFiles = fs
      .readdirSync(ROUTES_DIR)
      .filter((f) => f.startsWith("app.") && f.endsWith(".tsx") && !f.includes("test"));

    const shouldNotHave: string[] = [];

    for (const routeFile of routeFiles) {
      const content = fs.readFileSync(path.join(ROUTES_DIR, routeFile), "utf-8");
      const hasDefaultExport = /export\s+default\s+/.test(content);

      if (hasDefaultExport) {
        continue;
      }

      const hasErrorBoundaryExport =
        /export\s+(function|const)\s+ErrorBoundary/.test(content) ||
        /export\s*\{[^}]*ErrorBoundary[^}]*\}/.test(content);

      if (hasErrorBoundaryExport) {
        shouldNotHave.push(routeFile);
      }
    }

    expect(
      shouldNotHave,
      `App routes WITHOUT default export should NOT export ErrorBoundary: ${shouldNotHave.join(", ")}. ` +
        `Resource routes (no default export) must not have ErrorBoundary to remain resource routes.`
    ).toHaveLength(0);
  });

  it("routes with inline boundaries are preserved", () => {
    for (const routeFile of ROUTES_WITH_INLINE_BOUNDARY) {
      const filePath = path.join(ROUTES_DIR, routeFile);
      if (!fs.existsSync(filePath)) {
        continue;
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const hasInlineErrorBoundary = /export\s+function\s+ErrorBoundary/.test(content);

      expect(
        hasInlineErrorBoundary,
        `${routeFile} should have its own inline ErrorBoundary function (not a re-export)`
      ).toBe(true);
    }
  });

  it("app.tsx boundary uses Shopify boundary helper", () => {
    const content = fs.readFileSync(path.join(ROUTES_DIR, "app.tsx"), "utf-8");

    expect(content).toContain("isRouteErrorResponse");
    expect(content).toContain("dangerouslySetInnerHTML");
  });
});
