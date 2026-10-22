import { describe, it, expect } from "vitest";
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
