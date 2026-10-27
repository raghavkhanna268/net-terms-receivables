import { describe, it, expect } from "vitest";
import {
  assertAllowlistEnforced,
  assertNotCleanupBlackout,
  assertWithinWriteWindow,
  domainOf,
  formatG4CleanupOutput,
  G4_CLEANUP_DUE_BEFORE,
  G4_RECIPIENT_ENV,
  g4FixtureIds,
  isReservedTestDomain,
  isSendableRecipient,
  readAllowlistEnforcedFromWrangler,
  resolveG4Recipient,
  stripJsonComments,
} from "../lib/g4-fixture";
import { assertG4AllowlistGuardWith, isG4FixtureBadArgs } from "../seed";

// All data here is synthetic (example.com addresses only); no real recipients.

describe("resolveG4Recipient", () => {
  const withEnv = (value: string | undefined) => ({ [G4_RECIPIENT_ENV]: value });

  it("returns the only entry when it is a single plain address", () => {
    expect(resolveG4Recipient(withEnv("qa-fixture@example.com"))).toBe("qa-fixture@example.com");
  });

  it("lowercases and trims the entry (parsed like RESEND_TEST_RECIPIENTS)", () => {
    expect(resolveG4Recipient(withEnv("  QA-Fixture@Example.COM  "))).toBe("qa-fixture@example.com");
  });

  it("takes the first entry when multiple are present", () => {
    expect(resolveG4Recipient(withEnv("first@example.com, second@example.com"))).toBe(
      "first@example.com"
    );
  });

  // Fail-closed cases: each must throw. If the validation branch is removed,
  // the empty/commas-only/malformed cases stop throwing and these fail.
  it("fails closed when the value is undefined", () => {
    expect(() => resolveG4Recipient(withEnv(undefined))).toThrow("g4_recipient_unavailable");
  });

  it("fails closed when the value is empty", () => {
    expect(() => resolveG4Recipient(withEnv(""))).toThrow("g4_recipient_unavailable");
  });

  it("fails closed when the value is whitespace only", () => {
    expect(() => resolveG4Recipient(withEnv("   "))).toThrow("g4_recipient_unavailable");
  });

  it("fails closed when the value is commas only", () => {
    expect(() => resolveG4Recipient(withEnv(",,"))).toThrow("g4_recipient_unavailable");
  });

  it("fails closed when the first entry is malformed", () => {
    expect(() => resolveG4Recipient(withEnv("not-an-email"))).toThrow("g4_recipient_unavailable");
  });

  it("fails closed when the first entry is malformed even if a later one is valid", () => {
    expect(() => resolveG4Recipient(withEnv("bogus, ok@example.com"))).toThrow(
      "g4_recipient_unavailable"
    );
  });
});

describe("assertAllowlistEnforced", () => {
  it("accepts an absent (undefined) value", () => {
    expect(() => assertAllowlistEnforced(undefined)).not.toThrow();
  });

  it('accepts exactly "true"', () => {
    expect(() => assertAllowlistEnforced("true")).not.toThrow();
  });

  // Each of these must abort. If the guard body is removed, "false" and others
  // stop throwing and these fail.
  it('aborts on "false"', () => {
    expect(() => assertAllowlistEnforced("false")).toThrow("g4_allowlist_not_enforced");
  });

  it('aborts on "True" (wrong case)', () => {
    expect(() => assertAllowlistEnforced("True")).toThrow("g4_allowlist_not_enforced");
  });

  it("aborts on an empty string", () => {
    expect(() => assertAllowlistEnforced("")).toThrow("g4_allowlist_not_enforced");
  });

  it('aborts on "1"', () => {
    expect(() => assertAllowlistEnforced("1")).toThrow("g4_allowlist_not_enforced");
  });
});

