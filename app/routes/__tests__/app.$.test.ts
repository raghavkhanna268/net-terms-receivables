import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for F9 catch-all route (app/routes/app.$.tsx).
 *
 * Verifies the route returns 404 and renders not-found content
 * with a link back to /app.
 */

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { headers: vi.fn(() => ({})) },
}));

describe("Catch-all Route (app.$)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("loader throws 404 response", async () => {
    const { loader } = await import("../app.$");
    const request = new Request("https://test-app.example/app/unknown-page");

    let thrownData: { init?: { status?: number } } | null = null;
    try {
      await loader({
        request,
        context: {} as never,
        params: { "*": "unknown-page" },
        url: new URL(request.url),
        pattern: "/app/*",
      });
    } catch (e) {
      thrownData = e as { init?: { status?: number } };
    }

    expect(thrownData).not.toBeNull();
    expect(thrownData?.init?.status).toBe(404);
  });

  it("ErrorBoundary renders not-found content", async () => {
    const { ErrorBoundary } = await import("../app.$");

    const result = ErrorBoundary();

    expect(result).toBeDefined();
    expect(result.type).toBe("s-page");
    expect(result.props.heading).toBe("Page not found");

    const section = result.props.children;
    expect(section.type).toBe("s-section");

    const emptyState = section.props.children;
    expect(emptyState.type).toBe("s-empty-state");
    expect(emptyState.props.heading).toBe("Page not found");
  });

  it("ErrorBoundary contains s-button with href to /app", async () => {
    const { ErrorBoundary } = await import("../app.$");

    const result = ErrorBoundary();

    const section = result.props.children;
    const emptyState = section.props.children;
    const children = emptyState.props.children;

    const buttonChild = Array.isArray(children)
      ? children.find((c: { type?: string }) => c?.type === "s-button")
      : children?.type === "s-button"
      ? children
      : null;

    expect(buttonChild).toBeTruthy();
    expect(buttonChild.type).toBe("s-button");
    expect(buttonChild.props.variant).toBe("primary");
    expect(buttonChild.props.href).toBe("/app");
    expect(buttonChild.props.children).toContain("app home");
  });
});
