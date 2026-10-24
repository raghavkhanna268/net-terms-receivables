import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for landing page route (_index/route.tsx).
 *
 * App Store compliance: Per Shopify requirement 2.3.1, App Store apps must not
 * request manual entry of a myshopify.com URL or shop domain during installation
 * or configuration.
 *
 * @see https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements
 */

describe("Landing Page Loader (_index)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("redirects to /app when shop param is present", async () => {
    const { loader } = await import("../_index/route");
    const request = new Request(
      "https://example.com/?shop=test-store.myshopify.com&host=abc123"
    );

    const response = await loader({
      request,
      context: {} as never,
      params: {},
      url: new URL(request.url),
      pattern: "/",
    }).catch((r: Response) => r);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    expect((response as Response).headers.get("Location")).toBe(
      "/app?shop=test-store.myshopify.com&host=abc123"
    );
  });

  it("returns null when no shop param (landing page view)", async () => {
    const { loader } = await import("../_index/route");
    const request = new Request("https://example.com/");

    const result = await loader({
      request,
      context: {} as never,
      params: {},
      url: new URL(request.url),
      pattern: "/",
    });

    expect(result).toBeNull();
  });

  it("does not depend on shopify.login context (no form)", async () => {
    const { loader } = await import("../_index/route");
    const request = new Request("https://example.com/");

    // Per App Store requirement 2.3.1: no shop domain form.
    // Loader should work without any shopify context, unlike the old version
    // that called context.shopify.login to determine showForm.
    const result = await loader({
      request,
      context: {} as never, // Empty context - no shopify.login
      params: {},
      url: new URL(request.url),
      pattern: "/",
    });

    expect(result).toBeNull();
  });

  it("preserves all query params in redirect", async () => {
    const { loader } = await import("../_index/route");
    const request = new Request(
      "https://example.com/?shop=test-store.myshopify.com&host=abc123&locale=en"
    );

    const response = await loader({
      request,
      context: {} as never,
      params: {},
      url: new URL(request.url),
      pattern: "/",
    }).catch((r: Response) => r);

    expect(response).toBeInstanceOf(Response);
    const location = (response as Response).headers.get("Location");
    expect(location).toContain("shop=test-store.myshopify.com");
    expect(location).toContain("host=abc123");
    expect(location).toContain("locale=en");
  });
});

describe("Landing Page Headers", () => {
  it("sets public cache headers (no private user content)", async () => {
    const { headers } = await import("../_index/route");
    const result = headers({} as never) as Record<string, string>;
    expect(result["Cache-Control"]).toBe("public, max-age=300");
  });
});
