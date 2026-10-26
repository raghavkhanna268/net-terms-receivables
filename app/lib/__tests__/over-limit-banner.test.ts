import { describe, it, expect } from "vitest";
import {
  buildOverLimitBannerState,
  buildAccountOverLimitBannerState,
  buildNewAccountsPausedBannerState,
} from "../over-limit-banner";

/**
 * S21 UI Tests: Over-limit banner helper.
 *
 * Tests the shared helper functions that determine banner visibility
 * and content. These functions are used by:
 * - app/routes/app.plan.tsx
 * - app/routes/app._index.tsx
 * - app/routes/app.accounts.$id.tsx
 */

describe("buildOverLimitBannerState", () => {
  describe("banner visibility", () => {
    it("shows banner when gatedCount > 0", () => {
      const state = buildOverLimitBannerState(5, true);
      expect(state.show).toBe(true);
    });

    it("hides banner when gatedCount === 0", () => {
      const state = buildOverLimitBannerState(0, true);
      expect(state.show).toBe(false);
    });

    it("hides banner when gatedCount < 0", () => {
      const state = buildOverLimitBannerState(-1, true);
      expect(state.show).toBe(false);
    });

    it("hides banner when gatingEnforced is false (T1: no banner when gating off)", () => {
      const state = buildOverLimitBannerState(3, false);
      expect(state.show).toBe(false);
    });
  });

  describe("banner heading", () => {
    it("uses singular 'account' for gatedCount === 1", () => {
      const state = buildOverLimitBannerState(1, true);
      expect(state.heading).toBe("1 account over your plan limit");
    });

    it("uses plural 'accounts' for gatedCount > 1", () => {
      const state = buildOverLimitBannerState(5, true);
      expect(state.heading).toBe("5 accounts over your plan limit");
    });

    it("includes the exact count in heading", () => {
      const state = buildOverLimitBannerState(42, true);
      expect(state.heading).toBe("42 accounts over your plan limit");
    });
  });

  describe("banner body text", () => {
    it("includes 'Nothing is hidden'", () => {
      const state = buildOverLimitBannerState(1, true);
      expect(state.bodyText).toContain("Nothing is hidden");
    });

    it("includes 'totals include all accounts'", () => {
      const state = buildOverLimitBannerState(1, true);
      expect(state.bodyText).toContain("totals include all accounts");
    });

    it("lists limited actions: reminders, credit-limit edits, account-detail edits", () => {
      const state = buildOverLimitBannerState(1, true);
      expect(state.bodyText).toContain("reminders");
      expect(state.bodyText).toContain("credit-limit edits");
      expect(state.bodyText).toContain("account-detail edits");
    });

    it("states matching, confirming, mark-paid are never gated", () => {
      const state = buildOverLimitBannerState(1, true);
      expect(state.bodyText).toContain("Matching");
      expect(state.bodyText).toContain("confirming a match");
      expect(state.bodyText).toContain("mark-paid");
      expect(state.bodyText).toContain("never gated");
    });

    it("states credit holds and checkout block work on every plan", () => {
      const state = buildOverLimitBannerState(1, true);
      expect(state.bodyText).toContain("Credit holds");
      expect(state.bodyText).toContain("checkout block");
      expect(state.bodyText).toContain("work on every plan");
    });
  });

  describe("enforcement note", () => {
    it("returns null enforcementNote when gatingEnforced is true", () => {
      const state = buildOverLimitBannerState(1, true);
      expect(state.enforcementNote).toBeNull();
    });

    it("banner hidden when gatingEnforced is false (T1: no banner when gating off)", () => {
      const state = buildOverLimitBannerState(1, false);
      expect(state.show).toBe(false);
      expect(state.enforcementNote).toBeNull();
    });
  });

  describe("no price strings", () => {
    it("body text contains no currency symbols", () => {
      const state = buildOverLimitBannerState(1, true);
      expect(state.bodyText).not.toContain("$");
      expect(state.bodyText).not.toContain("₹");
      expect(state.bodyText).not.toContain("€");
      expect(state.bodyText).not.toContain("£");
    });

    it("heading contains no currency symbols", () => {
      const state = buildOverLimitBannerState(1, true);
      expect(state.heading).not.toContain("$");
      expect(state.heading).not.toContain("₹");
    });

    it("enforcement note is null when banner shown (T1: no enforcement note)", () => {
      const state = buildOverLimitBannerState(1, true);
      expect(state.enforcementNote).toBeNull();
    });
  });
});

