import { describe, it, expect, vi } from "vitest";
import { wrapWithSentry, captureException, captureMessage } from "./sentry";

describe("sentry", () => {
  describe("wrapWithSentry", () => {
    it("returns an object with fetch property when wrapping a handler", () => {
      const handler = {
        fetch: async () => new Response("ok"),
      };

      const wrappedHandler = wrapWithSentry(handler);

      expect(wrappedHandler).toHaveProperty("fetch");
      expect(typeof wrappedHandler.fetch).toBe("function");
    });

    it("preserves other handler methods", () => {
      const handler = {
        fetch: async () => new Response("ok"),
        scheduled: async () => {},
      };

      const wrappedHandler = wrapWithSentry(handler);

      expect(wrappedHandler).toHaveProperty("fetch");
      expect(wrappedHandler).toHaveProperty("scheduled");
    });

    it("passes inner Response through unchanged when no DSN is set", async () => {
      const expectedBody = "test response body";
      const expectedStatus = 201;
      const expectedHeaders = { "X-Custom-Header": "test-value" };

      const innerResponse = new Response(expectedBody, {
        status: expectedStatus,
        headers: expectedHeaders,
      });

      const handler = {
        fetch: vi.fn().mockResolvedValue(innerResponse),
      };

      const wrappedHandler = wrapWithSentry(handler);

      const mockRequest = new Request("https://example.com/test");
      const mockEnv = {};
      const mockCtx = {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      };

      const response = await wrappedHandler.fetch!(
        mockRequest as unknown as Parameters<
          NonNullable<typeof wrappedHandler.fetch>
        >[0],
        mockEnv as unknown as Parameters<
          NonNullable<typeof wrappedHandler.fetch>
        >[1],
        mockCtx as unknown as Parameters<
          NonNullable<typeof wrappedHandler.fetch>
        >[2]
      );

      expect(handler.fetch).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(expectedStatus);
      expect(response.headers.get("X-Custom-Header")).toBe("test-value");
      expect(await response.text()).toBe(expectedBody);
    });

    it("passes inner Response through unchanged when DSN is empty string", async () => {
      const expectedBody = "empty dsn response";
      const innerResponse = new Response(expectedBody);

      const handler = {
        fetch: vi.fn().mockResolvedValue(innerResponse),
      };

      const wrappedHandler = wrapWithSentry(handler);

      const mockRequest = new Request("https://example.com/test");
      const mockEnv = { SENTRY_DSN: "" };
      const mockCtx = {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      };

      const response = await wrappedHandler.fetch!(
        mockRequest as unknown as Parameters<
          NonNullable<typeof wrappedHandler.fetch>
        >[0],
        mockEnv as unknown as Parameters<
          NonNullable<typeof wrappedHandler.fetch>
        >[1],
        mockCtx as unknown as Parameters<
          NonNullable<typeof wrappedHandler.fetch>
        >[2]
      );

      expect(handler.fetch).toHaveBeenCalledTimes(1);
      expect(await response.text()).toBe(expectedBody);
    });
  });

  describe("captureException", () => {
    it("does not throw when called without Sentry initialized", () => {
      expect(() => captureException(new Error("test"))).not.toThrow();
    });

    it("accepts various error types", () => {
      expect(() => captureException(new Error("error"))).not.toThrow();
      expect(() => captureException("string error")).not.toThrow();
      expect(() => captureException({ message: "object error" })).not.toThrow();
      expect(() => captureException(null)).not.toThrow();
      expect(() => captureException(undefined)).not.toThrow();
    });
  });

  describe("captureMessage", () => {
    it("does not throw when called without Sentry initialized", () => {
      expect(() => captureMessage("test message")).not.toThrow();
    });

    it("accepts severity levels", () => {
      expect(() => captureMessage("debug message", "debug")).not.toThrow();
      expect(() => captureMessage("info message", "info")).not.toThrow();
      expect(() => captureMessage("warning message", "warning")).not.toThrow();
      expect(() => captureMessage("error message", "error")).not.toThrow();
      expect(() => captureMessage("fatal message", "fatal")).not.toThrow();
    });
  });
});
