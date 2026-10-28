import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SUPPORT_EMAIL_MAILTO } from "../lib/constants";

/**
 * Privacy policy support address consistency test.
 *
 * Verifies that docs/privacy.md lists the same support email address
 * as the SUPPORT_EMAIL_MAILTO constant in app/lib/constants.ts.
 * This prevents the two from drifting apart over time.
 */

describe("Privacy Policy Support Address", () => {
  const privacyMdPath = join(process.cwd(), "docs", "privacy.md");
  const privacyContent = readFileSync(privacyMdPath, "utf-8");

  const expectedEmail = SUPPORT_EMAIL_MAILTO.replace(/^mailto:/i, "");

  const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const foundEmails = privacyContent.match(emailPattern) ?? [];

  const uniqueEmails = [...new Set(foundEmails)];

  it("contains at least one email address", () => {
    expect(
      uniqueEmails.length,
      "privacy.md must contain at least one email address"
    ).toBeGreaterThan(0);
  });

  it("all email addresses match the support constant", () => {
    for (const email of uniqueEmails) {
      expect(email, "email address mismatch").toBe(expectedEmail);
    }
  });
});
