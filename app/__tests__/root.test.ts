/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";

const POLARIS_URL = "https://cdn.shopify.com/shopifycloud/polaris-2.js";

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useLoaderData: vi.fn(() => ({
      apiKey: "test-api-key",
      isDevMode: false,
    })),
    useMatches: vi.fn(() => [
      { pathname: "/app", handle: undefined },
    ]),
    useRouteError: vi.fn(() => new Error("Test error")),
    useRouteLoaderData: vi.fn(() => ({
      apiKey: "test-api-key",
      isDevMode: false,
    })),
    isRouteErrorResponse: vi.fn(() => false),
    Links: () => null,
    Meta: () => null,
    Outlet: () => null,
    Scripts: () => null,
    ScrollRestoration: () => null,
  };
});

describe("app/root.tsx preload link for polaris-2.js", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const mockMatch = (pathname: string, handle?: { embedded?: boolean }) => ({
    pathname,
    handle,
    id: "root",
    params: {},
    data: undefined,
    loaderData: undefined,
  });

  it("renders preload link for polaris-2.js when isEmbedded is true (app route)", async () => {
    const reactRouter = await import("react-router");
    vi.mocked(reactRouter.useMatches).mockReturnValue([mockMatch("/app")]);

    const { default: App } = await import("../root");
    const html = renderToString(createElement(App));

    expect(html).toContain('rel="preload"');
    expect(html).toContain('as="script"');
    expect(html).toContain(POLARIS_URL);
  });

  it("renders preload link for polaris-2.js when on /app/ nested route", async () => {
    const reactRouter = await import("react-router");
    vi.mocked(reactRouter.useMatches).mockReturnValue([mockMatch("/app/onboarding")]);

    const { default: App } = await import("../root");
    const html = renderToString(createElement(App));

    expect(html).toContain('rel="preload"');
    expect(html).toContain(POLARIS_URL);
  });

  it("renders preload link when on /auth route", async () => {
    const reactRouter = await import("react-router");
    vi.mocked(reactRouter.useMatches).mockReturnValue([mockMatch("/auth")]);

    const { default: App } = await import("../root");
    const html = renderToString(createElement(App));

    expect(html).toContain('rel="preload"');
    expect(html).toContain(POLARIS_URL);
  });

  it("does NOT render preload link when isEmbedded is false (public route)", async () => {
    const reactRouter = await import("react-router");
    vi.mocked(reactRouter.useMatches).mockReturnValue([mockMatch("/privacy")]);

    const { default: App } = await import("../root");
    const html = renderToString(createElement(App));

    expect(html).not.toContain('rel="preload"');
    expect(html).not.toContain(POLARIS_URL);
  });

  it("does NOT render preload link when handle.embedded is false", async () => {
    const reactRouter = await import("react-router");
    vi.mocked(reactRouter.useMatches).mockReturnValue([mockMatch("/app/public", { embedded: false })]);

    const { default: App } = await import("../root");
    const html = renderToString(createElement(App));

    expect(html).not.toContain('rel="preload"');
    expect(html).not.toContain(POLARIS_URL);
  });

  it("preload link has correct URL matching AppProvider polaris script", async () => {
    const reactRouter = await import("react-router");
    vi.mocked(reactRouter.useMatches).mockReturnValue([mockMatch("/app")]);

    const { default: App } = await import("../root");
    const html = renderToString(createElement(App));

    const preloadLinkRegex = /<link[^>]*rel="preload"[^>]*href="([^"]*)"[^>]*>/;
    const match = html.match(preloadLinkRegex);
    
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(POLARIS_URL);
  });

  it("preload link appears in head section", async () => {
    const reactRouter = await import("react-router");
    vi.mocked(reactRouter.useMatches).mockReturnValue([mockMatch("/app")]);

    const { default: App } = await import("../root");
    const html = renderToString(createElement(App));

    const headEndIndex = html.indexOf("</head>");
    const bodyStartIndex = html.indexOf("<body");
    const preloadIndex = html.indexOf(`href="${POLARIS_URL}"`);

    expect(preloadIndex).toBeLessThan(headEndIndex);
    expect(preloadIndex).toBeLessThan(bodyStartIndex);
  });
});
