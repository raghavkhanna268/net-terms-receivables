import { DateTime } from "luxon";
import { describe, it, expect } from "vitest";
import {
  assertAllowlistEnforced,
  assertNotCleanupBlackout,
  assertWithinWriteWindow,
  computeG4CleanupWindow,
  computeG4WriteWindow,
  domainOf,
  formatG4ChecksLine,
  formatG4CleanupOutput,
  formatG4CleanupWindowLine,
  formatG4WindowLine,
  G4_CLEANUP_DUE_BEFORE,
  G4_RECIPIENT_ENV,
  g4FixtureIds,
  isReservedTestDomain,
  isSendableRecipient,
  readAllowlistEnforcedFromWrangler,
  REMINDER_ENQUEUE_UTC_MINUTE,
  resolveG4Recipient,
  stripJsonComments,
} from "../lib/g4-fixture";
import { assertG4AllowlistGuardWith, isG4FixtureBadArgs } from "../seed";

// All data here is synthetic (example.com addresses only); no real recipients.

/** Build the UTC instant for a wall-clock time in a given IANA zone. */
function at(zone: string, iso: string): Date {
  return DateTime.fromISO(iso, { zone }).toJSDate();
}

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
  // The write is allowed only when shop-local time >= 09:00 AND the next UTC
  // :15 enqueue run lands on the same shop-local date with a shop-local hour of
  // 09..18. Several of these cases FAIL under the old "09:00-18:45 shop-local"
  // rule (e.g. IST 18:45, New York 18:16), so they guard against a revert.

  // IST (Asia/Kolkata, +05:30, no DST).
  it("IST: accepts 18:35 (next :15 run is 18:45 IST, still in window)", () => {
    expect(() => assertWithinWriteWindow(at("Asia/Kolkata", "2026-10-27T18:35"), "Asia/Kolkata")).not.toThrow();
  });

  it("IST: rejects 18:46 (next :15 run is 19:45 IST, hour 19)", () => {
    expect(() => assertWithinWriteWindow(at("Asia/Kolkata", "2026-10-27T18:46"), "Asia/Kolkata")).toThrow(
      "g4_outside_send_window"
    );
  });

  it("IST: rejects 08:59 (before 09:00 shop-local)", () => {
    expect(() => assertWithinWriteWindow(at("Asia/Kolkata", "2026-10-27T08:59"), "Asia/Kolkata")).toThrow(
      "g4_outside_send_window"
    );
  });

  it("IST: accepts the 09:00 boundary", () => {
    expect(() => assertWithinWriteWindow(at("Asia/Kolkata", "2026-10-27T09:00"), "Asia/Kolkata")).not.toThrow();
  });

  // Old rule allowed 18:45 shop-local (inclusive); the new rule rejects it
  // because the next :15 run is 19:45 IST. Fails if reverted to the old logic.
  it("IST: rejects 18:45 (old rule allowed this; new rule does not)", () => {
    expect(() => assertWithinWriteWindow(at("Asia/Kolkata", "2026-10-27T18:45"), "Asia/Kolkata")).toThrow(
      "g4_outside_send_window"
    );
  });

  // America/New_York during EDT (-04:00), 2026-10-27.
  it("New York (EDT): accepts 09:05", () => {
    expect(() => assertWithinWriteWindow(at("America/New_York", "2026-10-27T09:05"), "America/New_York")).not.toThrow();
  });

  it("New York (EDT): accepts 18:14 (next :15 run is 18:15 local)", () => {
    expect(() => assertWithinWriteWindow(at("America/New_York", "2026-10-27T18:14"), "America/New_York")).not.toThrow();
  });

  // Old rule allowed 18:16 (<= 18:45); the new rule rejects it because the next
  // :15 run is 19:15 local. Fails if reverted to the old logic.
  it("New York (EDT): rejects 18:16 (old rule allowed this; new rule does not)", () => {
    expect(() => assertWithinWriteWindow(at("America/New_York", "2026-10-27T18:16"), "America/New_York")).toThrow(
      "g4_outside_send_window"
    );
  });

  // America/New_York after DST ends (2026-11-02, EST -05:00).
  it("New York (EST, post-DST): accepts 18:14", () => {
    expect(() => assertWithinWriteWindow(at("America/New_York", "2026-11-02T18:14"), "America/New_York")).not.toThrow();
  });

  it("New York (EST, post-DST): rejects 18:16", () => {
    expect(() => assertWithinWriteWindow(at("America/New_York", "2026-11-02T18:16"), "America/New_York")).toThrow(
      "g4_outside_send_window"
    );
  });

  it("New York (EST, post-DST): accepts 09:05", () => {
    expect(() => assertWithinWriteWindow(at("America/New_York", "2026-11-02T09:05"), "America/New_York")).not.toThrow();
  });

  // Australia/Adelaide: a half-hour zone (ACDT +10:30 in late October).
  it("Adelaide (half-hour zone): accepts 18:40 (next :15 run is 18:45 local)", () => {
    expect(() => assertWithinWriteWindow(at("Australia/Adelaide", "2026-10-27T18:40"), "Australia/Adelaide")).not.toThrow();
  });

  it("Adelaide (half-hour zone): rejects 18:46 (next :15 run is 19:45 local)", () => {
    expect(() => assertWithinWriteWindow(at("Australia/Adelaide", "2026-10-27T18:46"), "Australia/Adelaide")).toThrow(
      "g4_outside_send_window"
    );
  });
});

