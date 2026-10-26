import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Privacy policy subprocessor table completeness test (S19).
 *
 * Verifies that docs/privacy.md Section 5 lists all external services
 * the app integrates with. The list below MUST be kept in sync with
 * actual code integrations:
 *
 * - Cloudflare: workers/app.ts (Cloudflare Workers runtime)
 * - Supabase: app/lib/db-light.server.ts (Postgres database)
 * - Resend: app/services/reminders.server.ts, app/services/compliance/compliance.server.ts
 * - Sentry: app/lib/sentry.ts (error monitoring, optional via SENTRY_DSN)
 *
 * The search pattern matches the service name anywhere in a table row,
 * allowing for legal entity names (e.g., "Functional Software, Inc." for Sentry).
 */

const ACTIVE_SUBPROCESSORS = ["Cloudflare", "Supabase", "Resend"] as const;

const NOT_IN_USE_SUBPROCESSORS = ["Sentry"] as const;

describe("Privacy Policy Subprocessor Table", () => {
  const privacyMdPath = join(process.cwd(), "docs", "privacy.md");
  const privacyContent = readFileSync(privacyMdPath, "utf-8");

  it("contains Section 5 Subprocessors heading", () => {
    expect(privacyContent).toContain("## 5. Subprocessors");
  });

  it("has a markdown table in Section 5", () => {
    const section5Match = privacyContent.match(
      /## 5\. Subprocessors[\s\S]*?(?=## 6\.|$)/
    );
    expect(section5Match).not.toBeNull();
    const section5 = section5Match![0];
    expect(section5).toMatch(/\|\s*Subprocessor\s*\|/);
    expect(section5).toMatch(/\|[-\s|]+\|/);
  });

  for (const subprocessor of ACTIVE_SUBPROCESSORS) {
    it(`lists ${subprocessor} in the subprocessor table`, () => {
      const section5Match = privacyContent.match(
        /## 5\. Subprocessors[\s\S]*?(?=## 6\.|$)/
      );
      expect(section5Match).not.toBeNull();
      const section5 = section5Match![0];

      const tableLines = section5
        .split("\n")
        .filter((line) => line.startsWith("|") && line.includes("|"));
      const hasSubprocessor = tableLines.some((line) =>
        line.toLowerCase().includes(subprocessor.toLowerCase())
      );
      expect(hasSubprocessor).toBe(true);
    });
  }

  for (const subprocessor of NOT_IN_USE_SUBPROCESSORS) {
    it(`lists ${subprocessor} as not in use`, () => {
      const section5Match = privacyContent.match(
        /## 5\. Subprocessors[\s\S]*?(?=## 6\.|$)/
      );
      expect(section5Match).not.toBeNull();
      const section5 = section5Match![0];

      expect(section5.toLowerCase()).toContain(subprocessor.toLowerCase());
      expect(section5).toContain("Not in use");
    });
  }

  it("lists Resend with Tokyo, Japan location in privacy.md", () => {
    const section5Match = privacyContent.match(
      /## 5\. Subprocessors[\s\S]*?(?=## 6\.|$)/
    );
    expect(section5Match).not.toBeNull();
    const section5 = section5Match![0];

    const resendLine = section5
      .split("\n")
      .find(
        (line) =>
          line.startsWith("|") && line.toLowerCase().includes("resend")
      );
    expect(resendLine).toBeDefined();
    expect(resendLine).toMatch(/tokyo.*japan|japan.*tokyo/i);
    expect(resendLine).toContain("ap-northeast-1");
    expect(resendLine).not.toMatch(/\bUS\b/i);
    expect(resendLine).not.toMatch(/united states/i);
  });

  it("lists Resend with Tokyo, Japan location in merchant-terms.md", () => {
    const merchantTermsPath = join(
      process.cwd(),
      "docs",
      "legal",
      "merchant-terms.md"
    );
    const merchantTermsContent = readFileSync(merchantTermsPath, "utf-8");

    const resendLine = merchantTermsContent
      .split("\n")
      .find(
        (line) =>
          line.startsWith("|") && line.toLowerCase().includes("resend")
      );
    expect(resendLine).toBeDefined();
    expect(resendLine).toMatch(/tokyo.*japan|japan.*tokyo/i);
    expect(resendLine).toContain("ap-northeast-1");
    expect(resendLine).not.toMatch(/\bUS\b/i);
    expect(resendLine).not.toMatch(/united states/i);
  });

  it("lists Japan for Resend in cross-border transfers in merchant-terms.md", () => {
    const merchantTermsPath = join(
      process.cwd(),
      "docs",
      "legal",
      "merchant-terms.md"
    );
    const merchantTermsContent = readFileSync(merchantTermsPath, "utf-8");

    const transferMatch = merchantTermsContent.match(
      /Cross-Border Transfers[\s\S]*?(?=### \d|## |$)/i
    );
    expect(transferMatch).not.toBeNull();
    const transferSection = transferMatch![0];

    expect(transferSection).toMatch(/japan.*resend|resend.*japan/i);
    expect(transferSection).toContain("Tokyo");
  });
});
