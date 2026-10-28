import { describe, it, expect } from "vitest";

/**
 * Tests for the /terms public RESOURCE route.
 *
 * This route is fully public: no authentication, no session,
 * no shop data. It renders docs/legal/merchant-terms.md as HTML.
 *
 * As a RESOURCE ROUTE (no default export), the loader's Response
 * is returned directly to the client.
 */

describe("/terms route", () => {
  it("returns 200 with text/html content-type", async () => {
    const { loader } = await import("../terms");

    const request = new Request("https://example.com/terms");

    const response = await loader({
      request,
      context: {} as never,
      params: {},
      url: new URL(request.url),
      pattern: "/terms",
    });

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/html; charset=utf-8"
    );
  });

  it("works with no auth or session (bare Request, no Shopify mocks)", async () => {
    const { loader } = await import("../terms");

    const request = new Request("https://example.com/terms");

    const response = await loader({
      request,
      context: {},
      params: {},
      url: new URL(request.url),
      pattern: "/terms",
    });

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
  });

  it("contains key strings from merchant-terms.md", async () => {
    const { loader } = await import("../terms");

    const request = new Request("https://example.com/terms");

    const response = await loader({
      request,
      context: {} as never,
      params: {},
      url: new URL(request.url),
      pattern: "/terms",
    });

    const html = await response.text();

    expect(html).toContain("Cloudflare R2 (encrypted database backups)");
    expect(html).toContain("support@termwiseapp.com");
    expect(html).toContain("Part 2, section 4 (Sub-Processors)");
    expect(html).toContain(
      "The nightly backup job runs on GitHub-hosted runners"
    );
  });

  it("does NOT contain Asia-Pacific region claim", async () => {
    const { loader } = await import("../terms");

    const request = new Request("https://example.com/terms");

    const response = await loader({
      request,
      context: {} as never,
      params: {},
      url: new URL(request.url),
      pattern: "/terms",
    });

    const html = await response.text();

    expect(html).not.toContain("Asia-Pacific");
  });

  it("sets Cache-Control header on Response (resource route)", async () => {
    const { loader } = await import("../terms");

    const request = new Request("https://example.com/terms");

    const response = await loader({
      request,
      context: {} as never,
      params: {},
      url: new URL(request.url),
      pattern: "/terms",
    });

    expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
  });

  it("has no default export (resource route, not UI route)", async () => {
    const routeModule = await import("../terms");

    expect(routeModule).not.toHaveProperty("default");
    expect(routeModule).toHaveProperty("loader");
  });

  it("renders HTML with proper structure and title from H1", async () => {
    const { loader } = await import("../terms");

    const request = new Request("https://example.com/terms");

    const response = await loader({
      request,
      context: {} as never,
      params: {},
      url: new URL(request.url),
      pattern: "/terms",
    });

    const html = await response.text();

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain(
      "<title>Merchant Terms of Service &amp; Data Processing Addendum — Termwise: Net Terms &amp; Credit</title>"
    );
    expect(html).toContain("</body>");
    expect(html).toContain("</html>");
  });

  it("renders major sections from merchant-terms.md", async () => {
    const { loader } = await import("../terms");

    const request = new Request("https://example.com/terms");

    const response = await loader({
      request,
      context: {} as never,
      params: {},
      url: new URL(request.url),
      pattern: "/terms",
    });

    const html = await response.text();

    expect(html).toContain("Merchant Terms of Service");
    expect(html).toContain("Data Processing Addendum");
    expect(html).toContain("Sub-Processors");
    expect(html).toContain("Security Measures");
    expect(html).toContain("Data Retention");
  });
});
