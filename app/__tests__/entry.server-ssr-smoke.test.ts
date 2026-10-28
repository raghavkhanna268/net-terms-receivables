/**
 * SSR smoke tests for entry.server streaming renderer.
 *
 * Verifies:
 * 1. The streaming renderer from react-dom/server.browser works correctly
 * 2. isbot path waits for allReady before returning (for search engine crawlers)
 * 3. Normal path streams immediately without waiting for allReady
 * 4. Both /privacy (resource route) and /app (SSR route) paths render with 200
 *
 * Uses the REAL entry.server module with renderToReadableStream mocked.
 * The mock tracks whether allReady was awaited to verify streaming behavior.
 *
 * Parallel lane: uses synthetic data only, no database required.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactNode } from "react";

vi.mock("~/lib/sentry", () => ({
  captureExceptionWithTags: vi.fn(),
}));

let _allReadyResolved = false;
let allReadyAwaited = false;
const streamContent = "<html><head></head><body><div data-testid='app-shell'>App Shell</div></body></html>";

vi.mock("react-dom/server.browser", () => ({
  renderToReadableStream: vi.fn(async (_element: ReactNode) => {
    _allReadyResolved = false;
    allReadyAwaited = false;

    const allReadyPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        _allReadyResolved = true;
        resolve();
      }, 10);
    });

    const trackedAllReady = allReadyPromise.then(() => {
      allReadyAwaited = true;
    });

    return {
      allReady: trackedAllReady,
      getReader: () => ({
        read: async () => {
          const encoder = new TextEncoder();
          return {
            done: false,
            value: encoder.encode(streamContent),
          };
        },
      }),
      [Symbol.asyncIterator]: async function* () {
        yield new TextEncoder().encode(streamContent);
      },
    } as unknown as ReadableStream & { allReady: Promise<void> };
  }),
}));

describe("entry.server SSR smoke tests", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    _allReadyResolved = false;
    allReadyAwaited = false;
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  async function callHandleRequest(options: {
    url: string;
    userAgent?: string;
  }) {
    const entryServer = await import("../entry.server");

    const request = new Request(options.url, {
      headers: options.userAgent
        ? { "user-agent": options.userAgent }
        : undefined,
    });
    const responseHeaders = new Headers();
    const reactRouterContext = {
      staticHandlerContext: {
        loaderData: {},
        actionData: null,
        errors: null,
        matches: [
          {
            route: { id: "root" },
            params: {},
            pathname: "/app",
          },
        ],
      },
      manifest: {
        routes: {},
        entry: { imports: [], module: "" },
        url: "",
        version: "",
      },
      routeModules: {},
      future: {},
      ssr: true,
      isSpaMode: false,
      routeDiscovery: { mode: "initial", manifestPath: "/__manifest" },
      branches: [],
    };
    const loadContext = {
      shopify: { addDocumentResponseHeaders: vi.fn() },
    };

    return entryServer.default(
      request,
      200,
      responseHeaders,
      reactRouterContext as unknown as Parameters<
        typeof entryServer.default
      >[3],
      loadContext as unknown as Parameters<typeof entryServer.default>[4]
    );
  }

  describe("streaming behavior", () => {
    it("waits for allReady when user-agent is bot (Googlebot)", async () => {
      const response = await callHandleRequest({
        url: "https://test-shop.example.com/app",
        userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      });

      expect(response.status).toBe(200);
      expect(allReadyAwaited).toBe(true);
    });

    it("waits for allReady when user-agent is bot (Bingbot)", async () => {
      const response = await callHandleRequest({
        url: "https://test-shop.example.com/app",
        userAgent: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
      });

      expect(response.status).toBe(200);
      expect(allReadyAwaited).toBe(true);
    });

    it("streams immediately (does not wait for allReady) for normal browser user-agent", async () => {
      const response = await callHandleRequest({
        url: "https://test-shop.example.com/app",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      });

      expect(response.status).toBe(200);
      expect(allReadyAwaited).toBe(false);
    });

    it("streams immediately when no user-agent header is present", async () => {
      const response = await callHandleRequest({
        url: "https://test-shop.example.com/app",
      });

      expect(response.status).toBe(200);
      expect(allReadyAwaited).toBe(false);
    });
  });

  describe("/app route SSR render", () => {
    it("returns 200 status for /app route", async () => {
      const response = await callHandleRequest({
        url: "https://test-shop.example.com/app",
        userAgent: "Mozilla/5.0 Chrome/120",
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/html");
    });

    it("returns 200 status for /app nested routes", async () => {
      const response = await callHandleRequest({
        url: "https://test-shop.example.com/app/accounts/123",
        userAgent: "Mozilla/5.0 Chrome/120",
      });

      expect(response.status).toBe(200);
    });
  });
});

describe("/privacy resource route", () => {
  it("returns 200 with expected HTML markers", async () => {
    const { loader } = await import("~/routes/privacy");

    const url = new URL("https://test-shop.example.com/privacy");
    const response = await loader({
      request: new Request(url),
      params: {},
      context: {} as never,
      url,
      pattern: "/privacy",
    } as Parameters<typeof loader>[0]);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");

    const html = await response.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html lang=\"en\">");
    expect(html).toContain("Privacy Policy");
    expect(html).toContain("</html>");
  });

  it("sets cache headers for public caching", async () => {
    const { loader } = await import("~/routes/privacy");

    const url = new URL("https://test-shop.example.com/privacy");
    const response = await loader({
      request: new Request(url),
      params: {},
      context: {} as never,
      url,
      pattern: "/privacy",
    } as Parameters<typeof loader>[0]);

    expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
  });
});
