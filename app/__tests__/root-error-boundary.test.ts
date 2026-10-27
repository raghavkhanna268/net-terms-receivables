import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for root ErrorBoundary generic copy.
 *
 * Verifies that thrown responses with data.message do NOT render
 * the message in the UI, and that each status class shows its
 * correct generic copy.
 */

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useRouteError: vi.fn(),
    useRouteLoaderData: vi.fn(() => ({ apiKey: "test-key", isDevMode: false })),
    useMatches: vi.fn(() => [{ pathname: "/app/test", handle: {} }]),
    isRouteErrorResponse: (error: unknown): error is { status: number; statusText: string; data: unknown } => {
      return (
        error != null &&
        typeof error === "object" &&
        "status" in error &&
        typeof (error as { status: unknown }).status === "number"
      );
    },
  };
});

describe("Root ErrorBoundary", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("does NOT render error.data.message containing a marker string", async () => {
    const { useRouteError } = await import("react-router");

    const markerText = "INTERNAL_DETAIL_MARKER_12345";
    (useRouteError as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 500,
      statusText: "Internal Server Error",
      data: { message: markerText },
    });

    const { ErrorBoundary } = await import("../root");
    const result = ErrorBoundary();

    const stringified = JSON.stringify(result);

    expect(stringified).not.toContain(markerText);
    expect(stringified).not.toContain("INTERNAL_DETAIL");
  });

  it("shows 'Page not found' for 404 status", async () => {
    const { useRouteError } = await import("react-router");

    (useRouteError as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 404,
      statusText: "Not Found",
      data: { message: "The resource /app/nonexistent was not found" },
    });

    const { ErrorBoundary } = await import("../root");
    const result = ErrorBoundary();

    const stringified = JSON.stringify(result);

    expect(stringified).toContain("Page not found");
    expect(stringified).toContain("404");
    expect(stringified).not.toContain("nonexistent");
  });

  it("shows 'Access denied' title and 'You don't have access' for 401 status", async () => {
    const { useRouteError } = await import("react-router");

    (useRouteError as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 401,
      statusText: "Unauthorized",
      data: { message: "Bearer token for user@test-shop.example invalid" },
    });

    const { ErrorBoundary } = await import("../root");
    const result = ErrorBoundary();

    const stringified = JSON.stringify(result);

    expect(stringified).toContain("Access denied");
    expect(stringified).toContain("don't have access");
    expect(stringified).not.toContain("Bearer");
    expect(stringified).not.toContain("test-shop");
  });

  it("shows 'Access denied' title and 'You don't have access' for 403 status", async () => {
    const { useRouteError } = await import("react-router");

    (useRouteError as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 403,
      statusText: "Forbidden",
      data: { message: "Shop test-store.myshopify.com is blocked" },
    });

    const { ErrorBoundary } = await import("../root");
    const result = ErrorBoundary();

    const stringified = JSON.stringify(result);

    expect(stringified).toContain("Access denied");
    expect(stringified).toContain("don't have access");
    expect(stringified).not.toContain("myshopify.com");
    expect(stringified).not.toContain("blocked");
  });

  it("shows 'Something went wrong with this request' for 400 status", async () => {
    const { useRouteError } = await import("react-router");

    (useRouteError as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 400,
      statusText: "Bad Request",
      data: { message: "Invalid field: email must match pattern" },
    });

    const { ErrorBoundary } = await import("../root");
    const result = ErrorBoundary();

    const stringified = JSON.stringify(result);

    expect(stringified).toContain("Something went wrong with this request");
    expect(stringified).not.toContain("Invalid field");
    expect(stringified).not.toContain("email");
  });

  it("shows 'Something went wrong with this request' for 405 status", async () => {
    const { useRouteError } = await import("react-router");

    (useRouteError as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 405,
      statusText: "Method Not Allowed",
      data: { message: "POST not allowed on /api/readonly-endpoint" },
    });

    const { ErrorBoundary } = await import("../root");
    const result = ErrorBoundary();

    const stringified = JSON.stringify(result);

    expect(stringified).toContain("Something went wrong with this request");
    expect(stringified).not.toContain("POST not allowed");
    expect(stringified).not.toContain("readonly-endpoint");
  });

  it("shows 'Something went wrong. Please try again.' for 500 status", async () => {
    const { useRouteError } = await import("react-router");

    (useRouteError as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 500,
      statusText: "Internal Server Error",
      data: { message: "Database connection failed to db.internal.example" },
    });

    const { ErrorBoundary } = await import("../root");
    const result = ErrorBoundary();

    const stringified = JSON.stringify(result);

    expect(stringified).toContain("Something went wrong. Please try again.");
    expect(stringified).not.toContain("Database");
    expect(stringified).not.toContain("internal.example");
  });

  it("shows 'Something went wrong. Please try again.' for 502 status", async () => {
    const { useRouteError } = await import("react-router");

    (useRouteError as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 502,
      statusText: "Bad Gateway",
      data: { message: "Upstream server backend-api.test-corp.io timed out" },
    });

    const { ErrorBoundary } = await import("../root");
    const result = ErrorBoundary();

    const stringified = JSON.stringify(result);

    expect(stringified).toContain("Something went wrong. Please try again.");
    expect(stringified).not.toContain("Upstream");
    expect(stringified).not.toContain("test-corp.io");
  });

  it("shows generic message for non-route-error-response errors", async () => {
    const { useRouteError } = await import("react-router");

    (useRouteError as ReturnType<typeof vi.fn>).mockReturnValue(
      new Error("Internal detail marker with user@example.com data")
    );

    const { ErrorBoundary } = await import("../root");
    const result = ErrorBoundary();

    const stringified = JSON.stringify(result);

    expect(stringified).toContain("Something went wrong. Please try again.");
    expect(stringified).not.toContain("Internal detail");
    expect(stringified).not.toContain("@example.com");
  });
});