describe("assertWithinWriteWindow", () => {
  it("accepts midday", () => {
    expect(() => assertWithinWriteWindow(12, 0)).not.toThrow();
  });

  it("accepts the 09:00 boundary", () => {
    expect(() => assertWithinWriteWindow(9, 0)).not.toThrow();
  });

  it("accepts the 18:45 boundary", () => {
    expect(() => assertWithinWriteWindow(18, 45)).not.toThrow();
  });

  // Each must abort. If the window check is removed, these stop throwing.
  it("aborts before 09:00", () => {
    expect(() => assertWithinWriteWindow(8, 59)).toThrow("g4_outside_send_window");
  });

  it("aborts after 18:45", () => {
    expect(() => assertWithinWriteWindow(18, 46)).toThrow("g4_outside_send_window");
  });

  it("aborts in the evening", () => {
    expect(() => assertWithinWriteWindow(20, 0)).toThrow("g4_outside_send_window");
  });

  it("aborts at night", () => {
    expect(() => assertWithinWriteWindow(3, 0)).toThrow("g4_outside_send_window");
  });
});

describe("assertNotCleanupBlackout", () => {
  it("accepts minutes before the blackout", () => {
    expect(() => assertNotCleanupBlackout(43)).not.toThrow();
  });

  it("accepts minutes after the blackout", () => {
    expect(() => assertNotCleanupBlackout(51)).not.toThrow();
  });

  // Each must abort inside the XX:44-XX:50 block.
  it("aborts at the start of the blackout", () => {
    expect(() => assertNotCleanupBlackout(44)).toThrow("g4_cleanup_wait");
  });

  it("aborts mid-blackout", () => {
    expect(() => assertNotCleanupBlackout(45)).toThrow("g4_cleanup_wait");
  });

  it("aborts at the end of the blackout", () => {
    expect(() => assertNotCleanupBlackout(50)).toThrow("g4_cleanup_wait");
  });
});

describe("stripJsonComments / readAllowlistEnforcedFromWrangler", () => {
  const sample = (enforced?: string) => `{
    // line comment with a URL https://example.com/path
    "name": "net-terms",
    /* block comment */
    "vars": {
      "SHOPIFY_APP_URL": "https://example.com", // trailing comment
      "RESEND_FROM": "reminders@example.com"${enforced === undefined ? "" : `,
      "RESEND_RECIPIENT_ALLOWLIST_ENFORCED": "${enforced}"`}
    },
  }`;

  it("preserves // inside string values (URLs are not stripped)", () => {
    const parsed = JSON.parse(stripJsonComments(sample())) as {
      vars: { SHOPIFY_APP_URL: string };
    };
    expect(parsed.vars.SHOPIFY_APP_URL).toBe("https://example.com");
  });

  it("returns undefined when the enforcement var is absent", () => {
    expect(readAllowlistEnforcedFromWrangler(sample())).toBeUndefined();
  });

  it('returns "true" when present', () => {
    expect(readAllowlistEnforcedFromWrangler(sample("true"))).toBe("true");
  });

  it('returns "false" when present', () => {
    expect(readAllowlistEnforcedFromWrangler(sample("false"))).toBe("false");
  });
});

describe("g4FixtureIds", () => {
  it("builds deterministic, seed-tagged, shop-scoped ids", () => {
    const ids = g4FixtureIds("shop-123");
    expect(ids).toEqual({
      account: "seed-g4-fixture-shop-123",
      company: "ntr-seed-g4-company-shop-123",
      location: "ntr-seed-g4-fixture",
      invoice: "seed-g4-fixture-inv-shop-123",
      order: "ntr-seed-g4-order-shop-123",
      rule: "seed-g4-rule0-shop-123",
      prior: "seed-g4-fixture-prior-shop-123",
    });
  });
});

