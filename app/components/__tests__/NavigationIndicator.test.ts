/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

/**
 * Tests for NavigationIndicator component.
 *
 * Verifies:
 * 1. Shows indicator when navigation.state is 'loading' after delay
 * 2. Hides indicator when navigation.state is 'idle'
 * 3. Present under the layout regardless of child route
 * 4. Accessibility attributes (role=status, aria-live, aria-label)
 * 5. CSS fallback for color variable
 * 6. Respects prefers-reduced-motion
 */

let mockNavigationState = { state: "idle" as "idle" | "loading" | "submitting" };

function mockReactRouter() {
  vi.doMock("react-router", async (importOriginal) => {
    const actual = await importOriginal<typeof import("react-router")>();
    return {
      ...actual,
      useNavigation: () => mockNavigationState,
    };
  });
}

describe("NavigationIndicator", () => {
  beforeEach(() => {
    vi.resetModules();
    mockNavigationState = { state: "idle" };
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.doUnmock("react-router");
    vi.useRealTimers();
  });

  describe("server rendering (initial state)", () => {
    it("renders nothing when navigation.state is idle", async () => {
      mockReactRouter();
      mockNavigationState = { state: "idle" };

      const { NavigationIndicator } = await import("../NavigationIndicator");
      const html = renderToString(createElement(NavigationIndicator));

      expect(html).toBe("");
    });

    it("renders nothing initially even when loading (before delay)", async () => {
      mockReactRouter();
      mockNavigationState = { state: "loading" };

      const { NavigationIndicator } = await import("../NavigationIndicator");
      const html = renderToString(createElement(NavigationIndicator));

      expect(html).toBe("");
    });
  });

  describe("client rendering with timer", () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
      container = document.createElement("div");
      document.body.appendChild(container);
    });

    afterEach(() => {
      if (root) {
        act(() => {
          root.unmount();
        });
      }
      document.body.removeChild(container);
    });

    it("shows indicator after 200ms delay when navigation.state is loading", async () => {
      mockReactRouter();
      mockNavigationState = { state: "loading" };

      const { NavigationIndicator } = await import("../NavigationIndicator");

      root = createRoot(container);
      await act(async () => {
        root.render(createElement(NavigationIndicator));
      });

      expect(container.querySelector('[role="status"]')).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      const indicator = container.querySelector('[role="status"]');
      expect(indicator).not.toBeNull();
    });

    it("does not show indicator before 200ms delay", async () => {
      mockReactRouter();
      mockNavigationState = { state: "loading" };

      const { NavigationIndicator } = await import("../NavigationIndicator");

      root = createRoot(container);
      await act(async () => {
        root.render(createElement(NavigationIndicator));
      });

      await act(async () => {
        vi.advanceTimersByTime(150);
      });

      expect(container.querySelector('[role="status"]')).toBeNull();
    });

    it("shows indicator when navigation.state is submitting", async () => {
      mockReactRouter();
      mockNavigationState = { state: "submitting" };

      const { NavigationIndicator } = await import("../NavigationIndicator");

      root = createRoot(container);
      await act(async () => {
        root.render(createElement(NavigationIndicator));
      });

      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      const indicator = container.querySelector('[role="status"]');
      expect(indicator).not.toBeNull();
    });

    it("hides indicator when navigation returns to idle", async () => {
      mockReactRouter();
      mockNavigationState = { state: "loading" };

      const { NavigationIndicator } = await import("../NavigationIndicator");

      root = createRoot(container);
      await act(async () => {
        root.render(createElement(NavigationIndicator));
      });

      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      expect(container.querySelector('[role="status"]')).not.toBeNull();

      mockNavigationState = { state: "idle" };
      await act(async () => {
        root.render(createElement(NavigationIndicator));
      });

      expect(container.querySelector('[role="status"]')).toBeNull();
    });

    it("has correct accessibility attributes including aria-label", async () => {
      mockReactRouter();
      mockNavigationState = { state: "loading" };

      const { NavigationIndicator } = await import("../NavigationIndicator");

      root = createRoot(container);
      await act(async () => {
        root.render(createElement(NavigationIndicator));
      });

      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      const indicator = container.querySelector('[role="status"]');
      expect(indicator).not.toBeNull();
      expect(indicator?.getAttribute("aria-live")).toBe("polite");
      expect(indicator?.getAttribute("aria-label")).toBe("Loading");
    });

    it("uses CSS variable with fallback color in inline style", async () => {
      mockReactRouter();
      mockNavigationState = { state: "loading" };

      const { NavigationIndicator } = await import("../NavigationIndicator");

      root = createRoot(container);
      await act(async () => {
        root.render(createElement(NavigationIndicator));
      });

      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      const bar = container.querySelector(".nav-indicator-bar") as HTMLElement;
      expect(bar).not.toBeNull();
      expect(bar.style.background).toContain("var(--p-color-bg-fill-brand, #303030)");
    });

    it("includes prefers-reduced-motion media query in styles", async () => {
      mockReactRouter();
      mockNavigationState = { state: "loading" };

      const { NavigationIndicator } = await import("../NavigationIndicator");

      root = createRoot(container);
      await act(async () => {
        root.render(createElement(NavigationIndicator));
      });

      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      const styleElement = container.querySelector("style");
      expect(styleElement).not.toBeNull();
      const styleContent = styleElement?.textContent || "";
      expect(styleContent).toContain("@media (prefers-reduced-motion: reduce)");
      expect(styleContent).toContain("animation: none");
    });

    it("has fixed positioning at top", async () => {
      mockReactRouter();
      mockNavigationState = { state: "loading" };

      const { NavigationIndicator } = await import("../NavigationIndicator");

      root = createRoot(container);
      await act(async () => {
        root.render(createElement(NavigationIndicator));
      });

      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      const indicator = container.querySelector('[role="status"]') as HTMLElement;
      expect(indicator).not.toBeNull();
      expect(indicator.style.position).toBe("fixed");
      expect(indicator.style.top).toBe("0px");
    });
  });

  describe("layout integration", () => {
    it("can be rendered as sibling of any child route content", async () => {
      mockReactRouter();
      mockNavigationState = { state: "idle" };

      const { NavigationIndicator } = await import("../NavigationIndicator");

      const layout = createElement(
        "div",
        { "data-testid": "layout" },
        createElement(NavigationIndicator),
        createElement("div", { "data-testid": "child-route" }, "Page content")
      );

      const html = renderToString(layout);

      expect(html).toContain('data-testid="layout"');
      expect(html).toContain('data-testid="child-route"');
      expect(html).toContain("Page content");
    });
  });
});
