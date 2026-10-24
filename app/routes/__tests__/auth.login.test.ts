import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for auth.login route.
 *
 * App Store compliance: Per Shopify requirement 2.3.1, App Store apps must not
 * request manual entry of a myshopify.com URL or shop domain during installation
 * or configuration. This route handles OAuth redirects from Shopify's managed
 * installation flow but does not render a login form.
 *
 * Redirect loop prevention: When no shop param is present, this route redirects
 * to / (landing page) instead of /app. This avoids a loop where:
 * /auth/login -> /app -> authenticate.admin() -> renderAppBridge() -> /auth/login
 *
 * @see https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements
 * @see node_modules/@shopify/shopify-app-react-router/src/server/authenticate/login/login.ts
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
    it("redirects to / when shop is missing (shopify.login returns error)", async () => {
      mockShopifyLogin.mockResolvedValue({ shop: "MissingShop" });

      const mockContext = {
        shopify: {
          login: mockShopifyLogin,
        },
      };

      const { loader } = await import("../auth.login/route");
      const request = new Request("https://example.com/auth/login");

      const response = await loader({
        request,
        context: mockContext as never,
        params: {},
        url: new URL(request.url),
        pattern: "/auth/login",
      }).catch((r: Response) => r);

      expect(response).toBeInstanceOf(Response);
      expect((response as Response).status).toBe(302);
      expect((response as Response).headers.get("Location")).toBe("/");
    });

    it("redirects to / when shopify.login returns empty object (GET without shop)", async () => {
      // shopify.login() returns {} on GET without shop param
      mockShopifyLogin.mockResolvedValue({});

      const mockContext = {
        shopify: {
          login: mockShopifyLogin,
        },
      };

      const { loader } = await import("../auth.login/route");
      const request = new Request("https://example.com/auth/login");

      const response = await loader({
        request,
        context: mockContext as never,
        params: {},
        url: new URL(request.url),
        pattern: "/auth/login",
      }).catch((r: Response) => r);

      expect(response).toBeInstanceOf(Response);
      expect((response as Response).status).toBe(302);
      expect((response as Response).headers.get("Location")).toBe("/");
    });

    it("redirects to / when shopify.login returns null", async () => {
      mockShopifyLogin.mockResolvedValue(null);

      const mockContext = {
        shopify: {
          login: mockShopifyLogin,
        },
      };

      const { loader } = await import("../auth.login/route");
      const request = new Request("https://example.com/auth/login");

      const response = await loader({
        request,
        context: mockContext as never,
        params: {},
        url: new URL(request.url),
        pattern: "/auth/login",
      }).catch((r: Response) => r);

      expect(response).toBeInstanceOf(Response);
      expect((response as Response).status).toBe(302);
      expect((response as Response).headers.get("Location")).toBe("/");
    });

    it("redirects to / when shopify.login returns undefined", async () => {
      mockShopifyLogin.mockResolvedValue(undefined);

      const mockContext = {
        shopify: {
          login: mockShopifyLogin,
        },
      };

      const { loader } = await import("../auth.login/route");
      const request = new Request("https://example.com/auth/login");

      const response = await loader({
        request,
        context: mockContext as never,
        params: {},
        url: new URL(request.url),
        pattern: "/auth/login",
      }).catch((r: Response) => r);

      expect(response).toBeInstanceOf(Response);
      expect((response as Response).status).toBe(302);
      expect((response as Response).headers.get("Location")).toBe("/");
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

      await expect(
        loader({
          request,
          context: mockContext as never,
          params: {},
          url: new URL(request.url),
          pattern: "/auth/login",
        })
      ).rejects.toBeInstanceOf(Response);

      expect(mockShopifyLogin).toHaveBeenCalledWith(request);
    });
  });

  describe("action", () => {
    it("redirects to / when shop is missing in POST", async () => {
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

      const response = await action({
        request,
        context: mockContext as never,
        params: {},
        url: new URL(request.url),
        pattern: "/auth/login",
      }).catch((r: Response) => r);

      expect(response).toBeInstanceOf(Response);
      expect((response as Response).status).toBe(302);
      expect((response as Response).headers.get("Location")).toBe("/");
    });

    it("redirects to / when shopify.login returns null in POST", async () => {
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

      const response = await action({
        request,
        context: mockContext as never,
        params: {},
        url: new URL(request.url),
        pattern: "/auth/login",
      }).catch((r: Response) => r);

      expect(response).toBeInstanceOf(Response);
      expect((response as Response).status).toBe(302);
      expect((response as Response).headers.get("Location")).toBe("/");
    });
  });

  describe("component", () => {
    it("renders null (no login form UI)", async () => {
      const { default: Auth } = await import("../auth.login/route");
      const result = Auth();
      expect(result).toBeNull();
    });
  });

  describe("redirect loop prevention", () => {
    it("no-shop redirect chain: /auth/login -> / (200), never visits /app or loops", async () => {
      // Simulate the redirect chain when visiting /auth/login without shop param
      // 1. /auth/login with no shop -> redirects to /
      // 2. / with no shop -> returns 200 (landing page)
      // The chain must NOT include /app or revisit /auth/login

      const visitedUrls: string[] = [];
      let currentUrl = "https://example.com/auth/login";
      let maxRedirects = 5; // Safety limit

      while (maxRedirects > 0) {
        visitedUrls.push(new URL(currentUrl).pathname);

        const url = new URL(currentUrl);
        const pathname = url.pathname;

        if (pathname === "/auth/login") {
          // Simulate auth.login loader
          mockShopifyLogin.mockResolvedValue({}); // GET without shop returns {}
          const mockContext = { shopify: { login: mockShopifyLogin } };
          const { loader } = await import("../auth.login/route");
          const request = new Request(currentUrl);

          try {
            await loader({
              request,
              context: mockContext as never,
              params: {},
              url,
              pattern: "/auth/login",
            });
            // If no throw, we're done (shouldn't happen for auth.login)
            break;
          } catch (response: unknown) {
            const r = response as Response;
            if (r.status === 302) {
              currentUrl = new URL(r.headers.get("Location")!, currentUrl).href;
            } else {
              break;
            }
          }
        } else if (pathname === "/") {
          // Simulate landing page loader
          const { loader: indexLoader } = await import("../_index/route");
          const request = new Request(currentUrl);

          try {
            const result = await indexLoader({
              request,
              context: {} as never,
              params: {},
              url,
              pattern: "/",
            });
            // Landing page returns null (200) when no shop param
            expect(result).toBeNull();
            break; // Success - landed on 200 page
          } catch (response: unknown) {
            const r = response as Response;
            if (r.status === 302) {
              currentUrl = new URL(r.headers.get("Location")!, currentUrl).href;
            } else {
              break;
            }
          }
        } else if (pathname === "/app") {
          // Should NOT reach /app in this flow
          throw new Error("Redirect chain visited /app - potential loop!");
        } else {
          break; // Unknown route
        }

        maxRedirects--;
      }

      // Verify the chain
      expect(visitedUrls).toEqual(["/auth/login", "/"]);
      expect(visitedUrls).not.toContain("/app");
      // Verify no loop (auth.login appears only once)
      expect(visitedUrls.filter((u) => u === "/auth/login").length).toBe(1);
    });
  });
});
