import { describe, it, expect } from "vitest";

/**
 * Tests for the /privacy public route.
 *
 * This route is fully public: no authentication, no session,
 * no shop data. It renders docs/privacy.md as HTML.
 */

describe("/privacy route", () => {
  it("returns 200 with text/html content-type", async () => {
    const { loader } = await import("../privacy");

    const request = new Request("https://example.com/privacy");

    const response = await loader({
      request,
      context: {} as never,
      params: {},
      url: new URL(request.url),
      pattern: "/privacy",
    });

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/html; charset=utf-8"
    );
  });

  it("works with no auth or session (bare Request, no Shopify mocks)", async () => {
    const { loader } = await import("../privacy");

    const request = new Request("https://example.com/privacy");

    const response = await loader({
      request,
      context: {},
      params: {},
      url: new URL(request.url),
      pattern: "/privacy",
    });

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
  });

  it("contains all four TBD placeholders in output", async () => {
    const { loader } = await import("../privacy");

    const request = new Request("https://example.com/privacy");

    const response = await loader({
      request,
      context: {} as never,
      params: {},
      url: new URL(request.url),
      pattern: "/privacy",
    });

    const html = await response.text();

    expect(html).toContain("[TBD: legal entity]");
    expect(html).toContain("[TBD: contact email]");
    expect(html).toContain("[TBD: effective date]");
    expect(html).toContain("[TBD: DPA]");
  });

  it("renders HTML with proper structure", async () => {
    const { loader } = await import("../privacy");

    const request = new Request("https://example.com/privacy");

    const response = await loader({
      request,
      context: {} as never,
      params: {},
      url: new URL(request.url),
      pattern: "/privacy",
    });

    const html = await response.text();

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html lang=\"en\">");
    expect(html).toContain("<title>Privacy Policy — Net Terms Receivables</title>");
    expect(html).toContain("</body>");
    expect(html).toContain("</html>");
  });

  it("sets public cache headers", async () => {
    const { headers } = await import("../privacy");
    const result = headers({} as never) as Record<string, string>;
    expect(result["Cache-Control"]).toBe("public, max-age=3600");
  });

  it("renders major sections from privacy.md", async () => {
    const { loader } = await import("../privacy");

    const request = new Request("https://example.com/privacy");

    const response = await loader({
      request,
      context: {} as never,
      params: {},
      url: new URL(request.url),
      pattern: "/privacy",
    });

    const html = await response.text();

    expect(html).toContain("Privacy Policy");
    expect(html).toContain("Data We Collect");
    expect(html).toContain("Data Storage and Security");
    expect(html).toContain("Subprocessors");
    expect(html).toContain("Data Retention");
    expect(html).toContain("Data Subject Rights");
  });
});
