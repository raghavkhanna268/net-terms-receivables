import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Tests for the /privacy public RESOURCE route.
 *
 * This route is fully public: no authentication, no session,
 * no shop data. It renders docs/privacy.md as HTML.
 *
 * As a RESOURCE ROUTE (no default export), the loader's Response
 * is returned directly to the client.
 *
 * Internal implementation details (table names, job names, code identifiers)
 * are in docs/privacy-implementation.md which is NOT rendered publicly.
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

  it("contains privacy contact email, owner info, no placeholder email, no phone or address", async () => {
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

    expect(html).toContain("support@termwiseapp.com");
    expect(html).not.toContain("@gmail.com");
    expect(html).toContain("Raghav Khanna");
    expect(html).toContain("individual developer, India");

    expect(html).not.toContain("[privacy contact email]");
    expect(html).not.toContain("[TBD: DPA]");
    expect(html).not.toContain("[TBD: legal entity]");
    expect(html).not.toContain("[TBD: contact email]");
    expect(html).not.toContain("[TBD: effective date]");

    expect(html).not.toMatch(/\+\d{1,3}[\s.-]?\d{3,}/);
    expect(html).not.toMatch(/\(\d{3}\)\s*\d{3}/);
    expect(html).not.toContain("postal address");
    expect(html).not.toContain("mailing address");
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
      "<title>Privacy Policy — Termwise: Net Terms & Credit</title>"
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

  it("does NOT contain Implementation Checklist heading", async () => {
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

    expect(html).not.toContain("Implementation Checklist");
    expect(html).not.toContain("Appendix B");
  });

  it("does NOT contain internal table names", async () => {
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

    expect(html).not.toContain("s8_tagged_customers");
    expect(html).not.toContain("s8_draft_orders");
    expect(html).not.toContain("s22_data_requests");
    expect(html).not.toContain("s6_dead_letter");
    expect(html).not.toContain("s6_processed_webhooks");
    expect(html).not.toContain("s22_purge_unmatched_narration");
    expect(html).not.toContain("CUSTOMER_PII_FIELDS");
  });
});

