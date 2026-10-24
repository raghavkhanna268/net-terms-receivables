import { describe, it, expect } from "vitest";

/**
 * Tests for the /privacy public RESOURCE route.
 *
 * This route is fully public: no authentication, no session,
 * no shop data. It renders docs/privacy.md as HTML.
 *
 * As a RESOURCE ROUTE (no default export), the loader's Response
 * is returned directly to the client.
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
    expect(html).toContain('<html lang="en">');
    expect(html).toContain(
      "<title>Privacy Policy — Net Terms Receivables</title>"
    );
    expect(html).toContain("</body>");
    expect(html).toContain("</html>");
  });

  it("sets Cache-Control header on Response (resource route)", async () => {
    const { loader } = await import("../privacy");

    const request = new Request("https://example.com/privacy");

    const response = await loader({
      request,
      context: {} as never,
      params: {},
      url: new URL(request.url),
      pattern: "/privacy",
    });

    expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
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

  it("has no default export (resource route, not UI route)", async () => {
    const routeModule = await import("../privacy");

    expect(routeModule).not.toHaveProperty("default");
    expect(routeModule).toHaveProperty("loader");
  });
});

describe("/privacy markdown rendering", () => {
  it("preserves snake_case identifiers without converting to italics", async () => {
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

    expect(html).toContain("s8_tagged_customers");
    expect(html).toContain("s8_draft_orders");
    expect(html).toContain("s22_data_requests");
    expect(html).toContain("s6_dead_letter");
    expect(html).toContain("s6_processed_webhooks");

    expect(html).not.toContain("s8<em>tagged</em>customers");
    expect(html).not.toContain("s8<em>draft</em>orders");
    expect(html).not.toContain("s22<em>data</em>requests");
    expect(html).not.toContain("s6<em>dead</em>letter");
  });

  it("preserves code spans with snake_case content", async () => {
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

    expect(html).toContain("<code>s22_purge_unmatched_narration</code>");
    expect(html).toContain("<code>CUSTOMER_PII_FIELDS=1</code>");

    expect(html).not.toContain("<code>s22<em>purge</em>");
    expect(html).not.toContain("<code>CUSTOMER<em>PII</em>");
  });

  it("does not have unbalanced em/code tags", async () => {
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

    const emOpenCount = (html.match(/<em>/g) || []).length;
    const emCloseCount = (html.match(/<\/em>/g) || []).length;
    expect(emOpenCount).toBe(emCloseCount);

    const codeOpenCount = (html.match(/<code>/g) || []).length;
    const codeCloseCount = (html.match(/<\/code>/g) || []).length;
    expect(codeOpenCount).toBe(codeCloseCount);

    expect(html).not.toMatch(/<em>[^<]*<\/code>/);
    expect(html).not.toMatch(/<code>[^<]*<\/em>/);
  });

  it("preserves asterisk markers attached to identifiers (email*, displayName*)", async () => {
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

    expect(html).toContain("email*");
    expect(html).toContain("displayName*");

    expect(html).not.toContain("email<em>");
    expect(html).not.toContain("<em>displayName");
  });
});

describe("markdownToHtml function", () => {
  it("handles inline code before emphasis processing", async () => {
    const { _markdownToHtml } = await import("../privacy");

    const input = "Use `read_all_orders` scope and `RESEND_API_KEY` var";
    const output = _markdownToHtml(input);

    expect(output).toContain("<code>read_all_orders</code>");
    expect(output).toContain("<code>RESEND_API_KEY</code>");
    expect(output).not.toContain("<em>");
  });

  it("does not convert snake_case to italics", async () => {
    const { _markdownToHtml } = await import("../privacy");

    const input = "The s8_tagged_customers table and s22_data_requests record";
    const output = _markdownToHtml(input);

    expect(output).toContain("s8_tagged_customers");
    expect(output).toContain("s22_data_requests");
    expect(output).not.toContain("<em>tagged</em>");
    expect(output).not.toContain("<em>data</em>");
  });

  it("does not convert asterisk markers on identifiers to italics", async () => {
    const { _markdownToHtml } = await import("../privacy");

    const input = "Fields: email*, displayName*, and name*";
    const output = _markdownToHtml(input);

    expect(output).toContain("email*");
    expect(output).toContain("displayName*");
    expect(output).toContain("name*");
    expect(output).not.toContain("<em>");
  });

  it("still converts proper emphasis with word boundaries", async () => {
    const { _markdownToHtml } = await import("../privacy");

    const input = "This is *emphasized* text and _also emphasized_ here";
    const output = _markdownToHtml(input);

    expect(output).toContain("<em>emphasized</em>");
    expect(output).toContain("<em>also emphasized</em>");
  });
});