describe("assertNotCleanupBlackout", () => {
  // Blocked when the current UTC minute is 14..20 (brackets the :15 enqueue),
  // whatever the shop timezone. For whole-hour zones (New York) the shop-local
  // minute equals the UTC minute, so blocking :14-:20 and allowing :44-:50
  // both FAIL under the old "shop-local :44-:50" rule.

  // IST: 19:44-19:50 IST == UTC :14-:20.
  it("IST: allows 19:43 (UTC :13)", () => {
    expect(() => assertNotCleanupBlackout(at("Asia/Kolkata", "2026-10-27T19:43"))).not.toThrow();
  });

  it("IST: blocks 19:44 (UTC :14)", () => {
    expect(() => assertNotCleanupBlackout(at("Asia/Kolkata", "2026-10-27T19:44"))).toThrow("g4_cleanup_wait");
  });

  it("IST: blocks 19:50 (UTC :20)", () => {
    expect(() => assertNotCleanupBlackout(at("Asia/Kolkata", "2026-10-27T19:50"))).toThrow("g4_cleanup_wait");
  });

  it("IST: allows 19:51 (UTC :21)", () => {
    expect(() => assertNotCleanupBlackout(at("Asia/Kolkata", "2026-10-27T19:51"))).not.toThrow();
  });

  // New York (EDT): local minute == UTC minute.
  it("New York: allows local :13 (just before the UTC blackout)", () => {
    expect(() => assertNotCleanupBlackout(at("America/New_York", "2026-10-27T10:13"))).not.toThrow();
  });

  it("New York: blocks local :14 (old rule allowed this)", () => {
    expect(() => assertNotCleanupBlackout(at("America/New_York", "2026-10-27T10:14"))).toThrow("g4_cleanup_wait");
  });

  it("New York: blocks local :20 (old rule allowed this)", () => {
    expect(() => assertNotCleanupBlackout(at("America/New_York", "2026-10-27T10:20"))).toThrow("g4_cleanup_wait");
  });

  it("New York: allows local :21 (just after the UTC blackout)", () => {
    expect(() => assertNotCleanupBlackout(at("America/New_York", "2026-10-27T10:21"))).not.toThrow();
  });

  it("New York: allows local :44 (old rule blocked this)", () => {
    expect(() => assertNotCleanupBlackout(at("America/New_York", "2026-10-27T10:44"))).not.toThrow();
  });

  it("New York: allows local :50 (old rule blocked this)", () => {
    expect(() => assertNotCleanupBlackout(at("America/New_York", "2026-10-27T10:50"))).not.toThrow();
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
    window: { utcMinute: 7, blocked: false },
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
    expect(out).toContain("g4_cleanup_window utc_minute=07 blocked=false");
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

  it("pins the enqueue minute to the migration's pg_cron '15 * * * *'", () => {
    expect(REMINDER_ENQUEUE_UTC_MINUTE).toBe(15);
  });
});

describe("formatG4WindowLine", () => {
  // Fixed-key, PII-free: times and offsets only, no tz name, ids, emails or amounts.
  it("IST write at 18:35: shows offset, next run, last run, write_window_ok=true", () => {
    const line = formatG4WindowLine(
      computeG4WriteWindow(at("Asia/Kolkata", "2026-10-27T18:35"), "Asia/Kolkata")
    );
    expect(line).toBe(
      "g4_window shop_tz_offset=+05:30 next_enqueue_utc=13:15Z " +
        "next_enqueue_local=18:45 last_enqueue_local_today=18:45 write_window_ok=true"
    );
    expect(line).not.toContain("@");
    expect(line).not.toContain("Kolkata");
  });

  it("IST write at 18:46: write_window_ok=false with next run past the window", () => {
    const line = formatG4WindowLine(
      computeG4WriteWindow(at("Asia/Kolkata", "2026-10-27T18:46"), "Asia/Kolkata")
    );
    expect(line).toBe(
      "g4_window shop_tz_offset=+05:30 next_enqueue_utc=14:15Z " +
        "next_enqueue_local=19:45 last_enqueue_local_today=18:45 write_window_ok=false"
    );
  });

  it("New York (EDT) write at 09:05: negative offset and write_window_ok=true", () => {
    const line = formatG4WindowLine(
      computeG4WriteWindow(at("America/New_York", "2026-10-27T09:05"), "America/New_York")
    );
    expect(line).toBe(
      "g4_window shop_tz_offset=-04:00 next_enqueue_utc=13:15Z " +
        "next_enqueue_local=09:15 last_enqueue_local_today=18:15 write_window_ok=true"
    );
    expect(line).not.toContain("New_York");
  });

  it("New York (EDT) write at 18:16: write_window_ok=false", () => {
    const line = formatG4WindowLine(
      computeG4WriteWindow(at("America/New_York", "2026-10-27T18:16"), "America/New_York")
    );
    expect(line).toBe(
      "g4_window shop_tz_offset=-04:00 next_enqueue_utc=23:15Z " +
        "next_enqueue_local=19:15 last_enqueue_local_today=18:15 write_window_ok=false"
    );
  });
});

describe("formatG4ChecksLine", () => {
  // Fixed-key enums/booleans only: no ids, emails, amounts, or tz names.
  it("reports all checks passing (free slot)", () => {
    expect(
      formatG4ChecksLine({ writeWindowOk: true, otherSendableOk: true, fixtureSlot: "free" })
    ).toBe("g4_checks write_window_ok=true other_sendable_ok=true fixture_slot=free");
  });

  it("reports failed checks (closed window, buyer due, taken slot)", () => {
    const line = formatG4ChecksLine({
      writeWindowOk: false,
      otherSendableOk: false,
      fixtureSlot: "taken",
    });
    expect(line).toBe(
      "g4_checks write_window_ok=false other_sendable_ok=false fixture_slot=taken"
    );
    expect(line).not.toContain("@");
  });
});

describe("formatG4CleanupWindowLine", () => {
  it("IST at 19:44 (UTC :14): blocked, utc_minute zero-padded", () => {
    const line = formatG4CleanupWindowLine(computeG4CleanupWindow(at("Asia/Kolkata", "2026-10-27T19:44")));
    expect(line).toBe("g4_cleanup_window utc_minute=14 blocked=true");
  });

  it("New York at local :45 (UTC :45): not blocked", () => {
    const line = formatG4CleanupWindowLine(computeG4CleanupWindow(at("America/New_York", "2026-10-27T10:45")));
    expect(line).toBe("g4_cleanup_window utc_minute=45 blocked=false");
  });

  it("zero-pads a single-digit UTC minute", () => {
    const line = formatG4CleanupWindowLine(computeG4CleanupWindow(at("America/New_York", "2026-10-27T10:07")));
    expect(line).toBe("g4_cleanup_window utc_minute=07 blocked=false");
  });
});
