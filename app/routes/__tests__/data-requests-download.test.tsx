// @vitest-environment jsdom
/**
 * Data-requests download error handling tests (jsdom environment).
 *
 * Verifies that:
 * - Failed downloads show generic error text, not server error details
 * - The internal error string 'internal-detail-xyz' is never exposed to the user
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot } from "react-dom/client";
import { act, createElement } from "react";

vi.mock("react-router", async () => {
  return {
    useLoaderData: vi.fn(),
    useNavigation: vi.fn(() => ({ state: "idle" })),
  };
});

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { headers: vi.fn(() => ({})) },
}));

import { useLoaderData } from "react-router";
import DataRequestsPage from "../app.data-requests";

const mockUseLoaderData = vi.mocked(useLoaderData);

describe("Data-requests download error handling (jsdom)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    originalFetch = global.fetch;

    mockUseLoaderData.mockReturnValue({
      dataRequests: [
        {
          id: "dr-test-1",
          customerGid: "gid://shopify/Customer/test-1",
          requestId: "req-test-1",
          receivedAt: new Date().toISOString(),
          status: "completed",
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        },
      ],
      expiresInDays: 30,
      error: null,
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    global.fetch = originalFetch;
  });

  it("failed download with server error shows generic text, not internal-detail-xyz", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "internal-detail-xyz" }),
    });

    await act(async () => {
      root.render(createElement(DataRequestsPage));
    });

    const downloadButton = container.querySelector("s-button");
    expect(downloadButton).toBeTruthy();

    await act(async () => {
      downloadButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => {});

    expect(container.textContent).toContain("Download failed. Please try again.");
    expect(container.textContent).not.toContain("internal-detail-xyz");
  });

  it("before clicking download, no error text is shown", async () => {
    await act(async () => {
      root.render(createElement(DataRequestsPage));
    });

    expect(container.textContent).not.toContain("Download failed. Please try again.");
    expect(container.textContent).not.toContain("internal-detail-xyz");
  });
});
