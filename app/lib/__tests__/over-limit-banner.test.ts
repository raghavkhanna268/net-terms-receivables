import { describe, it, expect } from "vitest";
import {
  buildOverLimitBannerState,
  buildAccountOverLimitBannerState,
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

    it("shows banner when gatingEnforced is false (flag-off behavior)", () => {
      const state = buildOverLimitBannerState(3, false);
      expect(state.show).toBe(true);
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

    it("lists limited actions: reminders, credit-limit edits, account-detail edits, bulk statement import", () => {
      const state = buildOverLimitBannerState(1, true);
      expect(state.bodyText).toContain("reminders");
      expect(state.bodyText).toContain("credit-limit edits");
      expect(state.bodyText).toContain("account-detail edits");
      expect(state.bodyText).toContain("bulk statement import");
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

  describe("enforcement note (gatingEnforced flag)", () => {
    it("returns null enforcementNote when gatingEnforced is true", () => {
      const state = buildOverLimitBannerState(1, true);
      expect(state.enforcementNote).toBeNull();
    });

    it("returns enforcement note when gatingEnforced is false", () => {
      const state = buildOverLimitBannerState(1, false);
      expect(state.enforcementNote).toBe("(Limits are not currently enforced.)");
    });

    it("enforcement note is shown even with multiple accounts", () => {
      const state = buildOverLimitBannerState(10, false);
      expect(state.enforcementNote).toBe("(Limits are not currently enforced.)");
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

    it("enforcement note contains no currency symbols", () => {
      const state = buildOverLimitBannerState(1, false);
      expect(state.enforcementNote).not.toContain("$");
      expect(state.enforcementNote).not.toContain("₹");
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

    it("shows banner when gatingEnforced is false (flag-off behavior)", () => {
      const state = buildAccountOverLimitBannerState(true, false);
      expect(state.show).toBe(true);
    });

    it("hides banner when account is not gated even if gatingEnforced is false", () => {
      const state = buildAccountOverLimitBannerState(false, false);
      expect(state.show).toBe(false);
    });
  });

  describe("banner heading", () => {
    it("uses 'This account is over your plan limit'", () => {
      const state = buildAccountOverLimitBannerState(true, true);
      expect(state.heading).toBe("This account is over your plan limit");
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
      expect(state.bodyText).toContain("bulk statement import");
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

  describe("enforcement note (gatingEnforced flag)", () => {
    it("returns null enforcementNote when gatingEnforced is true", () => {
      const state = buildAccountOverLimitBannerState(true, true);
      expect(state.enforcementNote).toBeNull();
    });

    it("returns enforcement note when gatingEnforced is false", () => {
      const state = buildAccountOverLimitBannerState(true, false);
      expect(state.enforcementNote).toBe("(Limits are not currently enforced.)");
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

