import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import {
  inferDueDate,
  addDaysAndGetEndOfDay,
  endOfLocalDay,
  INFERENCE_ORDER,
  type InferDueDateInput,
} from "./due-date";

/**
 * Reference implementation using Luxon for independent verification.
 * Used in sweep tests to validate our Intl-based implementation.
 */
function luxonEndOfLocalDay(
  year: number,
  month: number,
  day: number,
  timezone: string
): Date {
  const dt = DateTime.fromObject(
    { year, month, day, hour: 23, minute: 59, second: 59, millisecond: 999 },
    { zone: timezone }
  );
  return dt.toJSDate();
}

function luxonAddDaysEOD(base: Date, days: number, timezone: string): Date {
  const dt = DateTime.fromJSDate(base, { zone: timezone });
  const target = dt.plus({ days }).endOf("day");
  return target.toJSDate();
}

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

  describe("endOfLocalDay", () => {
    describe("basic timezone handling", () => {
      it("Asia/Kolkata (+5:30) - 2024-01-15", () => {
        const result = endOfLocalDay(2024, 1, 15, "Asia/Kolkata");
        expect(result.toISOString()).toBe("2024-01-15T18:29:59.999Z");
      });

      it("Asia/Kathmandu (+5:45) - 2024-01-15", () => {
        const result = endOfLocalDay(2024, 1, 15, "Asia/Kathmandu");
        expect(result.toISOString()).toBe("2024-01-15T18:14:59.999Z");
      });

      it("UTC - 2024-01-15", () => {
        const result = endOfLocalDay(2024, 1, 15, "UTC");
        expect(result.toISOString()).toBe("2024-01-15T23:59:59.999Z");
      });

      it("America/New_York (EST, -5) - 2024-01-15", () => {
        const result = endOfLocalDay(2024, 1, 15, "America/New_York");
        expect(result.toISOString()).toBe("2024-01-16T04:59:59.999Z");
      });
    });

    describe("high positive offset zones (+12 and beyond)", () => {
      it("Pacific/Auckland (NZDT, +13) - 2024-01-15", () => {
        const result = endOfLocalDay(2024, 1, 15, "Pacific/Auckland");
        expect(result.toISOString()).toBe("2024-01-15T10:59:59.999Z");
      });

      it("Pacific/Auckland (NZST, +12) - 2024-06-15", () => {
        const result = endOfLocalDay(2024, 6, 15, "Pacific/Auckland");
        expect(result.toISOString()).toBe("2024-06-15T11:59:59.999Z");
      });

      it("Pacific/Tongatapu (+13) - 2024-01-15", () => {
        const result = endOfLocalDay(2024, 1, 15, "Pacific/Tongatapu");
        expect(result.toISOString()).toBe("2024-01-15T10:59:59.999Z");
      });

      it("Pacific/Kiritimati (+14) - 2024-01-15", () => {
        const result = endOfLocalDay(2024, 1, 15, "Pacific/Kiritimati");
        expect(result.toISOString()).toBe("2024-01-15T09:59:59.999Z");
      });
    });

    describe("DST transition days", () => {
      // Sydney: DST ends first Sunday of April (clocks go back 1h at 3am)
      // 2026-04-05 is first Sunday of April 2026
      it("Australia/Sydney - 2026-04-05 (DST ends, clocks back)", () => {
        const result = endOfLocalDay(2026, 4, 5, "Australia/Sydney");
        const luxonResult = luxonEndOfLocalDay(2026, 4, 5, "Australia/Sydney");
        expect(result.toISOString()).toBe(luxonResult.toISOString());
        // After DST ends, Sydney is +10, so EOD is 13:59:59.999Z
        expect(result.toISOString()).toBe("2026-04-05T13:59:59.999Z");
      });

      // Sydney: DST starts first Sunday of October (clocks go forward 1h at 2am)
      // 2026-10-04 is first Sunday of October 2026
      it("Australia/Sydney - 2026-10-04 (DST starts, clocks forward)", () => {
        const result = endOfLocalDay(2026, 10, 4, "Australia/Sydney");
        const luxonResult = luxonEndOfLocalDay(2026, 10, 4, "Australia/Sydney");
        expect(result.toISOString()).toBe(luxonResult.toISOString());
        // After DST starts, Sydney is +11, so EOD is 12:59:59.999Z
        expect(result.toISOString()).toBe("2026-10-04T12:59:59.999Z");
      });

      it("Australia/Sydney - 2026-10-03 (day before DST starts)", () => {
        const result = endOfLocalDay(2026, 10, 3, "Australia/Sydney");
        const luxonResult = luxonEndOfLocalDay(2026, 10, 3, "Australia/Sydney");
        expect(result.toISOString()).toBe(luxonResult.toISOString());
        // Still +10, so EOD is 13:59:59.999Z
        expect(result.toISOString()).toBe("2026-10-03T13:59:59.999Z");
      });

      it("Australia/Sydney - 2026-04-04 (day before DST ends)", () => {
        const result = endOfLocalDay(2026, 4, 4, "Australia/Sydney");
        const luxonResult = luxonEndOfLocalDay(2026, 4, 4, "Australia/Sydney");
        expect(result.toISOString()).toBe(luxonResult.toISOString());
        // Still +11, so EOD is 12:59:59.999Z
        expect(result.toISOString()).toBe("2026-04-04T12:59:59.999Z");
      });

      // London: DST starts last Sunday of March (clocks forward at 1am)
      // 2026-03-29 is last Sunday of March 2026
      it("Europe/London - 2026-03-29 (DST starts)", () => {
        const result = endOfLocalDay(2026, 3, 29, "Europe/London");
        const luxonResult = luxonEndOfLocalDay(2026, 3, 29, "Europe/London");
        expect(result.toISOString()).toBe(luxonResult.toISOString());
        // After DST starts, London is +1 (BST), so EOD is 22:59:59.999Z
        expect(result.toISOString()).toBe("2026-03-29T22:59:59.999Z");
      });

      // London: DST ends last Sunday of October (clocks back at 2am)
      // 2026-10-25 is last Sunday of October 2026
      it("Europe/London - 2026-10-25 (DST ends)", () => {
        const result = endOfLocalDay(2026, 10, 25, "Europe/London");
        const luxonResult = luxonEndOfLocalDay(2026, 10, 25, "Europe/London");
        expect(result.toISOString()).toBe(luxonResult.toISOString());
        // After DST ends, London is +0 (GMT), so EOD is 23:59:59.999Z
        expect(result.toISOString()).toBe("2026-10-25T23:59:59.999Z");
      });

      // New York: DST starts second Sunday of March (clocks forward at 2am)
      // 2026-03-08 is second Sunday of March 2026
      it("America/New_York - 2026-03-08 (DST starts)", () => {
        const result = endOfLocalDay(2026, 3, 8, "America/New_York");
        const luxonResult = luxonEndOfLocalDay(2026, 3, 8, "America/New_York");
        expect(result.toISOString()).toBe(luxonResult.toISOString());
        // After DST starts, NY is -4 (EDT), so EOD is 04:59:59.999Z next day
        expect(result.toISOString()).toBe("2026-03-09T03:59:59.999Z");
      });

      // New York: DST ends first Sunday of November (clocks back at 2am)
      // 2026-11-01 is first Sunday of November 2026
      it("America/New_York - 2026-11-01 (DST ends)", () => {
        const result = endOfLocalDay(2026, 11, 1, "America/New_York");
        const luxonResult = luxonEndOfLocalDay(2026, 11, 1, "America/New_York");
        expect(result.toISOString()).toBe(luxonResult.toISOString());
        // After DST ends, NY is -5 (EST), so EOD is 04:59:59.999Z next day
        expect(result.toISOString()).toBe("2026-11-02T04:59:59.999Z");
      });
    });

    describe("month and year boundaries", () => {
      it("end of January 2024 (leap year)", () => {
        const result = endOfLocalDay(2024, 1, 31, "UTC");
        expect(result.toISOString()).toBe("2024-01-31T23:59:59.999Z");
      });

      it("end of February 2024 (leap year)", () => {
        const result = endOfLocalDay(2024, 2, 29, "UTC");
        expect(result.toISOString()).toBe("2024-02-29T23:59:59.999Z");
      });

      it("end of February 2023 (non-leap year)", () => {
        const result = endOfLocalDay(2023, 2, 28, "UTC");
        expect(result.toISOString()).toBe("2023-02-28T23:59:59.999Z");
      });

      it("end of December 2024", () => {
        const result = endOfLocalDay(2024, 12, 31, "UTC");
        expect(result.toISOString()).toBe("2024-12-31T23:59:59.999Z");
      });

      it("end of year in IST", () => {
        const result = endOfLocalDay(2024, 12, 31, "Asia/Kolkata");
        expect(result.toISOString()).toBe("2024-12-31T18:29:59.999Z");
      });
    });
  });

  describe("addDaysAndGetEndOfDay", () => {
    describe("basic date arithmetic", () => {
      it("adds 30 days in IST", () => {
        const base = new Date("2024-01-15T12:00:00.000Z");
        const result = addDaysAndGetEndOfDay(base, 30, "Asia/Kolkata");
        expect(result.toISOString()).toBe("2024-02-14T18:29:59.999Z");
      });

      it("adds 0 days (same day end)", () => {
        const base = new Date("2024-01-15T12:00:00.000Z");
        const result = addDaysAndGetEndOfDay(base, 0, "Asia/Kolkata");
        expect(result.toISOString()).toBe("2024-01-15T18:29:59.999Z");
      });

      it("handles month boundary", () => {
        const base = new Date("2024-01-25T12:00:00.000Z");
        const result = addDaysAndGetEndOfDay(base, 10, "Asia/Kolkata");
        expect(result.toISOString()).toBe("2024-02-04T18:29:59.999Z");
      });

      it("handles year boundary", () => {
        const base = new Date("2024-12-25T12:00:00.000Z");
        const result = addDaysAndGetEndOfDay(base, 10, "Asia/Kolkata");
        expect(result.toISOString()).toBe("2025-01-04T18:29:59.999Z");
      });

      it("handles leap year Feb 29", () => {
        const base = new Date("2024-01-31T12:00:00.000Z");
        const result = addDaysAndGetEndOfDay(base, 29, "UTC");
        expect(result.toISOString()).toBe("2024-02-29T23:59:59.999Z");
      });

      it("handles non-leap year Feb -> Mar", () => {
        const base = new Date("2023-01-31T12:00:00.000Z");
        const result = addDaysAndGetEndOfDay(base, 29, "UTC");
        expect(result.toISOString()).toBe("2023-03-01T23:59:59.999Z");
      });
    });

    describe("high positive offset zones", () => {
      it("Auckland: order 2026-01-15T00:00Z (13:00 NZDT), net 30", () => {
        const base = new Date("2026-01-15T00:00:00.000Z");
        const result = addDaysAndGetEndOfDay(base, 30, "Pacific/Auckland");
        // Jan 15 NZDT + 30 days = Feb 14 NZDT, EOD = 10:59:59.999Z
        expect(result.toISOString()).toBe("2026-02-14T10:59:59.999Z");
      });

      it("Auckland NZST: order 2026-06-15T00:00Z, net 30", () => {
        const base = new Date("2026-06-15T00:00:00.000Z");
        const result = addDaysAndGetEndOfDay(base, 30, "Pacific/Auckland");
        // Jun 15 NZST + 30 = Jul 15 NZST, EOD = 11:59:59.999Z
        expect(result.toISOString()).toBe("2026-07-15T11:59:59.999Z");
      });

      it("Kiritimati (+14): order 2026-01-15T00:00Z, net 0", () => {
        const base = new Date("2026-01-15T00:00:00.000Z");
        const result = addDaysAndGetEndOfDay(base, 0, "Pacific/Kiritimati");
        // At 00:00Z it's already Jan 15 14:00 local
        expect(result.toISOString()).toBe("2026-01-15T09:59:59.999Z");
      });
    });

    describe("DST transitions during date arithmetic", () => {
      it("crosses DST start in Sydney", () => {
        // Order on Oct 1, +5 days crosses Oct 4 DST start
        const base = new Date("2026-10-01T12:00:00.000Z");
        const result = addDaysAndGetEndOfDay(base, 5, "Australia/Sydney");
        const luxonResult = luxonAddDaysEOD(base, 5, "Australia/Sydney");
        expect(result.toISOString()).toBe(luxonResult.toISOString());
      });

      it("crosses DST end in London", () => {
        // Order on Oct 20, +10 days crosses Oct 25 DST end
        const base = new Date("2026-10-20T12:00:00.000Z");
        const result = addDaysAndGetEndOfDay(base, 10, "Europe/London");
        const luxonResult = luxonAddDaysEOD(base, 10, "Europe/London");
        expect(result.toISOString()).toBe(luxonResult.toISOString());
      });

      it("crosses DST start in New York", () => {
        // Order on Mar 5, +5 days crosses Mar 8 DST start
        const base = new Date("2026-03-05T12:00:00.000Z");
        const result = addDaysAndGetEndOfDay(base, 5, "America/New_York");
        const luxonResult = luxonAddDaysEOD(base, 5, "America/New_York");
        expect(result.toISOString()).toBe(luxonResult.toISOString());
      });
    });
  });

  describe("sweep test: every day 2024-2026 across multiple timezones", () => {
    const timezones = [
      "UTC",
      "Asia/Kolkata",
      "Asia/Kathmandu",
      "America/New_York",
      "Europe/London",
      "America/St_Johns",
      "Australia/Sydney",
      "Pacific/Auckland",
      "Pacific/Tongatapu",
      "Pacific/Kiritimati",
      "America/Los_Angeles",
      "Asia/Tokyo",
    ];

    // Generate dates from 2024-01-01 to 2026-12-31
    const startDate = new Date("2024-01-01T00:00:00.000Z");
    const endDate = new Date("2026-12-31T00:00:00.000Z");
    const dates: Date[] = [];
    for (
      let d = new Date(startDate);
      d <= endDate;
      d = new Date(d.getTime() + 24 * 60 * 60 * 1000)
    ) {
      dates.push(new Date(d));
    }

    it.each(timezones)(
      "endOfLocalDay matches Luxon for all days in %s",
      (tz) => {
        const mismatches: string[] = [];

        for (const date of dates) {
          // Get the local date at this UTC instant
          const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            year: "numeric",
            month: "numeric",
            day: "numeric",
          });
          const parts = formatter.formatToParts(date);
          const year = parseInt(
            parts.find((p) => p.type === "year")?.value ?? "0",
            10
          );
          const month = parseInt(
            parts.find((p) => p.type === "month")?.value ?? "0",
            10
          );
          const day = parseInt(
            parts.find((p) => p.type === "day")?.value ?? "0",
            10
          );

          const ourResult = endOfLocalDay(year, month, day, tz);
          const luxonResult = luxonEndOfLocalDay(year, month, day, tz);

          if (ourResult.getTime() !== luxonResult.getTime()) {
            mismatches.push(
              `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}: ` +
                `got ${ourResult.toISOString()}, expected ${luxonResult.toISOString()}`
            );
          }
        }

        expect(
          mismatches,
          `Mismatches in ${tz}:\n${mismatches.slice(0, 10).join("\n")}${mismatches.length > 10 ? `\n... and ${mismatches.length - 10} more` : ""}`
        ).toHaveLength(0);
      }
    );
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

    describe("invalid inputs", () => {
      it("returns none for invalid orderCreatedAt", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          orderCreatedAt: new Date("invalid"),
          accountDefaultTermsDays: 30,
          accountDefaultTermsSource: "explicit",
        };

        const result = inferDueDate(input);
        expect(result.dueSource).toBe("none");
        expect(result.reason).toContain("Invalid order created date");
      });

      it("returns none for invalid merchantOverrideDueAt", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          merchantOverrideDueAt: new Date("invalid"),
        };

        const result = inferDueDate(input);
        expect(result.dueSource).toBe("none");
        expect(result.reason).toContain("Invalid merchant override date");
      });

      it("falls back to default timezone for invalid shopTimezone", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          shopTimezone: "Asia/Calcuta", // typo
          accountDefaultTermsDays: 30,
          accountDefaultTermsSource: "explicit",
        };

        const result = inferDueDate(input);
        expect(result.dueSource).toBe("inferred");
        expect(result.reason).toContain("invalid timezone");
        expect(result.reason).toContain("Asia/Calcuta");
        expect(result.reason).toContain("Asia/Kolkata");
        // Should use correct IST calculation
        expect(result.dueAt?.toISOString()).toBe("2024-02-14T18:29:59.999Z");
      });

      it("falls back to default timezone for empty string timezone", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          shopTimezone: "",
          accountDefaultTermsDays: 30,
          accountDefaultTermsSource: "explicit",
        };

        const result = inferDueDate(input);
        expect(result.reason).toContain("invalid timezone");
      });
    });

    describe("PaymentSchedule precedence (highest priority)", () => {
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
        expect(result.dueAt?.toISOString()).toBe("2024-02-15T18:29:59.999Z");
        expect(result.reason).toContain("Earliest of 3 pending");
      });

      it("uses latest dueAt when all schedules completed (not array-last)", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          paymentTerms: {
            type: "NET",
            dueInDays: 30,
            schedules: [
              {
                dueAt: new Date("2024-03-15T18:29:59.999Z"),
                completedAt: new Date("2024-03-10T12:00:00.000Z"),
              },
              {
                dueAt: new Date("2024-02-15T18:29:59.999Z"),
                completedAt: new Date("2024-02-10T12:00:00.000Z"),
              },
            ],
          },
        };

        const result = inferDueDate(input);
        // Should return Mar 15 (latest), not Feb 15 (array-last)
        expect(result.dueAt?.toISOString()).toBe("2024-03-15T18:29:59.999Z");
        expect(result.reason).toContain("Latest payment schedule");
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
                dueAt: new Date("2024-04-15T18:29:59.999Z"),
                completedAt: null,
              },
              {
                dueAt: new Date("2024-03-15T18:29:59.999Z"),
                completedAt: null,
              },
            ],
          },
        };

        const result = inferDueDate(input);
        expect(result.dueAt?.toISOString()).toBe("2024-03-15T18:29:59.999Z");
        expect(result.reason).toContain("Earliest of 2 pending");
      });
    });

    describe("NET/FIXED with dueInDays but no schedule dueAt", () => {
      it("computes from order date plus dueInDays", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          paymentTerms: {
            type: "NET",
            dueInDays: 30,
            schedules: [{ dueAt: null, completedAt: null }],
          },
        };

        const result = inferDueDate(input);
        expect(result.dueSource).toBe("schedule");
        expect(result.basis).toBe("paymentTermsDueInDays");
        expect(result.dueAt?.toISOString()).toBe("2024-02-14T18:29:59.999Z");
        expect(result.reason).toContain("NET terms: net 30 days from order date");
        expect(result.reason).toContain("computed from dueInDays");
      });

      it("computes for FIXED type as well", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          paymentTerms: {
            type: "FIXED",
            dueInDays: 15,
            schedules: [],
          },
        };

        const result = inferDueDate(input);
        expect(result.dueSource).toBe("schedule");
        expect(result.basis).toBe("paymentTermsDueInDays");
        expect(result.reason).toContain("FIXED terms: net 15 days");
      });
    });

    describe("FULFILLMENT terms", () => {
      it("falls through to override when no fulfillment date", () => {
        const overrideDate = new Date("2024-03-01T18:29:59.999Z");
        const input: InferDueDateInput = {
          ...baseInput,
          paymentTerms: {
            type: "FULFILLMENT",
            dueInDays: 0,
            schedules: [{ dueAt: null, completedAt: null }],
          },
          fulfilledAt: null,
          merchantOverrideDueAt: overrideDate,
        };

        const result = inferDueDate(input);
        expect(result.dueSource).toBe("override");
        expect(result.dueAt?.toISOString()).toBe(overrideDate.toISOString());
        expect(result.reason).toContain("Merchant override");
        expect(result.reason).toContain("FULFILLMENT pending");
      });

      it("falls through to inferred sources when no fulfillment date and no override", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          paymentTerms: {
            type: "FULFILLMENT",
            dueInDays: 0,
            schedules: [{ dueAt: null, completedAt: null }],
          },
          fulfilledAt: null,
          accountDefaultTermsDays: 45,
          accountDefaultTermsSource: "explicit",
        };

        const result = inferDueDate(input);
        expect(result.dueSource).toBe("inferred");
        expect(result.basis).toBe("accountDefault");
        expect(result.reason).toContain("Account default: net 45 days");
        expect(result.reason).toContain("FULFILLMENT pending");
      });

      it("calculates due date from fulfillment date when fulfilled", () => {
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
        expect(result.dueAt?.toISOString()).toBe("2024-02-16T18:29:59.999Z");
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
      it("uses Shopify-provided dueAt when present", () => {
        const shopifyDueAt = new Date("2024-01-20T10:00:00.000Z");
        const input: InferDueDateInput = {
          ...baseInput,
          orderCreatedAt: new Date("2024-01-15T12:00:00.000Z"),
          paymentTerms: {
            type: "RECEIPT",
            dueInDays: 0,
            schedules: [{ dueAt: shopifyDueAt, completedAt: null }],
          },
        };

        const result = inferDueDate(input);
        expect(result.dueSource).toBe("schedule");
        expect(result.dueAt?.toISOString()).toBe(shopifyDueAt.toISOString());
        expect(result.reason).toContain("Shopify schedule");
      });

      it("falls back to order created date when no schedule dueAt", () => {
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
        expect(result.dueAt?.toISOString()).toBe("2024-01-15T18:29:59.999Z");
        expect(result.reason).toContain("due on receipt (issue date)");
      });

      it("works with empty schedules array", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          paymentTerms: {
            type: "RECEIPT",
            dueInDays: 0,
            schedules: [],
          },
        };

        const result = inferDueDate(input);
        expect(result.dueSource).toBe("schedule");
        expect(result.dueAt).not.toBeNull();
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

      it("is ignored when a schedule with dueAt exists", () => {
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
        expect(result.basis).toBe("accountDefault");
      });

      it("rejects negative account default", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          accountDefaultTermsDays: -5,
          accountDefaultTermsSource: "explicit",
        };

        const result = inferDueDate(input);
        expect(result.dueSource).toBe("none");
      });

      it("rejects fractional account default", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          accountDefaultTermsDays: 30.5,
          accountDefaultTermsSource: "explicit",
        };

        const result = inferDueDate(input);
        expect(result.dueSource).toBe("none");
      });
    });

    describe("tag-copied account default", () => {
      it("skips tag-copied account default in favour of matching tag rule", () => {
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
          customerTags: ["vip"],
        };

        const result = inferDueDate(input);
        expect(result.dueSource).toBe("inferred");
        expect(result.basis).toBe("tagRule");
        expect(result.reason).toContain("Tag-derived account default");
        expect(result.reason).toContain("no current tag rule matched");
      });

      it("tag-copied 60 beats shop default of 15", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          accountDefaultTermsDays: 60,
          accountDefaultTermsSource: "tag",
          tagRules: [{ tag: "net45", defaultTermsDays: 45 }],
          customerTags: ["vip"], // Does not match
          shopDefaultTermsDays: 15,
        };

        const result = inferDueDate(input);
        expect(result.dueSource).toBe("inferred");
        expect(result.basis).toBe("tagRule");
        expect(result.reason).toContain("Tag-derived account default: net 60 days");
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
        expect(result.basis).toBe("tagRule");
      });

      it("matches tag with whitespace trimmed", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          tagRules: [{ tag: "  net30  ", defaultTermsDays: 30 }],
          customerTags: ["net30"],
        };

        const result = inferDueDate(input);
        expect(result.basis).toBe("tagRule");
      });

      it("picks largest terms days when multiple rules match", () => {
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
        expect(result.reason).toContain("net 60 days");
        expect(result.reason).toContain("3 rules matched");
        expect(result.reason).toContain("using largest");
      });

      it("rejects negative tag rule values", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          tagRules: [{ tag: "bad", defaultTermsDays: -10 }],
          customerTags: ["bad"],
        };

        const result = inferDueDate(input);
        expect(result.dueSource).toBe("none");
      });

      it("rejects fractional tag rule values", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          tagRules: [{ tag: "bad", defaultTermsDays: 1.5 }],
          customerTags: ["bad"],
        };

        const result = inferDueDate(input);
        expect(result.dueSource).toBe("none");
      });

      it("notes when invalid rules are ignored", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          tagRules: [
            { tag: "good", defaultTermsDays: 30 },
            { tag: "bad", defaultTermsDays: -10 },
          ],
          customerTags: ["good", "bad"],
        };

        const result = inferDueDate(input);
        expect(result.basis).toBe("tagRule");
        expect(result.reason).toContain("1 invalid rule(s) ignored");
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
      });

      it("is used after account default and tag rules fail", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          accountDefaultTermsDays: null,
          tagRules: [{ tag: "net30", defaultTermsDays: 30 }],
          customerTags: ["vip"],
          shopDefaultTermsDays: 45,
        };

        const result = inferDueDate(input);
        expect(result.basis).toBe("shopDefault");
      });

      it("rejects negative shop default", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          shopDefaultTermsDays: -5,
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
        expect(result.basis).toBe("tagRule");
        expect(result.dueAt?.toISOString()).toBe("2024-02-14T18:29:59.999Z");
      });

      it("respects shopDefault first in custom order", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          accountDefaultTermsDays: 60,
          accountDefaultTermsSource: "explicit",
          shopDefaultTermsDays: 15,
          inferenceOrder: ["shopDefault", "tagRule", "accountDefault"],
        };

        const result = inferDueDate(input);
        expect(result.basis).toBe("shopDefault");
      });
    });

    describe("timezone-specific calculations", () => {
      it("Auckland order at 00:00Z (13:00 NZDT), net 30", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          orderCreatedAt: new Date("2026-01-15T00:00:00.000Z"),
          accountDefaultTermsDays: 30,
          accountDefaultTermsSource: "explicit",
          shopTimezone: "Pacific/Auckland",
        };

        const result = inferDueDate(input);
        // Jan 15 NZDT + 30 days = Feb 14 NZDT, EOD = 10:59:59.999Z
        expect(result.dueAt?.toISOString()).toBe("2026-02-14T10:59:59.999Z");
      });

      it("Sydney DST start day 2026-10-04", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          orderCreatedAt: new Date("2026-10-04T00:00:00.000Z"),
          accountDefaultTermsDays: 0,
          accountDefaultTermsSource: "explicit",
          shopTimezone: "Australia/Sydney",
        };

        const result = inferDueDate(input);
        expect(result.dueAt?.toISOString()).toBe("2026-10-04T12:59:59.999Z");
      });

      it("Sydney day before DST starts 2026-10-03", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          orderCreatedAt: new Date("2026-10-03T00:00:00.000Z"),
          accountDefaultTermsDays: 0,
          accountDefaultTermsSource: "explicit",
          shopTimezone: "Australia/Sydney",
        };

        const result = inferDueDate(input);
        expect(result.dueAt?.toISOString()).toBe("2026-10-03T13:59:59.999Z");
      });

      it("London DST start day 2026-03-29", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          orderCreatedAt: new Date("2026-03-29T12:00:00.000Z"),
          accountDefaultTermsDays: 0,
          accountDefaultTermsSource: "explicit",
          shopTimezone: "Europe/London",
        };

        const result = inferDueDate(input);
        expect(result.dueAt?.toISOString()).toBe("2026-03-29T22:59:59.999Z");
      });

      it("London DST end day 2026-10-25", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          orderCreatedAt: new Date("2026-10-25T12:00:00.000Z"),
          accountDefaultTermsDays: 0,
          accountDefaultTermsSource: "explicit",
          shopTimezone: "Europe/London",
        };

        const result = inferDueDate(input);
        expect(result.dueAt?.toISOString()).toBe("2026-10-25T23:59:59.999Z");
      });

      it("New York DST start day 2026-03-08", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          orderCreatedAt: new Date("2026-03-08T12:00:00.000Z"),
          accountDefaultTermsDays: 0,
          accountDefaultTermsSource: "explicit",
          shopTimezone: "America/New_York",
        };

        const result = inferDueDate(input);
        expect(result.dueAt?.toISOString()).toBe("2026-03-09T03:59:59.999Z");
      });

      it("New York DST end day 2026-11-01", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          orderCreatedAt: new Date("2026-11-01T12:00:00.000Z"),
          accountDefaultTermsDays: 0,
          accountDefaultTermsSource: "explicit",
          shopTimezone: "America/New_York",
        };

        const result = inferDueDate(input);
        expect(result.dueAt?.toISOString()).toBe("2026-11-02T04:59:59.999Z");
      });

      it("Kathmandu (+5:45)", () => {
        const input: InferDueDateInput = {
          ...baseInput,
          orderCreatedAt: new Date("2024-01-15T12:00:00.000Z"),
          accountDefaultTermsDays: 30,
          accountDefaultTermsSource: "explicit",
          shopTimezone: "Asia/Kathmandu",
        };

        const result = inferDueDate(input);
        expect(result.dueAt?.toISOString()).toBe("2024-02-14T18:14:59.999Z");
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
        };

        const result = inferDueDate(input);
        expect(result.dueAt?.toISOString()).toBe("2024-02-14T18:29:59.999Z");
      });
    });

    describe("no source available", () => {
      it("returns none when nothing is configured", () => {
        const result = inferDueDate(baseInput);
        expect(result.dueAt).toBeNull();
        expect(result.dueSource).toBe("none");
        expect(result.basis).toBeNull();
      });
    });
  });
});
