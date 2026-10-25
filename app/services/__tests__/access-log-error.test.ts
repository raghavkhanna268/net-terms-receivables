/**
 * Tests that access log failures don't break page rendering.
 *
 * Tests:
 * - Loader still returns 200/renders when the insert throws
 * - Error log is count-only (no PII)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("access-log error handling", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.resetModules();
  });

  it("recordAccess does not throw when SQL insert fails", async () => {
    const { recordAccess } = await import("../access-log.server");

    const mockSqlThatThrows = Object.assign(
      async () => {
        throw new Error("Connection failed");
      },
      {
        json: (data: unknown) => JSON.stringify(data),
      }
    ) as unknown as Parameters<typeof recordAccess>[0];

    vi.doMock("~/lib/request-context.server", () => ({
      getRequestWaitUntil: () => undefined,
    }));

    expect(() => {
      recordAccess(mockSqlThatThrows, {
        shopId: "shop-123",
        actor: "12345",
        action: "dashboard",
        recordType: "BuyerAccount",
        count: 10,
      });
    }).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("logs count-only error when insert fails (no PII)", async () => {
    const { recordAccess } = await import("../access-log.server");

    const mockSqlThatThrows = Object.assign(
      async () => {
        throw new Error("Database error with sensitive data in message");
      },
      {
        json: (data: unknown) => JSON.stringify(data),
      }
    ) as unknown as Parameters<typeof recordAccess>[0];

    vi.doMock("~/lib/request-context.server", () => ({
      getRequestWaitUntil: () => undefined,
    }));

    recordAccess(mockSqlThatThrows, {
      shopId: "shop-123",
      actor: "12345",
      action: "dashboard",
      recordType: "BuyerAccount",
      count: 10,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const logOutput = consoleErrorSpy.mock.calls[0][0] as string;

    expect(logOutput).toContain('"event":"access_log_insert_failed"');
    expect(logOutput).toContain('"shopId":"shop-123"');
    expect(logOutput).toContain('"topic":"access.dashboard"');
    expect(logOutput).toContain('"count":1');

    expect(logOutput).not.toContain("myshopify.com");
    expect(logOutput).not.toContain("Connection failed");
    expect(logOutput).not.toContain("Database error");
    expect(logOutput).not.toContain("@");
    expect(logOutput).not.toContain("recordType");
    expect(logOutput).not.toContain("BuyerAccount");
  });

  it("recordAccess completes without blocking when using waitUntil", async () => {
    const capturedPromises: Promise<unknown>[] = [];
    const mockWaitUntil = vi.fn((p: Promise<unknown>) => {
      capturedPromises.push(p);
    });

    vi.doMock("~/lib/request-context.server", () => ({
      getRequestWaitUntil: () => mockWaitUntil,
    }));

    vi.resetModules();
    const { recordAccess } = await import("../access-log.server");

    const insertCalled = vi.fn();
    const mockSql = Object.assign(
      async () => {
        insertCalled();
        return { count: 1 };
      },
      {
        json: (data: unknown) => JSON.stringify(data),
      }
    ) as unknown as Parameters<typeof recordAccess>[0];

    const startTime = Date.now();
    recordAccess(mockSql, {
      shopId: "shop-123",
      actor: "12345",
      action: "dashboard",
      recordType: "BuyerAccount",
      count: 10,
    });
    const syncTime = Date.now() - startTime;

    expect(syncTime).toBeLessThan(10);
    expect(mockWaitUntil).toHaveBeenCalledTimes(1);

    await Promise.all(capturedPromises);
    expect(insertCalled).toHaveBeenCalledTimes(1);
  });

  it("error log contains no raw error message that could have PII", async () => {
    const { recordAccess } = await import("../access-log.server");

    const sensitiveErrorMessage =
      "Error processing request for customer@example.myshopify.com with order #12345";
    const mockSqlThatThrows = Object.assign(
      async () => {
        throw new Error(sensitiveErrorMessage);
      },
      {
        json: (data: unknown) => JSON.stringify(data),
      }
    ) as unknown as Parameters<typeof recordAccess>[0];

    vi.doMock("~/lib/request-context.server", () => ({
      getRequestWaitUntil: () => undefined,
    }));

    recordAccess(mockSqlThatThrows, {
      shopId: "shop-456",
      actor: "67890",
      action: "accounts_detail",
      recordType: "BuyerAccount",
      recordId: "acc-123",
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const logOutput = consoleErrorSpy.mock.calls[0][0] as string;

    expect(logOutput).not.toContain("customer@");
    expect(logOutput).not.toContain("myshopify.com");
    expect(logOutput).not.toContain("#12345");
    expect(logOutput).not.toContain("order");
    expect(logOutput).not.toContain(sensitiveErrorMessage);

    expect(logOutput).toContain('"shopId":"shop-456"');
    expect(logOutput).toContain('"topic":"access.accounts_detail"');
    expect(logOutput).toContain('"count":1');
  });
});
