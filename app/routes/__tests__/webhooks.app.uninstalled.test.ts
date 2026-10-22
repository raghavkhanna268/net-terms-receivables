import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import { action } from "../webhooks.app.uninstalled";

describe("webhooks.app.uninstalled", () => {
  const TEST_SHOP = "test-shop.myshopify.com";

  const mockSessionStorage = {
    deleteAllForShop: vi.fn(),
  };

  const mockShopify = {
    authenticate: {
      webhook: vi.fn(),
    },
  };

  const createMockContext = () => ({
    shopify: mockShopify,
    sessionStorage: mockSessionStorage,
    cloudflare: { env: {}, ctx: {} },
  });

  const createMockRequest = () =>
    new Request("https://example.com/webhooks/app/uninstalled", {
      method: "POST",
      headers: {
        "X-Shopify-Topic": "app/uninstalled",
        "X-Shopify-Hmac-Sha256": "test-hmac",
        "X-Shopify-Shop-Domain": TEST_SHOP,
      },
      body: JSON.stringify({}),
    });

  const createActionArgs = (): ActionFunctionArgs => ({
    request: createMockRequest(),
    context: createMockContext(),
    params: {},
    url: new URL("https://example.com/webhooks/app/uninstalled"),
    pattern: "/webhooks/app/uninstalled",
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockShopify.authenticate.webhook.mockResolvedValue({
      shop: TEST_SHOP,
      topic: "APP_UNINSTALLED",
    });
  });

  it("deletes all sessions for the shop using deleteAllForShop", async () => {
    mockSessionStorage.deleteAllForShop.mockResolvedValue(5);

    const response = await action(createActionArgs());

    expect(response).toBeInstanceOf(Response);
    expect(mockSessionStorage.deleteAllForShop).toHaveBeenCalledWith(TEST_SHOP);
  });

  it("handles shops with no sessions gracefully", async () => {
    mockSessionStorage.deleteAllForShop.mockResolvedValue(0);

    const response = await action(createActionArgs());

    expect(response).toBeInstanceOf(Response);
    expect(mockSessionStorage.deleteAllForShop).toHaveBeenCalledWith(TEST_SHOP);
  });

  it("deletes more than 25 sessions (bypasses findSessionsByShop limit)", async () => {
    // deleteAllForShop uses deleteMany internally, avoiding the 25-session
    // limit of findSessionsByShop. All sessions are deleted in one query.
    mockSessionStorage.deleteAllForShop.mockResolvedValue(50);

    const response = await action(createActionArgs());

    expect(response).toBeInstanceOf(Response);
    expect(mockSessionStorage.deleteAllForShop).toHaveBeenCalledTimes(1);
    expect(mockSessionStorage.deleteAllForShop).toHaveBeenCalledWith(TEST_SHOP);
  });

  it("logs but does not fail on database errors", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSessionStorage.deleteAllForShop.mockRejectedValue(new Error("DB error"));

    const response = await action(createActionArgs());

    expect(response).toBeInstanceOf(Response);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
