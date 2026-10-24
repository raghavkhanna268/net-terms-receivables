import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for auth.login route.
 *
 * App Store compliance: Per Shopify requirement 2.3.1, App Store apps must not
 * request manual entry of a myshopify.com URL or shop domain during installation
 * or configuration. This route handles OAuth redirects from Shopify's managed
 * installation flow but does not render a login form.
 *
 * @see https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements
 */

describe("Auth Login Route", () => {
  let mockShopifyLogin: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockShopifyLogin = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("loader", () => {
    it("redirects to /app when shop is missing (shopify.login returns error)", async () => {
      mockShopifyLogin.mockResolvedValue({ shop: "MissingShop" });

      const mockContext = {
        shopify: {
          login: mockShopifyLogin,
        },
      };

      const { loader } = await import("../auth.login/route");
      const request = new Request("https://example.com/auth/login");

      await expect(
        loader({
          request,
          context: mockContext as never,
          params: {},
          url: new URL(request.url),
          pattern: "/auth/login",
        })
      ).rejects.toMatchObject({
        status: 302,
      });

      try {
        await loader({
          request,
          context: mockContext as never,
          params: {},
          url: new URL(request.url),
          pattern: "/auth/login",
        });
      } catch (response: unknown) {
        const r = response as Response;
        expect(r.headers.get("Location")).toBe("/app");
      }
    });

    it("redirects to /app when shopify.login returns null", async () => {
      mockShopifyLogin.mockResolvedValue(null);

      const mockContext = {
        shopify: {
          login: mockShopifyLogin,
        },
      };

      const { loader } = await import("../auth.login/route");
      const request = new Request("https://example.com/auth/login");

      await expect(
        loader({
          request,
          context: mockContext as never,
          params: {},
          url: new URL(request.url),
          pattern: "/auth/login",
        })
      ).rejects.toMatchObject({
        status: 302,
      });
    });

    it("redirects to /app when shopify.login returns undefined", async () => {
      mockShopifyLogin.mockResolvedValue(undefined);

      const mockContext = {
        shopify: {
          login: mockShopifyLogin,
        },
      };

      const { loader } = await import("../auth.login/route");
      const request = new Request("https://example.com/auth/login");

      await expect(
        loader({
          request,
          context: mockContext as never,
          params: {},
          url: new URL(request.url),
          pattern: "/auth/login",
        })
      ).rejects.toMatchObject({
        status: 302,
      });
    });

    it("calls shopify.login with the request", async () => {
      mockShopifyLogin.mockResolvedValue({ shop: "InvalidShop" });

      const mockContext = {
        shopify: {
          login: mockShopifyLogin,
        },
      };

      const { loader } = await import("../auth.login/route");
      const request = new Request("https://example.com/auth/login?shop=test.myshopify.com");

      try {
        await loader({
          request,
          context: mockContext as never,
          params: {},
          url: new URL(request.url),
          pattern: "/auth/login",
        });
      } catch {
        // Expected redirect
      }

      expect(mockShopifyLogin).toHaveBeenCalledWith(request);
    });
  });

  describe("action", () => {
    it("redirects to /app when shop is missing in POST", async () => {
      mockShopifyLogin.mockResolvedValue({ shop: "MissingShop" });

      const mockContext = {
        shopify: {
          login: mockShopifyLogin,
        },
      };

      const { action } = await import("../auth.login/route");
      const request = new Request("https://example.com/auth/login", {
        method: "POST",
        body: new URLSearchParams({}),
      });

      await expect(
        action({
          request,
          context: mockContext as never,
          params: {},
          url: new URL(request.url),
          pattern: "/auth/login",
        })
      ).rejects.toMatchObject({
        status: 302,
      });

      try {
        await action({
          request,
          context: mockContext as never,
          params: {},
          url: new URL(request.url),
          pattern: "/auth/login",
        });
      } catch (response: unknown) {
        const r = response as Response;
        expect(r.headers.get("Location")).toBe("/app");
      }
    });

    it("redirects to /app when shopify.login returns null in POST", async () => {
      mockShopifyLogin.mockResolvedValue(null);

      const mockContext = {
        shopify: {
          login: mockShopifyLogin,
        },
      };

      const { action } = await import("../auth.login/route");
      const request = new Request("https://example.com/auth/login", {
        method: "POST",
        body: new URLSearchParams({}),
      });

      await expect(
        action({
          request,
          context: mockContext as never,
          params: {},
          url: new URL(request.url),
          pattern: "/auth/login",
        })
      ).rejects.toMatchObject({
        status: 302,
      });
    });
  });

  describe("component", () => {
    it("renders null (no login form UI)", async () => {
      const { default: Auth } = await import("../auth.login/route");
      const result = Auth();
      expect(result).toBeNull();
    });
  });
});
