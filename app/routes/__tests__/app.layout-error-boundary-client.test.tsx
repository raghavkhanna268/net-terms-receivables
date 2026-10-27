/**
 * @vitest-environment jsdom
 *
 * Client-side tests for app.tsx ErrorBoundary that verify AppProvider integration.
 *
 * This test verifies that the ErrorBoundary fallback is wrapped in AppProvider by
 * checking that the shopify:navigate event listener is registered (a behavior only
 * AppProvider provides). This test fails if AppProvider is removed from the fallback.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createElement, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { UNSAFE_ErrorResponseImpl as ErrorResponseImpl } from "react-router";

describe("app.tsx ErrorBoundary AppProvider integration", () => {
  let container: HTMLDivElement;
  let addEventListenerSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    addEventListenerSpy = vi.spyOn(document, "addEventListener");
  });

  afterEach(() => {
    document.body.removeChild(container);
    addEventListenerSpy.mockRestore();
    vi.doUnmock("react-router");
    vi.doUnmock("@shopify/shopify-app-react-router/server");
    vi.resetModules();
  });

  it("registers shopify:navigate listener when rendering fallback via AppProvider", async () => {
    const mockNavigate = vi.fn();

    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>("react-router");
      return {
        ...actual,
        useRouteError: () => new ErrorResponseImpl(500, "Internal Server Error", null),
        useRouteLoaderData: (routeId: string) =>
          routeId === "root" ? { apiKey: "test-key" } : undefined,
        useNavigate: () => mockNavigate,
      };
    });

    vi.resetModules();
    const { ErrorBoundary } = await import("../app");

    const errorBoundaryHtml = `<script src="https://cdn.shopify.com/shopifycloud/polaris-2.js"></script><s-page heading="Something went wrong"><s-section><s-banner tone="critical" heading="Unexpected Error"><s-paragraph>We encountered an issue loading this page.</s-paragraph><s-stack direction="inline" gap="base"><s-button href="/app">Go to Dashboard</s-button></s-stack></s-banner></s-section></s-page>`;
    container.innerHTML = errorBoundaryHtml;

    await new Promise<void>((resolve) => {
      hydrateRoot(
        container,
        createElement(StrictMode, null, createElement(ErrorBoundary)),
        { onRecoverableError: () => {} }
      );
      setTimeout(resolve, 50);
    });

    const navigateListenerCalls = addEventListenerSpy.mock.calls.filter(
      (call: [string, ...unknown[]]) => call[0] === "shopify:navigate"
    );

    expect(navigateListenerCalls.length).toBeGreaterThan(0);
  });
});
