import { describe, it, expect } from "vitest";
import {
  inferDueDate,
  getEndOfDayInTimezone,
  addDaysAndGetEndOfDay,
  INFERENCE_ORDER,
  type InferDueDateInput,
} from "./due-date";

describe("due-date", () => {
  describe("INFERENCE_ORDER constant", () => {
    it("has accountDefault before tagRule before shopDefault by default", () => {
      expect(INFERENCE_ORDER).toEqual([
        "accountDefault",
        "tagRule",
        "shopDefault",
      ]);
    });
  });

  describe("getEndOfDayInTimezone", () => {
    it("returns 23:59:59.999 IST as UTC for a date in Asia/Kolkata", () => {
      // 2024-01-15 at noon UTC
      const date = new Date("2024-01-15T12:00:00.000Z");
      const result = getEndOfDayInTimezone(date, "Asia/Kolkata");

      // IST is UTC+5:30, so 23:59:59.999 IST = 18:29:59.999 UTC
      expect(result.getUTCHours()).toBe(18);
      expect(result.getUTCMinutes()).toBe(29);
      expect(result.getUTCSeconds()).toBe(59);
      expect(result.getUTCMilliseconds()).toBe(999);
      expect(result.getUTCDate()).toBe(15);
    });

    it("handles date near midnight IST correctly (23:30 IST)", () => {
      // 23:30 IST on Jan 15 = 18:00 UTC on Jan 15
      const date = new Date("2024-01-15T18:00:00.000Z");
      const result = getEndOfDayInTimezone(date, "Asia/Kolkata");

      // Should still be end of Jan 15 in IST
      expect(result.getUTCDate()).toBe(15);
      expect(result.getUTCHours()).toBe(18);
      expect(result.getUTCMinutes()).toBe(29);
    });

    it("handles date just after midnight IST (00:30 IST)", () => {
      // 00:30 IST on Jan 16 = 19:00 UTC on Jan 15
      const date = new Date("2024-01-15T19:00:00.000Z");
      const result = getEndOfDayInTimezone(date, "Asia/Kolkata");

      // Should be end of Jan 16 in IST (since 19:00 UTC = 00:30 IST on Jan 16)
      expect(result.getUTCDate()).toBe(16);
      expect(result.getUTCHours()).toBe(18);
      expect(result.getUTCMinutes()).toBe(29);
    });

    it("handles non-IST timezone (America/New_York)", () => {
      // Jan 15, 2024 at noon EST
      const date = new Date("2024-01-15T17:00:00.000Z"); // noon EST
      const result = getEndOfDayInTimezone(date, "America/New_York");

      // EST is UTC-5, so 23:59:59.999 EST = 04:59:59.999 UTC next day
      expect(result.getUTCDate()).toBe(16);
      expect(result.getUTCHours()).toBe(4);
      expect(result.getUTCMinutes()).toBe(59);
      expect(result.getUTCSeconds()).toBe(59);
    });

    it("handles DST-observing timezone (America/Los_Angeles in summer)", () => {
      // July 15, 2024 during PDT (UTC-7)
      const date = new Date("2024-07-15T19:00:00.000Z"); // noon PDT
      const result = getEndOfDayInTimezone(date, "America/Los_Angeles");

      // PDT is UTC-7, so 23:59:59.999 PDT = 06:59:59.999 UTC next day
      expect(result.getUTCDate()).toBe(16);
      expect(result.getUTCHours()).toBe(6);
      expect(result.getUTCMinutes()).toBe(59);
    });

    it("handles DST-observing timezone (America/Los_Angeles in winter)", () => {
      // Jan 15, 2024 during PST (UTC-8)
      const date = new Date("2024-01-15T20:00:00.000Z"); // noon PST
      const result = getEndOfDayInTimezone(date, "America/Los_Angeles");

      // PST is UTC-8, so 23:59:59.999 PST = 07:59:59.999 UTC next day
      expect(result.getUTCDate()).toBe(16);
      expect(result.getUTCHours()).toBe(7);
      expect(result.getUTCMinutes()).toBe(59);
    });
  });

  describe("addDaysAndGetEndOfDay", () => {
    it("adds days correctly in IST", () => {
      const base = new Date("2024-01-15T12:00:00.000Z");
      const result = addDaysAndGetEndOfDay(base, 30, "Asia/Kolkata");

      // Should be end of Feb 14 IST
      expect(result.getUTCMonth()).toBe(1); // February
      expect(result.getUTCDate()).toBe(14);
      expect(result.getUTCHours()).toBe(18);
      expect(result.getUTCMinutes()).toBe(29);
    });

    it("adds 0 days (same day end)", () => {
      const base = new Date("2024-01-15T12:00:00.000Z");
      const result = addDaysAndGetEndOfDay(base, 0, "Asia/Kolkata");

      expect(result.getUTCDate()).toBe(15);
      expect(result.getUTCHours()).toBe(18);
      expect(result.getUTCMinutes()).toBe(29);
    });

    it("handles month boundary", () => {
      const base = new Date("2024-01-25T12:00:00.000Z");
      const result = addDaysAndGetEndOfDay(base, 10, "Asia/Kolkata");

      // Should be end of Feb 4
      expect(result.getUTCMonth()).toBe(1); // February
      expect(result.getUTCDate()).toBe(4);
    });

    it("handles year boundary", () => {
      const base = new Date("2024-12-25T12:00:00.000Z");
      const result = addDaysAndGetEndOfDay(base, 10, "Asia/Kolkata");

      // Should be end of Jan 4, 2025
      expect(result.getUTCFullYear()).toBe(2025);
      expect(result.getUTCMonth()).toBe(0); // January
      expect(result.getUTCDate()).toBe(4);
    });
  });

  describe("inferDueDate", () => {
    const baseInput: InferDueDateInput = {
      paymentTerms: null,
      orderCreatedAt: new Date("2024-01-15T12:00:00.000Z"),
      fulfilledAt: null,
      accountDefaultTermsDays: null,
      accountDefaultTermsSource: null,
      tagRules: [],
      customerTags: [],
      shopDefaultTermsDays: null,
      merchantOverrideDueAt: null,
      shopTimezone: "Asia/Kolkata",
    };

    describe("precedence: PaymentSchedule (highest priority)", () => {
      it("uses schedule dueAt when present", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          paymentTerms: {
            type: "NET",
            dueInDays: 30,
            schedules: [
              {
                dueAt: new Date("2024-02-15T18:29:59.999Z"),
                completedAt: null,
              },
            ],
          },
          accountDefaultTermsDays: 60,
          accountDefaultTermsSource: "explicit",
          tagRules: [{ tag: "net30", defaultTermsDays: 30 }],
          customerTags: ["net30"],
        };

        const result = inferDueDate(input);

        expect(result.dueSource).toBe("schedule");
        expect(result.basis).toBeNull();
        expect(result.dueAt?.toISOString()).toBe("2024-02-15T18:29:59.999Z");
        expect(result.reason).toContain("Payment schedule");
      });

      it("uses earliest non-completed schedule when multiple exist", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          paymentTerms: {
            type: "NET",
            dueInDays: 30,
            schedules: [
              {
                dueAt: new Date("2024-03-15T18:29:59.999Z"),
                completedAt: null,
              },
              {
                dueAt: new Date("2024-02-15T18:29:59.999Z"),
                completedAt: null,
              },
              {
                dueAt: new Date("2024-04-15T18:29:59.999Z"),
                completedAt: null,
              },
            ],
          },
        };

        const result = inferDueDate(input);

        expect(result.dueSource).toBe("schedule");
        expect(result.dueAt?.toISOString()).toBe("2024-02-15T18:29:59.999Z");
        expect(result.reason).toContain("Earliest of 3 pending");
      });

      it("uses last schedule when all are completed", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          paymentTerms: {
            type: "NET",
            dueInDays: 30,
            schedules: [
              {
                dueAt: new Date("2024-02-15T18:29:59.999Z"),
                completedAt: new Date("2024-02-10T12:00:00.000Z"),
              },
              {
                dueAt: new Date("2024-03-15T18:29:59.999Z"),
                completedAt: new Date("2024-03-10T12:00:00.000Z"),
              },
            ],
          },
        };

        const result = inferDueDate(input);

        expect(result.dueSource).toBe("schedule");
        expect(result.dueAt?.toISOString()).toBe("2024-03-15T18:29:59.999Z");
        expect(result.reason).toContain("all payments completed");
      });

      it("skips completed schedules and uses earliest pending", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          paymentTerms: {
            type: "NET",
            dueInDays: 30,
            schedules: [
              {
                dueAt: new Date("2024-02-15T18:29:59.999Z"),
                completedAt: new Date("2024-02-10T12:00:00.000Z"),
              },
              {
                dueAt: new Date("2024-03-15T18:29:59.999Z"),
                completedAt: null,
              },
              {
                dueAt: new Date("2024-04-15T18:29:59.999Z"),
                completedAt: null,
              },
            ],
          },
        };

        const result = inferDueDate(input);

        expect(result.dueSource).toBe("schedule");
        expect(result.dueAt?.toISOString()).toBe("2024-03-15T18:29:59.999Z");
        expect(result.reason).toContain("Earliest of 2 pending");
      });
    });

    describe("FULFILLMENT terms", () => {
      it("returns null with reason when no fulfillment date", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          paymentTerms: {
            type: "FULFILLMENT",
            dueInDays: 0,
            schedules: [{ dueAt: null, completedAt: null }],
          },
          fulfilledAt: null,
        };

        const result = inferDueDate(input);

        expect(result.dueSource).toBe("schedule");
        expect(result.dueAt).toBeNull();
        expect(result.reason).toContain("unknown until order is fulfilled");
      });

      it("calculates due date from fulfillment date", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          paymentTerms: {
            type: "FULFILLMENT",
            dueInDays: 15,
            schedules: [{ dueAt: null, completedAt: null }],
          },
          fulfilledAt: new Date("2024-02-01T12:00:00.000Z"),
        };

        const result = inferDueDate(input);

        expect(result.dueSource).toBe("schedule");
        expect(result.dueAt).not.toBeNull();
        // Feb 1 + 15 days = Feb 16, end of day IST
        expect(result.dueAt?.getUTCMonth()).toBe(1);
        expect(result.dueAt?.getUTCDate()).toBe(16);
        expect(result.reason).toContain("net 15 days from fulfillment");
      });

      it("uses schedule dueAt if Shopify already set it", () => {
        const shopifySetDueAt = new Date("2024-02-20T18:29:59.999Z");
        const input: InferDueDateInput = {
          ...baseInput,
          paymentTerms: {
            type: "FULFILLMENT",
            dueInDays: 0,
            schedules: [{ dueAt: shopifySetDueAt, completedAt: null }],
          },
          fulfilledAt: new Date("2024-02-01T12:00:00.000Z"),
        };

        const result = inferDueDate(input);

        expect(result.dueSource).toBe("schedule");
        expect(result.dueAt?.toISOString()).toBe(shopifySetDueAt.toISOString());
        expect(result.reason).toContain("schedule set by Shopify");
      });
    });

    describe("RECEIPT terms", () => {
      it("returns order created date as due date", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          orderCreatedAt: new Date("2024-01-15T12:00:00.000Z"),
          paymentTerms: {
            type: "RECEIPT",
            dueInDays: 0,
            schedules: [{ dueAt: null, completedAt: null }],
          },
        };

        const result = inferDueDate(input);

        expect(result.dueSource).toBe("schedule");
        expect(result.dueAt).not.toBeNull();
        // End of Jan 15 IST
        expect(result.dueAt?.getUTCDate()).toBe(15);
        expect(result.dueAt?.getUTCHours()).toBe(18);
        expect(result.dueAt?.getUTCMinutes()).toBe(29);
        expect(result.reason).toContain("due on receipt");
      });
    });

    describe("merchant override", () => {
      it("beats inferred sources when no schedule exists", () => {
        const overrideDate = new Date("2024-03-01T18:29:59.999Z");
        const input: InferDueDateInput = {
          ...baseInput,
          merchantOverrideDueAt: overrideDate,
          accountDefaultTermsDays: 30,
          accountDefaultTermsSource: "explicit",
          tagRules: [{ tag: "net60", defaultTermsDays: 60 }],
          customerTags: ["net60"],
          shopDefaultTermsDays: 45,
        };

        const result = inferDueDate(input);

        expect(result.dueSource).toBe("override");
        expect(result.basis).toBeNull();
        expect(result.dueAt?.toISOString()).toBe(overrideDate.toISOString());
        expect(result.reason).toBe("Merchant override for this invoice");
      });

      it("is ignored when a schedule exists and notes it in reason", () => {
        const overrideDate = new Date("2024-03-01T18:29:59.999Z");
        const scheduleDueAt = new Date("2024-02-15T18:29:59.999Z");
        const input: InferDueDateInput = {
          ...baseInput,
          merchantOverrideDueAt: overrideDate,
          paymentTerms: {
            type: "NET",
            dueInDays: 30,
            schedules: [{ dueAt: scheduleDueAt, completedAt: null }],
          },
        };

        const result = inferDueDate(input);

        expect(result.dueSource).toBe("schedule");
        expect(result.dueAt?.toISOString()).toBe(scheduleDueAt.toISOString());
        expect(result.reason).toContain("merchant override ignored");
        expect(result.reason).toContain("change terms in Shopify");
      });
    });

    describe("account defaultTermsDays (explicit)", () => {
      it("uses explicit account default when no payment schedule", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          paymentTerms: null,
          accountDefaultTermsDays: 45,
          accountDefaultTermsSource: "explicit",
          tagRules: [{ tag: "net30", defaultTermsDays: 30 }],
          customerTags: ["net30"],
        };

        const result = inferDueDate(input);

        expect(result.dueSource).toBe("inferred");
        expect(result.basis).toBe("accountDefault");
        expect(result.reason).toContain("Account default: net 45 days");
        // Jan 15 + 45 days = Feb 29 (2024 is a leap year)
        expect(result.dueAt?.getUTCMonth()).toBe(1); // February
        expect(result.dueAt?.getUTCDate()).toBe(29);
      });

      it("explicit account default beats matching tag rule", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          paymentTerms: null,
          accountDefaultTermsDays: 60,
          accountDefaultTermsSource: "explicit",
          tagRules: [{ tag: "net30", defaultTermsDays: 30 }],
          customerTags: ["net30"],
        };

        const result = inferDueDate(input);

        expect(result.dueSource).toBe("inferred");
        expect(result.basis).toBe("accountDefault");
        expect(result.reason).toContain("Account default: net 60 days");
      });

      it("handles 0 days account default", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          accountDefaultTermsDays: 0,
          accountDefaultTermsSource: "explicit",
        };

        const result = inferDueDate(input);

        expect(result.dueSource).toBe("inferred");
        expect(result.basis).toBe("accountDefault");
        expect(result.reason).toContain("net 0 days");
        expect(result.dueAt?.getUTCDate()).toBe(15);
      });
    });

    describe("tag-copied account default", () => {
      it("skips tag-copied account default in favour of tag rule", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          accountDefaultTermsDays: 30,
          accountDefaultTermsSource: "tag",
          tagRules: [{ tag: "net45", defaultTermsDays: 45 }],
          customerTags: ["net45"],
        };

        const result = inferDueDate(input);

        expect(result.dueSource).toBe("inferred");
        expect(result.basis).toBe("tagRule");
        expect(result.reason).toContain("Tag rule 'net45': net 45 days");
      });

      it("uses tag-copied default when no current tag rule matches", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          accountDefaultTermsDays: 30,
          accountDefaultTermsSource: "tag",
          tagRules: [{ tag: "net45", defaultTermsDays: 45 }],
          customerTags: ["vip"], // Does not match net45
        };

        const result = inferDueDate(input);

        expect(result.dueSource).toBe("inferred");
        expect(result.basis).toBe("tagRule");
        expect(result.reason).toContain("Tag-derived account default");
        expect(result.reason).toContain("net 30 days");
        expect(result.reason).toContain("no current tag rule matched");
      });

      it("falls through to shop default if tag-copied and no match and no account default", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          accountDefaultTermsDays: null,
          accountDefaultTermsSource: "tag",
          tagRules: [{ tag: "net45", defaultTermsDays: 45 }],
          customerTags: ["vip"],
          shopDefaultTermsDays: 60,
        };

        const result = inferDueDate(input);

        expect(result.dueSource).toBe("inferred");
        expect(result.basis).toBe("shopDefault");
        expect(result.reason).toContain("Shop default: net 60 days");
      });
    });

    describe("tag rules", () => {
      it("matches tag case-insensitively", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          tagRules: [{ tag: "Net30", defaultTermsDays: 30 }],
          customerTags: ["NET30"],
        };

        const result = inferDueDate(input);

        expect(result.dueSource).toBe("inferred");
        expect(result.basis).toBe("tagRule");
        expect(result.reason).toContain("Tag rule");
      });

      it("matches tag with whitespace trimmed", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          tagRules: [{ tag: "  net30  ", defaultTermsDays: 30 }],
          customerTags: ["net30"],
        };

        const result = inferDueDate(input);

        expect(result.dueSource).toBe("inferred");
        expect(result.basis).toBe("tagRule");
        expect(result.reason).toContain("Tag rule");
      });

      it("handles customer tag with whitespace", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          tagRules: [{ tag: "net30", defaultTermsDays: 30 }],
          customerTags: ["  NET30  "],
        };

        const result = inferDueDate(input);

        expect(result.dueSource).toBe("inferred");
        expect(result.basis).toBe("tagRule");
        expect(result.reason).toContain("Tag rule");
      });

      it("picks largest terms days when multiple rules match (conservative)", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          tagRules: [
            { tag: "net30", defaultTermsDays: 30 },
            { tag: "wholesale", defaultTermsDays: 45 },
            { tag: "premium", defaultTermsDays: 60 },
          ],
          customerTags: ["net30", "wholesale", "premium"],
        };

        const result = inferDueDate(input);

        expect(result.dueSource).toBe("inferred");
        expect(result.basis).toBe("tagRule");
        expect(result.reason).toContain("net 60 days");
        expect(result.reason).toContain("3 rules matched");
        expect(result.reason).toContain("using largest");
      });

      it("notes when multiple rules match", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          tagRules: [
            { tag: "net30", defaultTermsDays: 30 },
            { tag: "wholesale", defaultTermsDays: 45 },
          ],
          customerTags: ["net30", "wholesale"],
        };

        const result = inferDueDate(input);

        expect(result.reason).toContain("2 rules matched");
        expect(result.reason).toContain("net30");
        expect(result.reason).toContain("wholesale");
      });

      it("returns correct due date for single matching rule", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          orderCreatedAt: new Date("2024-01-15T12:00:00.000Z"),
          tagRules: [{ tag: "net30", defaultTermsDays: 30 }],
          customerTags: ["net30", "vip"],
        };

        const result = inferDueDate(input);

        expect(result.dueSource).toBe("inferred");
        expect(result.basis).toBe("tagRule");
        // Jan 15 + 30 days = Feb 14
        expect(result.dueAt?.getUTCMonth()).toBe(1);
        expect(result.dueAt?.getUTCDate()).toBe(14);
        expect(result.reason).toBe("Tag rule 'net30': net 30 days");
      });

      it("falls through to shop default when no tags match", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          tagRules: [{ tag: "net30", defaultTermsDays: 30 }],
          customerTags: ["vip", "premium"],
          shopDefaultTermsDays: 45,
        };

        const result = inferDueDate(input);

        expect(result.dueSource).toBe("inferred");
        expect(result.basis).toBe("shopDefault");
      });
    });

    describe("shop default (last fallback)", () => {
      it("uses shop default when no other source available", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          shopDefaultTermsDays: 30,
        };

        const result = inferDueDate(input);

        expect(result.dueSource).toBe("inferred");
        expect(result.basis).toBe("shopDefault");
        expect(result.reason).toContain("Shop default: net 30 days");
        // Jan 15 + 30 days = Feb 14
        expect(result.dueAt?.getUTCMonth()).toBe(1);
        expect(result.dueAt?.getUTCDate()).toBe(14);
      });

      it("is used after account default and tag rules fail", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          accountDefaultTermsDays: null,
          accountDefaultTermsSource: null,
          tagRules: [{ tag: "net30", defaultTermsDays: 30 }],
          customerTags: ["vip"], // Does not match
          shopDefaultTermsDays: 45,
        };

        const result = inferDueDate(input);

        expect(result.dueSource).toBe("inferred");
        expect(result.basis).toBe("shopDefault");
        expect(result.reason).toContain("Shop default: net 45 days");
      });

      it("handles 0 days shop default", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          shopDefaultTermsDays: 0,
        };

        const result = inferDueDate(input);

        expect(result.dueSource).toBe("inferred");
        expect(result.basis).toBe("shopDefault");
        expect(result.reason).toContain("net 0 days");
        expect(result.dueAt?.getUTCDate()).toBe(15);
      });
    });

    describe("no source available", () => {
      it("returns none when nothing is configured", () => {
        const result = inferDueDate(baseInput);

        expect(result.dueAt).toBeNull();
        expect(result.dueSource).toBe("none");
        expect(result.basis).toBeNull();
        expect(result.reason).toContain("No payment terms");
      });

      it("returns none when tag rules exist but no customer tags", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          tagRules: [{ tag: "net30", defaultTermsDays: 30 }],
          customerTags: [],
        };

        const result = inferDueDate(input);

        expect(result.dueSource).toBe("none");
      });

      it("returns none when customer tags exist but no rules and no other fallbacks", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          tagRules: [],
          customerTags: ["net30"],
        };

        const result = inferDueDate(input);

        expect(result.dueSource).toBe("none");
      });
    });

    describe("configurable inference order", () => {
      it("uses reversed order when tagRule comes before accountDefault", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          accountDefaultTermsDays: 60,
          accountDefaultTermsSource: "explicit",
          tagRules: [{ tag: "net30", defaultTermsDays: 30 }],
          customerTags: ["net30"],
          inferenceOrder: ["tagRule", "accountDefault", "shopDefault"],
        };

        const result = inferDueDate(input);

        // Tag rule should win because it's first in the custom order
        expect(result.dueSource).toBe("inferred");
        expect(result.basis).toBe("tagRule");
        expect(result.reason).toContain("Tag rule 'net30': net 30 days");
        // Jan 15 + 30 days = Feb 14
        expect(result.dueAt?.getUTCMonth()).toBe(1);
        expect(result.dueAt?.getUTCDate()).toBe(14);
      });

      it("falls through in custom order when first source unavailable", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          accountDefaultTermsDays: 60,
          accountDefaultTermsSource: "explicit",
          tagRules: [{ tag: "net30", defaultTermsDays: 30 }],
          customerTags: ["vip"], // No match
          inferenceOrder: ["tagRule", "accountDefault", "shopDefault"],
        };

        const result = inferDueDate(input);

        // Tag rule has no match, so account default should be used
        expect(result.dueSource).toBe("inferred");
        expect(result.basis).toBe("accountDefault");
        expect(result.reason).toContain("Account default: net 60 days");
      });

      it("respects shopDefault position in custom order", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          accountDefaultTermsDays: 60,
          accountDefaultTermsSource: "explicit",
          tagRules: [{ tag: "net30", defaultTermsDays: 30 }],
          customerTags: ["net30"],
          shopDefaultTermsDays: 15,
          inferenceOrder: ["shopDefault", "tagRule", "accountDefault"],
        };

        const result = inferDueDate(input);

        // Shop default should win because it's first
        expect(result.dueSource).toBe("inferred");
        expect(result.basis).toBe("shopDefault");
        expect(result.reason).toContain("Shop default: net 15 days");
      });
    });

    describe("IST end-of-day boundaries", () => {
      it("handles order created at 23:30 IST (still same day)", () => {
        // 23:30 IST = 18:00 UTC
        const input: InferDueDateInput = {
          ...baseInput,
          orderCreatedAt: new Date("2024-01-15T18:00:00.000Z"),
          accountDefaultTermsDays: 1,
          accountDefaultTermsSource: "explicit",
        };

        const result = inferDueDate(input);

        // Should be end of Jan 16 IST (1 day later)
        expect(result.dueAt?.getUTCDate()).toBe(16);
        expect(result.dueAt?.getUTCHours()).toBe(18);
        expect(result.dueAt?.getUTCMinutes()).toBe(29);
      });

      it("handles order created at 00:30 IST (next UTC day)", () => {
        // 00:30 IST on Jan 16 = 19:00 UTC on Jan 15
        const input: InferDueDateInput = {
          ...baseInput,
          orderCreatedAt: new Date("2024-01-15T19:00:00.000Z"),
          accountDefaultTermsDays: 1,
          accountDefaultTermsSource: "explicit",
        };

        const result = inferDueDate(input);

        // Should be end of Jan 17 IST (order is on Jan 16 IST + 1 day)
        expect(result.dueAt?.getUTCDate()).toBe(17);
      });

      it("handles order at exact midnight IST", () => {
        // Midnight IST on Jan 16 = 18:30 UTC on Jan 15
        const input: InferDueDateInput = {
          ...baseInput,
          orderCreatedAt: new Date("2024-01-15T18:30:00.000Z"),
          accountDefaultTermsDays: 0,
          accountDefaultTermsSource: "explicit",
        };

        const result = inferDueDate(input);

        // Should be end of Jan 16 IST (the day it was created in IST)
        expect(result.dueAt?.getUTCDate()).toBe(16);
        expect(result.dueAt?.getUTCHours()).toBe(18);
        expect(result.dueAt?.getUTCMinutes()).toBe(29);
      });
    });

    describe("non-IST timezone", () => {
      it("calculates correctly for America/New_York", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          orderCreatedAt: new Date("2024-01-15T17:00:00.000Z"), // noon EST
          accountDefaultTermsDays: 30,
          accountDefaultTermsSource: "explicit",
          shopTimezone: "America/New_York",
        };

        const result = inferDueDate(input);

        // Jan 15 + 30 days = Feb 14, end of day EST
        // EST is UTC-5, so 23:59:59 EST = 04:59:59 UTC next day
        expect(result.dueAt?.getUTCMonth()).toBe(1); // February
        expect(result.dueAt?.getUTCDate()).toBe(15); // Feb 15 in UTC (Feb 14 EOD EST)
        expect(result.dueAt?.getUTCHours()).toBe(4);
        expect(result.dueAt?.getUTCMinutes()).toBe(59);
      });

      it("handles Europe/London with DST", () => {
        // Summer time in London (BST = UTC+1)
        const input: InferDueDateInput = {
          ...baseInput,
          orderCreatedAt: new Date("2024-07-15T12:00:00.000Z"),
          accountDefaultTermsDays: 30,
          accountDefaultTermsSource: "explicit",
          shopTimezone: "Europe/London",
        };

        const result = inferDueDate(input);

        // July 15 + 30 days = Aug 14, end of day BST
        // BST is UTC+1, so 23:59:59 BST = 22:59:59 UTC
        expect(result.dueAt?.getUTCMonth()).toBe(7); // August
        expect(result.dueAt?.getUTCDate()).toBe(14);
        expect(result.dueAt?.getUTCHours()).toBe(22);
        expect(result.dueAt?.getUTCMinutes()).toBe(59);
      });

      it("defaults to Asia/Kolkata when no timezone specified", () => {
        const input: InferDueDateInput = {
          paymentTerms: null,
          orderCreatedAt: new Date("2024-01-15T12:00:00.000Z"),
          fulfilledAt: null,
          accountDefaultTermsDays: 30,
          accountDefaultTermsSource: "explicit",
          tagRules: [],
          customerTags: [],
          shopDefaultTermsDays: null,
          merchantOverrideDueAt: null,
          // shopTimezone not specified
        };

        const result = inferDueDate(input);

        // Should use IST (UTC+5:30)
        expect(result.dueAt?.getUTCHours()).toBe(18);
        expect(result.dueAt?.getUTCMinutes()).toBe(29);
      });
    });

    describe("edge cases", () => {
      it("handles empty schedules array with RECEIPT type", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          paymentTerms: {
            type: "RECEIPT",
            dueInDays: 0,
            schedules: [],
          },
        };

        // RECEIPT type should still work even with empty schedules
        const result = inferDueDate(input);

        expect(result.dueSource).toBe("schedule");
        expect(result.dueAt).not.toBeNull();
      });

      it("handles schedule with null dueAt for NET type", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          paymentTerms: {
            type: "NET",
            dueInDays: 30,
            schedules: [{ dueAt: null, completedAt: null }],
          },
          accountDefaultTermsDays: 45,
          accountDefaultTermsSource: "explicit",
        };

        // Should fall back to account default since schedule has no dueAt
        const result = inferDueDate(input);

        expect(result.dueSource).toBe("inferred");
        expect(result.basis).toBe("accountDefault");
        expect(result.reason).toContain("Account default");
      });

      it("handles FIXED type like NET", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          paymentTerms: {
            type: "FIXED",
            dueInDays: null,
            schedules: [
              {
                dueAt: new Date("2024-02-28T18:29:59.999Z"),
                completedAt: null,
              },
            ],
          },
        };

        const result = inferDueDate(input);

        expect(result.dueSource).toBe("schedule");
        expect(result.dueAt?.toISOString()).toBe("2024-02-28T18:29:59.999Z");
      });

      it("handles negative account default gracefully", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          accountDefaultTermsDays: -5,
          accountDefaultTermsSource: "explicit",
        };

        // Negative values should be ignored (not >= 0)
        const result = inferDueDate(input);

        expect(result.dueSource).toBe("none");
      });

      it("handles negative shop default gracefully", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          shopDefaultTermsDays: -5,
        };

        const result = inferDueDate(input);

        expect(result.dueSource).toBe("none");
      });
    });
  });
});
