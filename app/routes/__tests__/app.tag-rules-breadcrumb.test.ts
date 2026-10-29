import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

/**
 * Source-level test that pins the breadcrumb links in app.tag-rules.tsx
 * to use /app (not /) for the Back to Dashboard link.
 *
 * All breadcrumb s-links should point to /app to ensure the App Store reviewer
 * lands on the dashboard, not root, when navigating from the currency-not-supported
 * screen or any other page state.
 */
describe("Tag Rules breadcrumb links", () => {
  it("all breadcrumb s-links use href=\"/app\" (not href=\"/\")", () => {
    const source = readFileSync("app/routes/app.tag-rules.tsx", "utf-8");

    const breadcrumbLinkPattern = /<s-link[^>]*slot="breadcrumb-actions"[^>]*>/g;
    const matches = source.match(breadcrumbLinkPattern) ?? [];

    expect(matches.length).toBeGreaterThan(0);

    for (const match of matches) {
      expect(match).toContain('href="/app"');
      expect(match).not.toContain('href="/"');
    }
  });

  it("notSupported branch breadcrumb specifically uses /app", () => {
    const source = readFileSync("app/routes/app.tag-rules.tsx", "utf-8");

    const notSupportedBlock = source.match(
      /if\s*\(\s*notSupported\s*\)\s*\{[\s\S]*?return\s*\([\s\S]*?<\/s-page>\s*\);?\s*\}/
    );
    expect(notSupportedBlock).not.toBeNull();

    const block = notSupportedBlock![0];
    expect(block).toContain('href="/app"');
    expect(block).not.toMatch(/href=["']\/["']/);
  });
});

describe("Imports page console.error removal", () => {
  it("app.imports.tsx has no console.error calls", () => {
    const source = readFileSync("app/routes/app.imports.tsx", "utf-8");

    expect(source).not.toContain("console.error");
  });
});
