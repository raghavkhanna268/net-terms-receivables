/**
 * RouteErrorBoundary unit tests.
 *
 * Tests:
 * (a) Thrown Error renders generic message and /app link; raw error NOT in output
 * (b) 404 route error response shows "Page not found"
 * (c) 200 auth redirect (route error response with HTML data) is re-thrown
 * (d) Source-level test: every app child route in inventory exports ErrorBoundary
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import * as fs from "fs";
import * as path from "path";

const mockUseRouteError = vi.fn();
const mockIsRouteErrorResponse = vi.fn();

vi.mock("react-router", () => ({
  useRouteError: () => mockUseRouteError(),
  isRouteErrorResponse: (error: unknown) => mockIsRouteErrorResponse(error),
}));

import { RouteErrorBoundary } from "../RouteErrorBoundary";

describe("RouteErrorBoundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRouteErrorResponse.mockReturnValue(false);
  });

  describe("(a) Thrown Error renders generic message", () => {
    it("shows generic message for Error objects", () => {
      const secretMessage = "INTERNAL_SECRET_ERROR_MESSAGE_XYZ123";
      const error = new Error(secretMessage);
      mockUseRouteError.mockReturnValue(error);
      mockIsRouteErrorResponse.mockReturnValue(false);

      const html = renderToString(createElement(RouteErrorBoundary));

      expect(html).toContain("Something went wrong");
      expect(html).toContain("Something went wrong loading this page.");
      expect(html).not.toContain(secretMessage);
      expect(html).not.toContain("INTERNAL");
      expect(html).not.toContain("SECRET");
    });

    it("includes link back to dashboard", () => {
      mockUseRouteError.mockReturnValue(new Error("test error"));
      mockIsRouteErrorResponse.mockReturnValue(false);

      const html = renderToString(createElement(RouteErrorBoundary));

      expect(html).toContain('href="/app"');
      expect(html).toContain("Back to Dashboard");
    });

    it("never exposes stack trace", () => {
      const error = new Error("test");
      error.stack = "Error: test\n    at SECRET_FUNCTION (/secret/path.ts:123:45)";
      mockUseRouteError.mockReturnValue(error);
      mockIsRouteErrorResponse.mockReturnValue(false);

      const html = renderToString(createElement(RouteErrorBoundary));

      expect(html).not.toContain("stack");
      expect(html).not.toContain("SECRET_FUNCTION");
      expect(html).not.toContain("/secret/path");
    });

    it("renders with Polaris components", () => {
      mockUseRouteError.mockReturnValue(new Error("test"));
      mockIsRouteErrorResponse.mockReturnValue(false);

      const html = renderToString(createElement(RouteErrorBoundary));

      expect(html).toContain("<s-page");
      expect(html).toContain("<s-section");
      expect(html).toContain("<s-banner");
      expect(html).toContain('tone="critical"');
      expect(html).toContain("<s-link");
    });
  });

  describe("(b) 404 route error response", () => {
    it("shows 'Page not found' for 404 status", () => {
      const routeError = { status: 404, data: null, statusText: "Not Found" };
      mockUseRouteError.mockReturnValue(routeError);
      mockIsRouteErrorResponse.mockReturnValue(true);

      const html = renderToString(createElement(RouteErrorBoundary));

      expect(html).toContain("Page not found");
      expect(html).toContain("The page you are looking for could not be found.");
      expect(html).toContain('href="/app"');
    });

    it("shows status code for non-404 route errors", () => {
      const routeError = { status: 500, data: null, statusText: "Internal Server Error" };
      mockUseRouteError.mockReturnValue(routeError);
      mockIsRouteErrorResponse.mockReturnValue(true);

      const html = renderToString(createElement(RouteErrorBoundary));

      expect(html).toContain("Error 500");
      expect(html).toContain("Something went wrong loading this page.");
    });

    it("does not expose route error data field", () => {
      const secretData = "SECRET_INTERNAL_DATA_RESPONSE";
      const routeError = { status: 400, data: secretData, statusText: "Bad Request" };
      mockUseRouteError.mockReturnValue(routeError);
      mockIsRouteErrorResponse.mockReturnValue(true);

      const html = renderToString(createElement(RouteErrorBoundary));

      expect(html).not.toContain(secretData);
      expect(html).not.toContain("SECRET");
    });
  });

  describe("(c) Auth redirect re-throw", () => {
    it("re-throws 200 status route error with string data (auth redirect)", () => {
      const authRedirectHtml = '<html><script>redirect()</script></html>';
      const routeError = { status: 200, data: authRedirectHtml, statusText: "OK" };
      mockUseRouteError.mockReturnValue(routeError);
      mockIsRouteErrorResponse.mockReturnValue(true);

      expect(() => {
        renderToString(createElement(RouteErrorBoundary));
      }).toThrow();
    });

    it("does not re-throw 200 status with non-string data", () => {
      const routeError = { status: 200, data: { some: "object" }, statusText: "OK" };
      mockUseRouteError.mockReturnValue(routeError);
      mockIsRouteErrorResponse.mockReturnValue(true);

      expect(() => {
        renderToString(createElement(RouteErrorBoundary));
      }).not.toThrow();

      const html = renderToString(createElement(RouteErrorBoundary));
      expect(html).toContain("Error 200");
    });

    it("does not re-throw non-200 status even with string data", () => {
      const routeError = { status: 400, data: "some string error", statusText: "Bad Request" };
      mockUseRouteError.mockReturnValue(routeError);
      mockIsRouteErrorResponse.mockReturnValue(true);

      expect(() => {
        renderToString(createElement(RouteErrorBoundary));
      }).not.toThrow();

      const html = renderToString(createElement(RouteErrorBoundary));
      expect(html).toContain("Error 400");
    });
  });
});

describe("(d) App route ErrorBoundary coverage", () => {
  const ROUTES_DIR = path.join(__dirname, "../../routes");

  const ROUTES_WITH_EXISTING_BOUNDARY = new Set([
    "app.tsx",
    "app.$.tsx",
    "app.onboarding.tsx",
  ]);

  const ROUTES_EXEMPT_FROM_BOUNDARY = new Set([
    "app.tsx",
  ]);

  it("all app.*.tsx child routes export ErrorBoundary", () => {
    const routeFiles = fs
      .readdirSync(ROUTES_DIR)
      .filter((f) => f.startsWith("app.") && f.endsWith(".tsx") && !f.includes("test"));

    const missing: string[] = [];

    for (const routeFile of routeFiles) {
      if (ROUTES_EXEMPT_FROM_BOUNDARY.has(routeFile)) {
        continue;
      }

      const content = fs.readFileSync(path.join(ROUTES_DIR, routeFile), "utf-8");

      const hasDefaultExport = /export\s+default\s+/.test(content);
      if (!hasDefaultExport && routeFile !== "app.data-requests.$id.download.tsx") {
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
      `App child routes missing ErrorBoundary export: ${missing.join(", ")}. ` +
        `Add \`export { RouteErrorBoundary as ErrorBoundary } from "~/components/RouteErrorBoundary"\` to each.`
    ).toHaveLength(0);
  });

  it("routes with existing boundaries are preserved", () => {
    for (const routeFile of ROUTES_WITH_EXISTING_BOUNDARY) {
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
