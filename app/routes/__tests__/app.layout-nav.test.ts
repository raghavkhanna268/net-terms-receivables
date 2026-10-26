import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

/**
 * Tests for app layout navigation (app.tsx).
 *
 * Verifies that the <s-app-nav> block contains all required navigation links
 * in the exact order specified, including:
 * - /app with rel="home" (hidden by Shopify, app name shown instead)
 * - /app/imports (Imports) - bank statement upload
 * - /app/settings/reminders (Reminders) - reminder settings
 *
 * Per Shopify App Store requirement 4.1.4: no visible nav item may duplicate
 * the app home. The rel="home" link is hidden by Shopify.
 *
 * @see https://shopify.dev/docs/api/app-home/app-bridge-web-components/app-nav
 */

describe("app layout navigation", () => {
  const appSource = readFileSync("app/routes/app.tsx", "utf-8");

  it("contains link to /app/imports with label Imports", () => {
    expect(appSource).toContain('<s-link href="/app/imports">Imports</s-link>');
  });

  it("contains link to /app/settings/reminders with label Reminders", () => {
    expect(appSource).toContain(
      '<s-link href="/app/settings/reminders">Reminders</s-link>'
    );
  });

  it("has /app link with rel='home' attribute", () => {
    expect(appSource).toMatch(/<s-link href="\/app" rel="home">Home<\/s-link>/);
  });

  it("does not have a visible Dashboard link (per App Store 4.1.4)", () => {
    const navMatch = appSource.match(/<s-app-nav>([\s\S]*?)<\/s-app-nav>/);
    expect(navMatch).not.toBeNull();

    const navContent = navMatch![1];
    expect(navContent).not.toContain(">Dashboard<");
  });

  it("contains all seven navigation links in exact order", () => {
    const expectedPatterns = [
      /<s-link href="\/app" rel="home">Home<\/s-link>/,
      /<s-link href="\/app\/reconcile">Reconcile<\/s-link>/,
      /<s-link href="\/app\/imports">Imports<\/s-link>/,
      /<s-link href="\/app\/settings\/reminders">Reminders<\/s-link>/,
      /<s-link href="\/app\/tag-rules">Tag Rules<\/s-link>/,
      /<s-link href="\/app\/plan">Plan<\/s-link>/,
      /<s-link href="\/app\/onboarding">Setup Guide<\/s-link>/,
    ];

    const navMatch = appSource.match(/<s-app-nav>([\s\S]*?)<\/s-app-nav>/);
    expect(navMatch).not.toBeNull();

    const navContent = navMatch![1];

    for (const pattern of expectedPatterns) {
      expect(navContent).toMatch(pattern);
    }

    let lastIndex = -1;
    for (const pattern of expectedPatterns) {
      const match = navContent.match(pattern);
      expect(match).not.toBeNull();
      const currentIndex = match!.index!;
      expect(currentIndex).toBeGreaterThan(lastIndex);
      lastIndex = currentIndex;
    }
  });

  it("has exactly seven active navigation links (excluding commented items)", () => {
    const navMatch = appSource.match(/<s-app-nav>([\s\S]*?)<\/s-app-nav>/);
    expect(navMatch).not.toBeNull();

    const navContent = navMatch![1];
    const withoutComments = navContent.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    const activeLinks = withoutComments.match(/<s-link href="[^"]+"[^>]*>[^<]+<\/s-link>/g);

    expect(activeLinks).toHaveLength(7);
  });
});