describe("isG4FixtureBadArgs", () => {
  const base = {
    reset: false,
    reportDuplicatesMode: false,
    reseedHeldCurrencyMode: false,
    g4ReminderFixture: false,
    g4ReminderFixtureCleanup: false,
  };

  it("is false when no G4 flag is set", () => {
    expect(isG4FixtureBadArgs(base)).toBe(false);
  });

  it("is false for write alone", () => {
    expect(isG4FixtureBadArgs({ ...base, g4ReminderFixture: true })).toBe(false);
  });

  it("is false for cleanup alone", () => {
    expect(isG4FixtureBadArgs({ ...base, g4ReminderFixtureCleanup: true })).toBe(false);
  });

  it("is true when both G4 modes are set", () => {
    expect(
      isG4FixtureBadArgs({ ...base, g4ReminderFixture: true, g4ReminderFixtureCleanup: true })
    ).toBe(true);
  });

  it("is true when combined with --reset", () => {
    expect(isG4FixtureBadArgs({ ...base, g4ReminderFixture: true, reset: true })).toBe(true);
  });

  it("is true when combined with --report-duplicates", () => {
    expect(
      isG4FixtureBadArgs({ ...base, g4ReminderFixtureCleanup: true, reportDuplicatesMode: true })
    ).toBe(true);
  });

  it("is true when combined with --reseed-held-currency", () => {
    expect(
      isG4FixtureBadArgs({ ...base, g4ReminderFixture: true, reseedHeldCurrencyMode: true })
    ).toBe(true);
  });
});

describe("domainOf", () => {
  it("returns the lowercased domain after the last @", () => {
    expect(domainOf("Someone@Example.COM")).toBe("example.com");
  });

  it("returns the trimmed whole value when there is no @", () => {
    expect(domainOf("  bogus  ")).toBe("bogus");
  });
});

describe("isReservedTestDomain", () => {
  it.each(["example.com", "example.org", "example.net"])("treats %s as reserved", (d) => {
    expect(isReservedTestDomain(d)).toBe(true);
  });

  it.each(["mail.example.com", "sub.example.org", "a.b.example.net"])(
    "treats subdomains of %s as reserved",
    (d) => {
      expect(isReservedTestDomain(d)).toBe(true);
    }
  );

  it.each(["foo.example", "example", "host.test", "test", "host.invalid", "invalid"])(
    "treats reserved TLD %s as reserved",
    (d) => {
      expect(isReservedTestDomain(d)).toBe(true);
    }
  );

  it.each(["gmail.com", "example.io", "example.co", "test-store.myshopify.com"])(
    "treats real domain %s as NOT reserved",
    (d) => {
      expect(isReservedTestDomain(d)).toBe(false);
    }
  );
});

describe("isSendableRecipient", () => {
  // Reserved test domains are treated as non-deliverable (allowlist will skip).
  it("is not sendable for a reserved test domain", () => {
    expect(isSendableRecipient("buyer@example.com")).toBe(false);
  });

  // Fail-safe: a real-looking address counts as sendable (triggers the abort).
  // If this flipped to always-false, this assertion would fail.
  it("is sendable for a real-looking address", () => {
    expect(isSendableRecipient("buyer@gmail.com")).toBe(true);
  });

  it("is sendable (fail safe) for an unparseable value", () => {
    expect(isSendableRecipient("nobody")).toBe(true);
  });
});