describe("buildAccountOverLimitBannerState", () => {
  describe("banner visibility", () => {
    it("shows banner when isGated is true", () => {
      const state = buildAccountOverLimitBannerState(true, true);
      expect(state.show).toBe(true);
    });

    it("hides banner when isGated is false", () => {
      const state = buildAccountOverLimitBannerState(false, true);
      expect(state.show).toBe(false);
    });

    it("hides banner when gatingEnforced is false (T1: no banner when gating off)", () => {
      const state = buildAccountOverLimitBannerState(true, false);
      expect(state.show).toBe(false);
    });

    it("hides banner when account is not gated even if gatingEnforced is false", () => {
      const state = buildAccountOverLimitBannerState(false, false);
      expect(state.show).toBe(false);
    });
  });

  describe("banner heading", () => {
    it("uses correct heading for gated account", () => {
      const state = buildAccountOverLimitBannerState(true, true);
      expect(state.heading).toBe("This account was added after you reached your plan limit");
    });
  });

  describe("banner body text", () => {
    it("includes 'Nothing is hidden'", () => {
      const state = buildAccountOverLimitBannerState(true, true);
      expect(state.bodyText).toContain("Nothing is hidden");
    });

    it("lists limited actions", () => {
      const state = buildAccountOverLimitBannerState(true, true);
      expect(state.bodyText).toContain("reminders");
      expect(state.bodyText).toContain("credit-limit");
      expect(state.bodyText).toContain("account-detail edits");
    });

    it("states matching, confirming, mark-paid are never gated", () => {
      const state = buildAccountOverLimitBannerState(true, true);
      expect(state.bodyText).toContain("Matching");
      expect(state.bodyText).toContain("confirming");
      expect(state.bodyText).toContain("mark-paid");
      expect(state.bodyText).toContain("never gated");
    });

    it("states credit holds and checkout block work on every plan", () => {
      const state = buildAccountOverLimitBannerState(true, true);
      expect(state.bodyText).toContain("Credit holds");
      expect(state.bodyText).toContain("checkout block");
      expect(state.bodyText).toContain("work on every plan");
    });
  });

  describe("enforcement note", () => {
    it("returns null enforcementNote when gatingEnforced is true", () => {
      const state = buildAccountOverLimitBannerState(true, true);
      expect(state.enforcementNote).toBeNull();
    });

    it("banner hidden when gatingEnforced is false (T1: no banner when gating off)", () => {
      const state = buildAccountOverLimitBannerState(true, false);
      expect(state.show).toBe(false);
      expect(state.enforcementNote).toBeNull();
    });
  });

  describe("no price strings", () => {
    it("body text contains no currency symbols", () => {
      const state = buildAccountOverLimitBannerState(true, true);
      expect(state.bodyText).not.toContain("$");
      expect(state.bodyText).not.toContain("₹");
    });
  });
});