describe("/privacy markdown rendering", () => {
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

  it("preserves snake_case in privacy-implementation.md (verbatim coverage)", async () => {
    const { _markdownToHtml } = await import("../privacy");

    const implPath = resolve(
      process.cwd(),
      "docs/privacy-implementation.md"
    );
    const implContent = readFileSync(implPath, "utf-8");

    const html = _markdownToHtml(implContent);

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

  it("preserves code spans in privacy-implementation.md", async () => {
    const { _markdownToHtml } = await import("../privacy");

    const implPath = resolve(
      process.cwd(),
      "docs/privacy-implementation.md"
    );
    const implContent = readFileSync(implPath, "utf-8");

    const html = _markdownToHtml(implContent);

    expect(html).toContain("<code>s22_purge_unmatched_narration</code>");
    expect(html).toContain("<code>CUSTOMER_PII_FIELDS=1</code>");

    expect(html).not.toContain("<code>s22<em>purge</em>");
    expect(html).not.toContain("<code>CUSTOMER<em>PII</em>");
  });

  it("preserves email*/displayName* asterisk markers in privacy-implementation.md", async () => {
    const { _markdownToHtml } = await import("../privacy");

    const implPath = resolve(
      process.cwd(),
      "docs/privacy-implementation.md"
    );
    const implContent = readFileSync(implPath, "utf-8");

    const html = _markdownToHtml(implContent);

    expect(html).toContain("email*");
    expect(html).toContain("displayName*");
    expect(html).not.toMatch(/email<em>/);
    expect(html).not.toMatch(/displayName<em>/);
  });
});

describe("privacy.md / shopify.app.toml scope sync", () => {
  it("lists all scopes from shopify.app.toml in docs/privacy.md", () => {
    const tomlPath = resolve(process.cwd(), "shopify.app.toml");
    const tomlContent = readFileSync(tomlPath, "utf-8");

    const scopesMatch = tomlContent.match(/^scopes\s*=\s*"([^"]+)"/m);
    expect(scopesMatch, "Could not find scopes line in shopify.app.toml").not.toBeNull();

    const scopesLine = scopesMatch![1];
    const scopes = scopesLine
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    expect(scopes.length).toBeGreaterThan(0);

    const privacyPath = resolve(process.cwd(), "docs/privacy.md");
    const privacyContent = readFileSync(privacyPath, "utf-8");

    for (const scope of scopes) {
      expect(
        privacyContent,
        `Scope "${scope}" from shopify.app.toml not found in docs/privacy.md`
      ).toContain(`\`${scope}\``);
    }
  });
});

describe("privacy.md content requirements", () => {
  const privacyPath = resolve(process.cwd(), "docs/privacy.md");
  const privacyContent = readFileSync(privacyPath, "utf-8");

  it("contains the product name 'Termwise: Net Terms & Credit'", () => {
    expect(privacyContent).toContain("Termwise: Net Terms & Credit");
  });

  it("contains exact Resend subprocessor wording", () => {
    expect(privacyContent).toContain(
      "Resend, Inc., Tokyo, Japan (ap-northeast-1) data region"
    );
  });

  it("contains exact backup retention sentence", () => {
    expect(privacyContent).toContain(
      "The newest 7 backups are always kept, and older ones are deleted after 30 days on the next successful backup run."
    );
  });

  it("does not say PCD access is approved or confirmed", () => {
    const pcdSection = privacyContent.match(
      /Protected Customer Data[\s\S]*?(?=##|$)/
    );
    expect(pcdSection).not.toBeNull();
    const pcdText = pcdSection![0].toLowerCase();
    expect(pcdText).not.toContain("approved");
    expect(pcdText).not.toContain("confirmed");
  });

  it("states PCD handling factually without request status", () => {
    expect(privacyContent).toContain("The app accesses buyer name and email, which Shopify classifies as protected customer data");
    expect(privacyContent).not.toContain("requested access to protected customer data");
    expect(privacyContent).not.toContain("Shopify reviews this request");
  });

  it("contains Team Lead Sentry sentence", () => {
    expect(privacyContent).toContain(
      "It receives only sanitized error and performance events, with no buyer contact details, bank remitter names or narrations, and no payment amounts."
    );
  });

  it("states access logs are deleted after 1 year", () => {
    expect(privacyContent).toContain("Access events are deleted after 1 year");
  });

  it("states customer PII sync wording accurately", () => {
    expect(privacyContent).toContain(
      "Name and email are received for customers in the sync and stored only for matching buyers."
    );
  });

  it("states draft orders retention until deleted, erasure, or shop/redact", () => {
    expect(privacyContent).toContain(
      "Until deleted in Shopify, customer erasure, or shop/redact"
    );
  });

  it("states payment retention is until shop/redact not shop uninstall", () => {
    expect(privacyContent).toContain("| Payment | Payment reconciliation (value date, amount, rail, UTR) | Until shop/redact |");
    expect(privacyContent).not.toContain("Until shop uninstall");
  });

  it("lists GitHub as a subprocessor with accurate backup wording", () => {
    expect(privacyContent).toContain("GitHub, Inc.");
    expect(privacyContent).toContain("Source code hosting and CI");
    expect(privacyContent).toContain(
      "database contents are processed transiently in runner memory, encrypted before leaving the runner, and not stored by GitHub"
    );
  });

  it("lists Cloudflare R2 and observability logs", () => {
    expect(privacyContent).toContain("encrypted database backups (R2)");
    expect(privacyContent).toContain("observability logs");
  });

  it("lists Resend merchant contact email and owner email", () => {
    expect(privacyContent).toContain("merchant contact email (as Reply-To)");
    expect(privacyContent).toContain("shop owner email (for data-request notices)");
  });

  it("says outstanding amount not invoice total for reminder emails", () => {
    expect(privacyContent).toContain("Outstanding amount (formatted with shop currency)");
    expect(privacyContent).not.toContain("Invoice total (formatted with shop currency)");
  });

  it("says shop name from Shopify name when available", () => {
    expect(privacyContent).toContain(
      "Shop name (from the store's Shopify name when available, otherwise from shop domain)"
    );
  });
});

describe("merchant-terms.md content requirements", () => {
  const termsPath = resolve(process.cwd(), "docs/legal/merchant-terms.md");
  const termsContent = readFileSync(termsPath, "utf-8");

  it("contains the product name 'Termwise: Net Terms & Credit'", () => {
    expect(termsContent).toContain("Termwise: Net Terms & Credit");
  });

  it("contains the privacy contact email", () => {
    expect(termsContent).toContain("support@termwiseapp.com");
    expect(termsContent).not.toContain("@gmail.com");
  });

  it("contains exact Resend subprocessor wording", () => {
    expect(termsContent).toContain(
      "Resend, Inc., Tokyo, Japan (ap-northeast-1) data region"
    );
  });

  it("specifies liability cap of 12 months' fees", () => {
    expect(termsContent).toContain("TWELVE (12) MONTHS");
  });

  it("specifies Indian law and Delhi courts", () => {
    expect(termsContent).toContain("Laws of India");
    expect(termsContent).toContain("Delhi (New Delhi), India");
  });

  it("does not grant audit rights", () => {
    expect(termsContent).toContain("We do not provide audit rights");
  });

  it("specifies 72-hour breach notification", () => {
    expect(termsContent).toContain("within 72 hours");
  });

  it("contains exact backup retention sentence", () => {
    expect(termsContent).toContain(
      "The newest 7 backups are always kept, and older ones are deleted after 30 days on the next successful backup run."
    );
  });

  it("contains Team Lead Sentry sentence", () => {
    expect(termsContent).toContain(
      "It receives only sanitized error and performance events, with no buyer contact details, bank remitter names or narrations, and no payment amounts."
    );
  });

  it("says does not request or store for phone/address", () => {
    expect(termsContent).toContain("The App does not request or store:");
    expect(termsContent).not.toContain("does NOT process or store");
  });

  it("notes reinstall skips deletion", () => {
    expect(termsContent).toContain(
      "If the shop reinstalls before the shop/redact webhook arrives, deletion is skipped"
    );
  });

  it("lists GitHub as a sub-processor with accurate backup wording", () => {
    expect(termsContent).toContain("GitHub, Inc.");
    expect(termsContent).toContain("Source code hosting and CI");
    expect(termsContent).toContain(
      "database contents are processed transiently in runner memory, encrypted before leaving the runner, and not stored by GitHub"
    );
  });

  it("lists Cloudflare R2 and observability logs", () => {
    expect(termsContent).toContain("encrypted database backups (R2)");
    expect(termsContent).toContain("observability logs");
  });

  it("lists Resend merchant contact email and owner email", () => {
    expect(termsContent).toContain("merchant contact email (as Reply-To)");
    expect(termsContent).toContain("shop owner email (for data-request notices)");
  });

  it("says Cloudflare transfer includes R2 storage not transient only", () => {
    expect(termsContent).toContain("Cloudflare R2 (encrypted database backups, Asia-Pacific region)");
    expect(termsContent).not.toContain("transient processing only");
  });

  it("references Sentry scrubbing in Part 2 section 4 Sub-Processors", () => {
    expect(termsContent).toContain("Sentry scrubbing is described in Part 2, section 4 (Sub-Processors)");
    expect(termsContent).not.toContain("Sentry scrubbing is described in section 4\n");
  });

  it("lists GitHub cross-border transfer with transient processing wording", () => {
    expect(termsContent).toContain(
      "GitHub (source code and CI; database contents processed transiently in runner memory during encrypted backup job, not stored by GitHub)"
    );
  });
});

describe("data-retention.md content requirements", () => {
  const retentionPath = resolve(process.cwd(), "docs/security/data-retention.md");
  const retentionContent = readFileSync(retentionPath, "utf-8");

  it("contains exact backup retention sentence", () => {
    expect(retentionContent).toContain(
      "Deleted data may remain in encrypted backups for up to 30 days, after which it is permanently deleted"
    );
  });

  it("specifies 30-day backup retention period", () => {
    expect(retentionContent).toContain("30-day rolling retention");
  });
});

describe("SUPPORT_EMAIL_MAILTO constant", () => {
  it("contains app domain address and not gmail", async () => {
    const { SUPPORT_EMAIL_MAILTO } = await import("../../lib/constants");

    expect(SUPPORT_EMAIL_MAILTO).toBe("mailto:support@termwiseapp.com");
    expect(SUPPORT_EMAIL_MAILTO).not.toContain("@gmail.com");
  });
});

describe("legal docs contain no TBD or TODO markers", () => {
  const privacyPath = resolve(process.cwd(), "docs/privacy.md");
  const privacyContent = readFileSync(privacyPath, "utf-8");
  const termsPath = resolve(process.cwd(), "docs/legal/merchant-terms.md");
  const termsContent = readFileSync(termsPath, "utf-8");

  it("privacy.md contains no '[TBD' markers", () => {
    expect(privacyContent).not.toContain("[TBD");
  });

  it("privacy.md contains no 'TODO' markers", () => {
    expect(privacyContent).not.toMatch(/TODO/i);
  });

  it("privacy.md contains no '[Raghav to confirm' markers", () => {
    expect(privacyContent).not.toContain("[Raghav to confirm");
  });

  it("merchant-terms.md contains no '[TBD' markers", () => {
    expect(termsContent).not.toContain("[TBD");
  });

  it("merchant-terms.md contains no 'TODO' markers", () => {
    expect(termsContent).not.toMatch(/TODO/i);
  });

  it("merchant-terms.md contains no '[Raghav to confirm' markers", () => {
    expect(termsContent).not.toContain("[Raghav to confirm");
  });
});
