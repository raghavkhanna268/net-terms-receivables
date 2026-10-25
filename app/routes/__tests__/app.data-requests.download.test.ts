import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LoaderFunctionArgs } from "react-router";

const mockSqlResult = Object.assign([], { count: 0 });
const mockSql = Object.assign(
  vi.fn().mockResolvedValue(mockSqlResult),
  { json: vi.fn((v) => v) }
);

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
}));

const mockGetDataRequestExport = vi.fn();
const mockMarkDataRequestDownloaded = vi.fn();

vi.mock("~/services/compliance", () => ({
  getDataRequestExport: (...args: unknown[]) => mockGetDataRequestExport(...args),
  markDataRequestDownloaded: (...args: unknown[]) => mockMarkDataRequestDownloaded(...args),
}));

const mockAuthenticate = vi.fn();

function createMockLoaderArgs(
  request: Request,
  params: Record<string, string> = {}
): LoaderFunctionArgs {
  return {
    request,
    params,
    context: {
      cloudflare: { env: {}, ctx: {} },
      shopify: {
        authenticate: {
          admin: mockAuthenticate,
        },
      },
    },
    url: new URL(request.url),
    pattern: "/app/data-requests/:id/download",
  } as unknown as LoaderFunctionArgs;
}

import { loader } from "../app.data-requests.$id.download";

describe("app.data-requests.$id.download", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticate.mockResolvedValue({
      session: { shop: "test-shop.myshopify.com" },
    });
    mockSql.mockResolvedValue([{ id: "shop-123" }]);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("loader", () => {
    it("returns 400 when request ID is missing", async () => {
      const request = new Request("https://example.com/app/data-requests//download");
      const response = await loader(createMockLoaderArgs(request, {}));

      expect(response.status).toBe(400);
      const json = (await response.json()) as { error: string };
      expect(json.error).toBe("Missing request ID");
    });

    it("returns 404 when shop is not found", async () => {
      mockSql.mockResolvedValueOnce([]);

      const request = new Request("https://example.com/app/data-requests/req-123/download");
      const response = await loader(createMockLoaderArgs(request, { id: "req-123" }));

      expect(response.status).toBe(404);
      const json = (await response.json()) as { error: string };
      expect(json.error).toBe("Shop not found");
    });

    it("returns 404 when data request is not found or expired", async () => {
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      mockGetDataRequestExport.mockResolvedValueOnce(null);

      const request = new Request("https://example.com/app/data-requests/req-123/download");
      const response = await loader(createMockLoaderArgs(request, { id: "req-123" }));

      expect(response.status).toBe(404);
      const json = (await response.json()) as { error: string };
      expect(json.error).toBe("Data request not found or expired");
    });

    it("returns JSON with Content-Disposition when export is found", async () => {
      const exportData = {
        customerGid: "gid://shopify/Customer/456",
        requestId: "req-123",
        requestedAt: "2026-01-01T00:00:00.000Z",
        data: {
          taggedCustomer: { tags: ["net-terms"], tagActive: true },
          draftOrders: [],
          buyerAccount: null,
          invoices: [],
        },
      };

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      mockGetDataRequestExport.mockResolvedValueOnce(exportData);

      const request = new Request("https://example.com/app/data-requests/req-123/download");
      const response = await loader(createMockLoaderArgs(request, { id: "req-123" }));

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(response.headers.get("Content-Disposition")).toBe(
        'attachment; filename="customer-data-req-123.json"'
      );

      const json = (await response.json()) as { customerGid: string; requestId: string };
      expect(json.customerGid).toBe("gid://shopify/Customer/456");
      expect(json.requestId).toBe("req-123");
    });

    it("marks request as downloaded after successful delivery", async () => {
      const exportData = {
        customerGid: "gid://shopify/Customer/456",
        requestId: "req-123",
        requestedAt: "2026-01-01T00:00:00.000Z",
        data: { taggedCustomer: null, draftOrders: [], buyerAccount: null, invoices: [], paymentMatches: [] },
      };

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      mockGetDataRequestExport.mockResolvedValueOnce(exportData);

      const request = new Request("https://example.com/app/data-requests/req-123/download");
      await loader(createMockLoaderArgs(request, { id: "req-123" }));

      expect(mockMarkDataRequestDownloaded).toHaveBeenCalledWith(
        expect.anything(),
        "shop-123",
        "req-123"
      );
    });

    it("authenticates admin before processing", async () => {
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      mockGetDataRequestExport.mockResolvedValueOnce(null);

      const request = new Request("https://example.com/app/data-requests/req-123/download");
      await loader(createMockLoaderArgs(request, { id: "req-123" }));

      expect(mockAuthenticate).toHaveBeenCalledWith(request);
    });
  });
});
