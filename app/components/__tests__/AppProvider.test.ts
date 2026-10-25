/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToString } from "react-dom/server";
import React, { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

/**
 * Tests for custom AppProvider component.
 *
 * Verifies:
 * 1. AppProvider renders Polaris script but NOT app-bridge.js script
 * 2. AppProvider handles shopify:navigate events correctly
 *
 * This test would FAIL against the upstream @shopify/shopify-app-react-router
 * AppProvider, which always injects app-bridge.js. Our custom AppProvider
 * intentionally omits this since app-bridge.js is loaded in <head> by root.tsx.
 */

function mockReactRouter() {
  const navigateMock = vi.fn();
  vi.doMock("react-router", async (importOriginal) => {
    const actual = await importOriginal<typeof import("react-router")>();
    return {
      ...actual,
      useNavigate: () => navigateMock,
    };
  });
  return navigateMock;
}

describe("AppProvider", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("react-router");
  });

  describe("script rendering", () => {
    it("does NOT render app-bridge.js script", async () => {
      mockReactRouter();
      const { AppProvider } = await import("../AppProvider");

      const child = createElement("div", null, "Test content");
      const html = renderToString(
        // eslint-disable-next-line react/no-children-prop
        createElement(AppProvider as React.FC<{ apiKey: string; children: React.ReactNode }>, {
          apiKey: "test-api-key",
          children: child,
        })
      );

      expect(html).not.toContain("app-bridge.js");
      expect(html).not.toContain("shopifycloud/app-bridge");
    });

    it("DOES render Polaris script", async () => {
      mockReactRouter();
      const { AppProvider } = await import("../AppProvider");

      const child = createElement("div", null, "Test content");
      const html = renderToString(
        // eslint-disable-next-line react/no-children-prop
        createElement(AppProvider as React.FC<{ apiKey: string; children: React.ReactNode }>, {
          apiKey: "test-api-key",
          children: child,
        })
      );

      expect(html).toContain("polaris-2.js");
      expect(html).toContain("cdn.shopify.com/shopifycloud/polaris");
    });

    it("renders children content", async () => {
      mockReactRouter();
      const { AppProvider } = await import("../AppProvider");

      const child = createElement("div", { "data-testid": "child" }, "Test content");
      const html = renderToString(
        // eslint-disable-next-line react/no-children-prop
        createElement(AppProvider as React.FC<{ apiKey: string; children: React.ReactNode }>, {
          apiKey: "test-api-key",
          children: child,
        })
      );

      expect(html).toContain("Test content");
      expect(html).toContain("data-testid");
    });

    it("accepts custom polarisUrl", async () => {
      mockReactRouter();
      const { AppProvider } = await import("../AppProvider");

      const customUrl = "https://cdn.shopify.com/shopifycloud/polaris-1.js";
      const child = createElement("div", null, "Test");
      const html = renderToString(
        // eslint-disable-next-line react/no-children-prop
        createElement(
          AppProvider as React.FC<{ apiKey: string; polarisUrl: string; children: React.ReactNode }>,
          { apiKey: "test-api-key", polarisUrl: customUrl, children: child }
        )
      );

      expect(html).toContain(customUrl);
    });
  });

  describe("contrast with upstream AppProvider", () => {
    it("upstream AppProvider WOULD render app-bridge.js (documented behavior)", async () => {
      // This test documents the behavior difference.
      // The upstream AppProvider at node_modules/@shopify/shopify-app-react-router/
      // src/react/components/AppProvider/AppProvider.tsx lines 70-76, 103-106
      // always renders: <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" />
      //
      // Our custom AppProvider intentionally does NOT render this script
      // because app-bridge.js is already loaded in <head> by root.tsx.
      // This prevents the duplicate script tag issue.

      mockReactRouter();
      const { AppProvider } = await import("../AppProvider");

      const child = createElement("div", null, "Test");
      const html = renderToString(
        // eslint-disable-next-line react/no-children-prop
        createElement(AppProvider as React.FC<{ apiKey: string; children: React.ReactNode }>, {
          apiKey: "test-api-key",
          children: child,
        })
      );

      // Our custom provider should NOT have app-bridge
      expect(html).not.toContain("app-bridge.js");

      // It should have Polaris
      expect(html).toContain("polaris");
    });
  });
});

describe("AppProvider shopify:navigate handler (jsdom)", () => {
  let navigateMock: ReturnType<typeof vi.fn>;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.resetModules();
    navigateMock = mockReactRouter();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.doUnmock("react-router");
    if (root) {
      act(() => {
        root.unmount();
      });
    }
    document.body.removeChild(container);
  });

  it("calls navigate(href) when shopify:navigate event is dispatched on element with href", async () => {
    expect.assertions(2);

    const { AppProvider } = await import("../AppProvider");

    const targetElement = createElement("div", {
      id: "nav-target",
      href: "/app/test-destination",
    });

    root = createRoot(container);
    await act(async () => {
      // eslint-disable-next-line react/no-children-prop
      root.render(createElement(AppProvider as React.FC<{ apiKey: string; children: React.ReactNode }>, {
        apiKey: "test-key",
        children: targetElement,
      }));
    });

    const target = document.getElementById("nav-target")!;
    target.setAttribute("href", "/app/test-destination");

    const event = new Event("shopify:navigate", { bubbles: true });
    Object.defineProperty(event, "target", { value: target, writable: false });

    await act(async () => {
      document.dispatchEvent(event);
    });

    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith("/app/test-destination");
  });

  it("does NOT call navigate when target element has no href", async () => {
    expect.assertions(1);

    const { AppProvider } = await import("../AppProvider");

    const targetElement = createElement("div", { id: "no-href-target" });

    root = createRoot(container);
    await act(async () => {
      // eslint-disable-next-line react/no-children-prop
      root.render(createElement(AppProvider as React.FC<{ apiKey: string; children: React.ReactNode }>, {
        apiKey: "test-key",
        children: targetElement,
      }));
    });

    const target = document.getElementById("no-href-target")!;

    const event = new Event("shopify:navigate", { bubbles: true });
    Object.defineProperty(event, "target", { value: target, writable: false });

    await act(async () => {
      document.dispatchEvent(event);
    });

    expect(navigateMock).not.toHaveBeenCalled();
  });
});