describe("assertG4AllowlistGuardWith (deploy-SHA drift)", () => {
  // Minimal wrangler.jsonc text with an optional enforcement value.
  const wrangler = (enforced?: string) =>
    enforced === undefined
      ? `{ "vars": { "RESEND_FROM": "reminders@example.com" } }`
      : `{ "vars": { "RESEND_RECIPIENT_ALLOWLIST_ENFORCED": "${enforced}" } }`;

  const SHA_A = "a".repeat(40);
  const SHA_B = "b".repeat(40);

  it("passes when the deploy SHA equals the checkout SHA (no git show)", () => {
    const readDeployedWrangler = () => {
      throw new Error("should not be called");
    };
    expect(() =>
      assertG4AllowlistGuardWith({
        readWrangler: () => wrangler("true"),
        readDeployedWrangler,
        deploySha: SHA_A,
        checkoutSha: SHA_A,
      })
    ).not.toThrow();
  });

  it("passes when no deploy/checkout SHAs are provided (drift check skipped)", () => {
    expect(() =>
      assertG4AllowlistGuardWith({
        readWrangler: () => wrangler("true"),
        readDeployedWrangler: () => {
          throw new Error("should not be called");
        },
      })
    ).not.toThrow();
  });

  it("passes for a different SHA whose deployed config omits the enforcement value", () => {
    expect(() =>
      assertG4AllowlistGuardWith({
        readWrangler: () => wrangler("true"),
        readDeployedWrangler: () => wrangler(undefined),
        deploySha: SHA_A,
        checkoutSha: SHA_B,
      })
    ).not.toThrow();
  });

  it('passes for a different SHA whose deployed config is "true"', () => {
    expect(() =>
      assertG4AllowlistGuardWith({
        readWrangler: () => wrangler("true"),
        readDeployedWrangler: () => wrangler("true"),
        deploySha: SHA_A,
        checkoutSha: SHA_B,
      })
    ).not.toThrow();
  });

  it('aborts for a different SHA whose deployed config is "false"', () => {
    expect(() =>
      assertG4AllowlistGuardWith({
        readWrangler: () => wrangler("true"),
        readDeployedWrangler: () => wrangler("false"),
        deploySha: SHA_A,
        checkoutSha: SHA_B,
      })
    ).toThrow("g4_deploy_sha_mismatch");
  });

  it("aborts when the deployed git show fails", () => {
    expect(() =>
      assertG4AllowlistGuardWith({
        readWrangler: () => wrangler("true"),
        readDeployedWrangler: () => {
          throw new Error("fatal: path 'wrangler.jsonc' does not exist");
        },
        deploySha: SHA_A,
        checkoutSha: SHA_B,
      })
    ).toThrow("g4_deploy_sha_mismatch");
  });

  it("aborts when the checked-out config itself is not enforced", () => {
    expect(() =>
      assertG4AllowlistGuardWith({
        readWrangler: () => wrangler("false"),
        readDeployedWrangler: () => wrangler("true"),
        deploySha: SHA_A,
        checkoutSha: SHA_B,
      })
    ).toThrow("g4_allowlist_not_enforced");
  });
});

describe("formatG4CleanupOutput", () => {
  const base = {
    mode: "cleanup" as const,
    dryRun: false,
    store: "resolved" as const,
    prior: "off" as const,
    fixture: "deleted" as const,
    queued: 0,
  };

  it("reports non-fixture counts by status and queue count (counts only)", () => {
    const lines = formatG4CleanupOutput({
      ...base,
      nonfixtureReminderLogByStatus: { sent: 2, skipped_opted_out: 1 },
      nonfixtureQueued: 3,
    });
    const out = lines.join("\n");
    // Statuses are sorted; counts only, no ids/emails/amounts.
    expect(out).toContain(
      "g4_cleanup_sideeffects nonfixture_reminderlog sent=2 skipped_opted_out=1"
    );
    expect(out).toContain("g4_cleanup_sideeffects nonfixture_queued=3");
    expect(out).not.toContain("@");
  });

  it("prints 'none' when there are no non-fixture reminder logs", () => {
    const lines = formatG4CleanupOutput({
      ...base,
      nonfixtureReminderLogByStatus: {},
      nonfixtureQueued: 0,
    });
    expect(lines.join("\n")).toContain("g4_cleanup_sideeffects nonfixture_reminderlog none");
    expect(lines.join("\n")).toContain("g4_cleanup_sideeffects nonfixture_queued=0");
  });
});

describe("constants", () => {
  it("exposes the recipient env name and cleanup deadline", () => {
    expect(G4_RECIPIENT_ENV).toBe("G4_TEST_RECIPIENT");
    expect(G4_CLEANUP_DUE_BEFORE).toBe("02:00Z");
  });
});