describe("buildNewAccountsPausedBannerState", () => {
  describe("banner visibility - flag off", () => {
    it("hides banner when gatingEnforced is false", () => {
      const state = buildNewAccountsPausedBannerState(25, 25, false);
      expect(state.show).toBe(false);
      expect(state.heading).toBe("");
      expect(state.bodyText).toBe("");
      expect(state.upgradeUrl).toBeNull();
    });

    it("hides banner when gatingEnforced is false even over limit", () => {
      const state = buildNewAccountsPausedBannerState(30, 25, false);
      expect(state.show).toBe(false);
    });
  });

  describe("banner visibility - unlimited plan", () => {
    it("hides banner when limit is -1 (unlimited)", () => {
      const state = buildNewAccountsPausedBannerState(100, -1, true);
      expect(state.show).toBe(false);
      expect(state.heading).toBe("");
      expect(state.bodyText).toBe("");
      expect(state.upgradeUrl).toBeNull();
    });

    it("hides banner when limit is -1 even with many accounts", () => {
      const state = buildNewAccountsPausedBannerState(1000, -1, true);
      expect(state.show).toBe(false);
    });
  });

  describe("banner visibility - under limit", () => {
    it("hides banner when under limit", () => {
      const state = buildNewAccountsPausedBannerState(20, 25, true);
      expect(state.show).toBe(false);
      expect(state.heading).toBe("");
      expect(state.bodyText).toBe("");
      expect(state.upgradeUrl).toBeNull();
    });

    it("hides banner when at 24 out of 25", () => {
      const state = buildNewAccountsPausedBannerState(24, 25, true);
      expect(state.show).toBe(false);
    });
  });

  describe("banner visibility - at limit", () => {
    it("shows banner when at limit (used === limit)", () => {
      const state = buildNewAccountsPausedBannerState(25, 25, true);
      expect(state.show).toBe(true);
      expect(state.heading).toBe("25 of 25 buyer accounts");
      expect(state.bodyText).toBe("New accounts can't be added or imported over your plan limit.");
    });

    it("shows banner when at starter limit", () => {
      const state = buildNewAccountsPausedBannerState(25, 25, true, "/upgrade");
      expect(state.show).toBe(true);
      expect(state.upgradeUrl).toBe("/upgrade");
    });
  });

  describe("banner visibility - over limit", () => {
    it("shows banner when over limit", () => {
      const state = buildNewAccountsPausedBannerState(30, 25, true);
      expect(state.show).toBe(true);
      expect(state.heading).toBe("30 of 25 buyer accounts");
    });

    it("shows banner when way over limit", () => {
      const state = buildNewAccountsPausedBannerState(100, 25, true);
      expect(state.show).toBe(true);
      expect(state.heading).toBe("100 of 25 buyer accounts");
    });
  });

  describe("banner visibility - none plan (limit 0)", () => {
    it("shows banner when none plan (0 limit) and 0 accounts", () => {
      const state = buildNewAccountsPausedBannerState(0, 0, true);
      expect(state.show).toBe(true);
      expect(state.heading).toBe("0 of 0 buyer accounts");
    });

    it("shows banner when none plan (0 limit) and 1 account", () => {
      const state = buildNewAccountsPausedBannerState(1, 0, true);
      expect(state.show).toBe(true);
      expect(state.heading).toBe("1 of 0 buyer accounts");
    });
  });

  describe("upgrade URL handling", () => {
    it("returns null upgradeUrl by default", () => {
      const state = buildNewAccountsPausedBannerState(25, 25, true);
      expect(state.upgradeUrl).toBeNull();
    });

    it("returns provided upgradeUrl when at limit", () => {
      const state = buildNewAccountsPausedBannerState(25, 25, true, "https://example.com/upgrade");
      expect(state.upgradeUrl).toBe("https://example.com/upgrade");
    });

    it("returns null upgradeUrl when not shown (under limit)", () => {
      const state = buildNewAccountsPausedBannerState(20, 25, true, "https://example.com/upgrade");
      expect(state.show).toBe(false);
      expect(state.upgradeUrl).toBeNull();
    });

    it("returns null upgradeUrl when not shown (flag off)", () => {
      const state = buildNewAccountsPausedBannerState(25, 25, false, "https://example.com/upgrade");
      expect(state.show).toBe(false);
      expect(state.upgradeUrl).toBeNull();
    });

    it("handles null upgradeUrl explicitly", () => {
      const state = buildNewAccountsPausedBannerState(25, 25, true, null);
      expect(state.show).toBe(true);
      expect(state.upgradeUrl).toBeNull();
    });
  });

  describe("banner content", () => {
    it("heading shows exact counts", () => {
      // Must be at or over limit for banner to show
      const state = buildNewAccountsPausedBannerState(100, 100, true);
      expect(state.heading).toBe("100 of 100 buyer accounts");
    });

    it("body text mentions new accounts can't be added", () => {
      const state = buildNewAccountsPausedBannerState(25, 25, true);
      expect(state.bodyText).toContain("New accounts can't be added");
    });

    it("body text mentions imported", () => {
      const state = buildNewAccountsPausedBannerState(25, 25, true);
      expect(state.bodyText).toContain("imported");
    });

    it("body text mentions plan limit", () => {
      const state = buildNewAccountsPausedBannerState(25, 25, true);
      expect(state.bodyText).toContain("plan limit");
    });
  });

  describe("no price strings", () => {
    it("heading contains no currency symbols", () => {
      const state = buildNewAccountsPausedBannerState(25, 25, true);
      expect(state.heading).not.toContain("$");
      expect(state.heading).not.toContain("₹");
      expect(state.heading).not.toContain("€");
      expect(state.heading).not.toContain("£");
    });

    it("body text contains no currency symbols", () => {
      const state = buildNewAccountsPausedBannerState(25, 25, true);
      expect(state.bodyText).not.toContain("$");
      expect(state.bodyText).not.toContain("₹");
      expect(state.bodyText).not.toContain("€");
      expect(state.bodyText).not.toContain("£");
    });
  });
});
