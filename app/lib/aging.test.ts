import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import {
  calculateDaysPastDue,
  getBucketForDaysPastDue,
  calculateAging,
  serializeAgingTotals,
  deserializeAgingTotals,
  formatPaiseAmount,
  AGING_BUCKET_KEYS,
  BUCKET_BOUNDARIES,
  type OpenInvoice,
  type AgingBucketKey,
} from "./aging";

/**
 * Helper to create an "as of" date in Asia/Kolkata timezone.
 */
function asOfDate(isoDate: string): Date {
  return DateTime.fromISO(isoDate, { zone: "Asia/Kolkata" })
    .startOf("day")
    .toJSDate();
}

/**
 * Helper to create a due date at end of day in Asia/Kolkata timezone.
 */
function dueDate(isoDate: string): Date {
  return DateTime.fromISO(isoDate, { zone: "Asia/Kolkata" })
    .endOf("day")
    .toJSDate();
}

/**
 * Helper to create a test invoice.
 */
function invoice(
  id: string,
  outstandingPaise: bigint,
  dueAt: Date | null,
  currency = "INR",
  buyerAccountId = "buyer-1"
): OpenInvoice {
  return { id, outstandingPaise, dueAt, currency, buyerAccountId };
}

describe("aging", () => {
  describe("calculateDaysPastDue", () => {
    describe("boundary conditions", () => {
      it("returns 0 for null due date (not yet due)", () => {
        const asOf = asOfDate("2026-10-23");
        expect(calculateDaysPastDue(null, asOf)).toBe(0);
      });

      it("returns 0 when due today (due date = as of date)", () => {
        const asOf = asOfDate("2026-10-23");
        const due = dueDate("2026-10-23");
        expect(calculateDaysPastDue(due, asOf)).toBe(0);
      });

      it("returns 1 when 1 day past due", () => {
        const asOf = asOfDate("2026-10-24");
        const due = dueDate("2026-10-23");
        expect(calculateDaysPastDue(due, asOf)).toBe(1);
      });

      it("returns -1 when due tomorrow (not yet due)", () => {
        const asOf = asOfDate("2026-10-22");
        const due = dueDate("2026-10-23");
        expect(calculateDaysPastDue(due, asOf)).toBe(-1);
      });

      it("returns 30 for 30 days past due", () => {
        const asOf = asOfDate("2026-11-22");
        const due = dueDate("2026-10-23");
        expect(calculateDaysPastDue(due, asOf)).toBe(30);
      });

      it("returns 31 for 31 days past due", () => {
        const asOf = asOfDate("2026-11-23");
        const due = dueDate("2026-10-23");
        expect(calculateDaysPastDue(due, asOf)).toBe(31);
      });

      it("returns 60 for 60 days past due", () => {
        const asOf = asOfDate("2026-12-22");
        const due = dueDate("2026-10-23");
        expect(calculateDaysPastDue(due, asOf)).toBe(60);
      });

      it("returns 61 for 61 days past due", () => {
        const asOf = asOfDate("2026-12-23");
        const due = dueDate("2026-10-23");
        expect(calculateDaysPastDue(due, asOf)).toBe(61);
      });

      it("returns 90 for 90 days past due", () => {
        const asOf = asOfDate("2027-01-21");
        const due = dueDate("2026-10-23");
        expect(calculateDaysPastDue(due, asOf)).toBe(90);
      });

      it("returns 91 for 91 days past due", () => {
        const asOf = asOfDate("2027-01-22");
        const due = dueDate("2026-10-23");
        expect(calculateDaysPastDue(due, asOf)).toBe(91);
      });
    });

    describe("timezone handling", () => {
      it("uses Asia/Kolkata timezone for calculations", () => {
        // Create dates that would differ in different timezones
        // At UTC midnight Oct 23, it's 5:30 AM Oct 23 in IST
        const asOfUtcMidnight = new Date("2026-10-23T00:00:00.000Z");
        const dueUtcMidnight = new Date("2026-10-22T00:00:00.000Z");

        // In IST, both are the same day ahead, so difference should be 1 day
        expect(calculateDaysPastDue(dueUtcMidnight, asOfUtcMidnight)).toBe(1);
      });
    });
  });

  describe("getBucketForDaysPastDue", () => {
    it("returns 'current' for daysPastDue <= 0", () => {
      expect(getBucketForDaysPastDue(-10)).toBe("current");
      expect(getBucketForDaysPastDue(-1)).toBe("current");
      expect(getBucketForDaysPastDue(0)).toBe("current");
    });

    it("returns '1-30' for 1 <= daysPastDue <= 30", () => {
      expect(getBucketForDaysPastDue(1)).toBe("1-30");
      expect(getBucketForDaysPastDue(15)).toBe("1-30");
      expect(getBucketForDaysPastDue(30)).toBe("1-30");
    });

    it("returns '31-60' for 31 <= daysPastDue <= 60", () => {
      expect(getBucketForDaysPastDue(31)).toBe("31-60");
      expect(getBucketForDaysPastDue(45)).toBe("31-60");
      expect(getBucketForDaysPastDue(60)).toBe("31-60");
    });

    it("returns '61-90' for 61 <= daysPastDue <= 90", () => {
      expect(getBucketForDaysPastDue(61)).toBe("61-90");
      expect(getBucketForDaysPastDue(75)).toBe("61-90");
      expect(getBucketForDaysPastDue(90)).toBe("61-90");
    });

    it("returns '90+' for daysPastDue >= 91", () => {
      expect(getBucketForDaysPastDue(91)).toBe("90+");
      expect(getBucketForDaysPastDue(100)).toBe("90+");
      expect(getBucketForDaysPastDue(365)).toBe("90+");
    });

    describe("exact boundary tests", () => {
      it("30 -> 1-30, 31 -> 31-60 boundary", () => {
        expect(getBucketForDaysPastDue(30)).toBe("1-30");
        expect(getBucketForDaysPastDue(31)).toBe("31-60");
      });

      it("60 -> 31-60, 61 -> 61-90 boundary", () => {
        expect(getBucketForDaysPastDue(60)).toBe("31-60");
        expect(getBucketForDaysPastDue(61)).toBe("61-90");
      });

      it("90 -> 61-90, 91 -> 90+ boundary", () => {
        expect(getBucketForDaysPastDue(90)).toBe("61-90");
        expect(getBucketForDaysPastDue(91)).toBe("90+");
      });
    });
  });

  describe("calculateAging", () => {
    describe("empty and edge cases", () => {
      it("returns empty totals for empty invoice list", () => {
        const result = calculateAging([], asOfDate("2026-10-23"));

        expect(result.shopTotals.totalByCurrency.size).toBe(0);
        expect(result.byBuyer.size).toBe(0);
        expect(result.shopTotals.oldestOverdueDays).toBeNull();
      });

      it("skips invoices with zero or negative outstanding", () => {
        const invoices: OpenInvoice[] = [
          invoice("inv-1", 0n, dueDate("2026-10-20")),
          invoice("inv-2", -100n, dueDate("2026-10-20")),
        ];

        const result = calculateAging(invoices, asOfDate("2026-10-23"));
        expect(result.shopTotals.totalByCurrency.size).toBe(0);
      });
    });

    describe("single invoice in each bucket", () => {
      it("places current invoice in current bucket", () => {
        const invoices: OpenInvoice[] = [
          invoice("inv-1", 100000n, dueDate("2026-10-25")), // Due in future
        ];

        const result = calculateAging(invoices, asOfDate("2026-10-23"));

        expect(result.shopTotals.buckets.current.byCurrency.get("INR")).toBe(
          100000n
        );
        expect(result.shopTotals.buckets["1-30"].byCurrency.size).toBe(0);
        expect(result.shopTotals.oldestOverdueDays).toBeNull();
      });

      it("places 15-day overdue invoice in 1-30 bucket", () => {
        const invoices: OpenInvoice[] = [
          invoice("inv-1", 100000n, dueDate("2026-10-08")), // 15 days ago
        ];

        const result = calculateAging(invoices, asOfDate("2026-10-23"));

        expect(result.shopTotals.buckets["1-30"].byCurrency.get("INR")).toBe(
          100000n
        );
        expect(result.shopTotals.overdueByCurrency.get("INR")).toBe(100000n);
        expect(result.shopTotals.oldestOverdueDays).toBe(15);
      });

      it("places 45-day overdue invoice in 31-60 bucket", () => {
        const invoices: OpenInvoice[] = [
          invoice("inv-1", 100000n, dueDate("2026-09-08")), // 45 days ago
        ];

        const result = calculateAging(invoices, asOfDate("2026-10-23"));

        expect(result.shopTotals.buckets["31-60"].byCurrency.get("INR")).toBe(
          100000n
        );
        expect(result.shopTotals.oldestOverdueDays).toBe(45);
      });

      it("places 75-day overdue invoice in 61-90 bucket", () => {
        const invoices: OpenInvoice[] = [
          invoice("inv-1", 100000n, dueDate("2026-08-09")), // 75 days ago
        ];

        const result = calculateAging(invoices, asOfDate("2026-10-23"));

        expect(result.shopTotals.buckets["61-90"].byCurrency.get("INR")).toBe(
          100000n
        );
        expect(result.shopTotals.oldestOverdueDays).toBe(75);
      });

      it("places 100-day overdue invoice in 90+ bucket", () => {
        const invoices: OpenInvoice[] = [
          invoice("inv-1", 100000n, dueDate("2026-07-15")), // 100 days ago
        ];

        const result = calculateAging(invoices, asOfDate("2026-10-23"));

        expect(result.shopTotals.buckets["90+"].byCurrency.get("INR")).toBe(
          100000n
        );
        expect(result.shopTotals.oldestOverdueDays).toBe(100);
      });
    });

    describe("multiple invoices and buyers", () => {
      it("aggregates totals across multiple invoices in same bucket", () => {
        const invoices: OpenInvoice[] = [
          invoice("inv-1", 100000n, dueDate("2026-10-08"), "INR", "buyer-1"),
          invoice("inv-2", 200000n, dueDate("2026-10-10"), "INR", "buyer-1"),
          invoice("inv-3", 300000n, dueDate("2026-10-12"), "INR", "buyer-2"),
        ];

        const result = calculateAging(invoices, asOfDate("2026-10-23"));

        // All are 1-30 days overdue
        expect(result.shopTotals.buckets["1-30"].byCurrency.get("INR")).toBe(
          600000n
        );
        expect(result.shopTotals.totalByCurrency.get("INR")).toBe(600000n);

        // Per buyer
        expect(
          result.byBuyer.get("buyer-1")?.buckets["1-30"].byCurrency.get("INR")
        ).toBe(300000n);
        expect(
          result.byBuyer.get("buyer-2")?.buckets["1-30"].byCurrency.get("INR")
        ).toBe(300000n);
      });

      it("tracks oldest overdue across all invoices", () => {
        const invoices: OpenInvoice[] = [
          invoice("inv-1", 100000n, dueDate("2026-10-08"), "INR", "buyer-1"), // 15 days
          invoice("inv-2", 100000n, dueDate("2026-08-23"), "INR", "buyer-2"), // 61 days
          invoice("inv-3", 100000n, dueDate("2026-07-15"), "INR", "buyer-1"), // 100 days
        ];

        const result = calculateAging(invoices, asOfDate("2026-10-23"));

        expect(result.shopTotals.oldestOverdueDays).toBe(100);
        expect(result.byBuyer.get("buyer-1")?.oldestOverdueDays).toBe(100);
        expect(result.byBuyer.get("buyer-2")?.oldestOverdueDays).toBe(61);
      });
    });

    describe("multi-currency handling", () => {
      it("never sums across currencies", () => {
        const invoices: OpenInvoice[] = [
          invoice("inv-1", 100000n, dueDate("2026-10-08"), "INR", "buyer-1"),
          invoice("inv-2", 50000n, dueDate("2026-10-08"), "USD", "buyer-1"),
          invoice("inv-3", 25000n, dueDate("2026-10-08"), "EUR", "buyer-2"),
        ];

        const result = calculateAging(invoices, asOfDate("2026-10-23"));

        // Shop totals - each currency separate
        expect(result.shopTotals.totalByCurrency.get("INR")).toBe(100000n);
        expect(result.shopTotals.totalByCurrency.get("USD")).toBe(50000n);
        expect(result.shopTotals.totalByCurrency.get("EUR")).toBe(25000n);

        // Bucket totals - each currency separate
        expect(result.shopTotals.buckets["1-30"].byCurrency.get("INR")).toBe(
          100000n
        );
        expect(result.shopTotals.buckets["1-30"].byCurrency.get("USD")).toBe(
          50000n
        );
        expect(result.shopTotals.buckets["1-30"].byCurrency.get("EUR")).toBe(
          25000n
        );
      });

      it("tracks overdue per currency", () => {
        const invoices: OpenInvoice[] = [
          invoice("inv-1", 100000n, dueDate("2026-10-08"), "INR", "buyer-1"), // Overdue
          invoice("inv-2", 50000n, dueDate("2026-10-30"), "USD", "buyer-1"), // Current
        ];

        const result = calculateAging(invoices, asOfDate("2026-10-23"));

        expect(result.shopTotals.overdueByCurrency.get("INR")).toBe(100000n);
        expect(result.shopTotals.overdueByCurrency.has("USD")).toBe(false);
      });

      it("handles same buyer with multiple currencies", () => {
        const invoices: OpenInvoice[] = [
          invoice("inv-1", 100000n, dueDate("2026-10-08"), "INR", "buyer-1"),
          invoice("inv-2", 50000n, dueDate("2026-10-08"), "USD", "buyer-1"),
        ];

        const result = calculateAging(invoices, asOfDate("2026-10-23"));
        const buyer1 = result.byBuyer.get("buyer-1");

        expect(buyer1?.totalByCurrency.get("INR")).toBe(100000n);
        expect(buyer1?.totalByCurrency.get("USD")).toBe(50000n);
      });
    });

    describe("null due date handling", () => {
      it("treats null due date as current (not yet due)", () => {
        const invoices: OpenInvoice[] = [
          invoice("inv-1", 100000n, null, "INR", "buyer-1"),
        ];

        const result = calculateAging(invoices, asOfDate("2026-10-23"));

        expect(result.shopTotals.buckets.current.byCurrency.get("INR")).toBe(
          100000n
        );
        expect(result.shopTotals.overdueByCurrency.size).toBe(0);
        expect(result.shopTotals.oldestOverdueDays).toBeNull();
      });
    });
  });

  describe("serialization", () => {
    it("round-trips through serialize/deserialize", () => {
      const invoices: OpenInvoice[] = [
        invoice("inv-1", 100000n, dueDate("2026-10-25"), "INR", "buyer-1"),
        invoice("inv-2", 200000n, dueDate("2026-10-08"), "INR", "buyer-1"),
        invoice("inv-3", 50000n, dueDate("2026-10-08"), "USD", "buyer-2"),
      ];

      const result = calculateAging(invoices, asOfDate("2026-10-23"));
      const serialized = serializeAgingTotals(result.shopTotals);
      const deserialized = deserializeAgingTotals(serialized);

      expect(deserialized.totalByCurrency.get("INR")).toBe(
        result.shopTotals.totalByCurrency.get("INR")
      );
      expect(deserialized.totalByCurrency.get("USD")).toBe(
        result.shopTotals.totalByCurrency.get("USD")
      );
      expect(deserialized.oldestOverdueDays).toBe(
        result.shopTotals.oldestOverdueDays
      );
    });

    it("serialized form is JSON-safe", () => {
      const invoices: OpenInvoice[] = [
        invoice("inv-1", 999999999999999n, dueDate("2026-10-08"), "INR"),
      ];

      const result = calculateAging(invoices, asOfDate("2026-10-23"));
      const serialized = serializeAgingTotals(result.shopTotals);

      // Should not throw
      const json = JSON.stringify(serialized);
      const parsed = JSON.parse(json);

      expect(parsed.totalByCurrency.INR).toBe("999999999999999");
    });
  });

  describe("formatPaiseAmount", () => {
    it("formats INR with Indian numbering system", () => {
      expect(formatPaiseAmount(10000000n, "INR")).toBe("₹1,00,000.00");
      expect(formatPaiseAmount(100n, "INR")).toBe("₹1.00");
      expect(formatPaiseAmount(12345678n, "INR")).toBe("₹1,23,456.78");
    });

    it("formats USD with US numbering system", () => {
      expect(formatPaiseAmount(10000000n, "USD")).toBe("$100,000.00");
      expect(formatPaiseAmount(100n, "USD")).toBe("$1.00");
    });

    it("handles zero", () => {
      expect(formatPaiseAmount(0n, "INR")).toBe("₹0.00");
    });
  });

  describe("BUCKET_BOUNDARIES constant", () => {
    it("has correct boundary values for SQL queries", () => {
      expect(BUCKET_BOUNDARIES.current).toEqual({ min: null, max: 0 });
      expect(BUCKET_BOUNDARIES["1-30"]).toEqual({ min: 1, max: 30 });
      expect(BUCKET_BOUNDARIES["31-60"]).toEqual({ min: 31, max: 60 });
      expect(BUCKET_BOUNDARIES["61-90"]).toEqual({ min: 61, max: 90 });
      expect(BUCKET_BOUNDARIES["90+"]).toEqual({ min: 91, max: null });
    });
  });

  describe("AGING_BUCKET_KEYS constant", () => {
    it("has all bucket keys in order", () => {
      expect(AGING_BUCKET_KEYS).toEqual([
        "current",
        "1-30",
        "31-60",
        "61-90",
        "90+",
      ]);
    });
  });
});

/**
 * SQL-vs-TS parity test fixtures.
 * These are used by the SQL parity test to ensure the SQL and TS
 * bucketing algorithms produce the same results.
 */
export interface ParityTestFixture {
  name: string;
  asOfDate: string; // ISO date string
  invoices: Array<{
    id: string;
    outstandingPaise: string; // String for bigint
    dueAt: string | null; // ISO date string or null
    currency: string;
    buyerAccountId: string;
  }>;
  expected: {
    shopTotals: {
      totalByCurrency: Record<string, string>;
      buckets: Record<AgingBucketKey, Record<string, string>>;
      overdueByCurrency: Record<string, string>;
    };
  };
}

export const PARITY_TEST_FIXTURES: ParityTestFixture[] = [
  {
    name: "empty invoices",
    asOfDate: "2026-10-23",
    invoices: [],
    expected: {
      shopTotals: {
        totalByCurrency: {},
        buckets: {
          current: {},
          "1-30": {},
          "31-60": {},
          "61-90": {},
          "90+": {},
        },
        overdueByCurrency: {},
      },
    },
  },
  {
    name: "single current invoice",
    asOfDate: "2026-10-23",
    invoices: [
      {
        id: "inv-1",
        outstandingPaise: "100000",
        dueAt: "2026-10-25",
        currency: "INR",
        buyerAccountId: "buyer-1",
      },
    ],
    expected: {
      shopTotals: {
        totalByCurrency: { INR: "100000" },
        buckets: {
          current: { INR: "100000" },
          "1-30": {},
          "31-60": {},
          "61-90": {},
          "90+": {},
        },
        overdueByCurrency: {},
      },
    },
  },
  {
    name: "invoice exactly on due date (current)",
    asOfDate: "2026-10-23",
    invoices: [
      {
        id: "inv-1",
        outstandingPaise: "100000",
        dueAt: "2026-10-23",
        currency: "INR",
        buyerAccountId: "buyer-1",
      },
    ],
    expected: {
      shopTotals: {
        totalByCurrency: { INR: "100000" },
        buckets: {
          current: { INR: "100000" },
          "1-30": {},
          "31-60": {},
          "61-90": {},
          "90+": {},
        },
        overdueByCurrency: {},
      },
    },
  },
  {
    name: "invoice 1 day past due (1-30 bucket)",
    asOfDate: "2026-10-23",
    invoices: [
      {
        id: "inv-1",
        outstandingPaise: "100000",
        dueAt: "2026-10-22",
        currency: "INR",
        buyerAccountId: "buyer-1",
      },
    ],
    expected: {
      shopTotals: {
        totalByCurrency: { INR: "100000" },
        buckets: {
          current: {},
          "1-30": { INR: "100000" },
          "31-60": {},
          "61-90": {},
          "90+": {},
        },
        overdueByCurrency: { INR: "100000" },
      },
    },
  },
  {
    name: "boundary test: 30 vs 31 days",
    asOfDate: "2026-10-23",
    invoices: [
      {
        id: "inv-30",
        outstandingPaise: "100000",
        dueAt: "2026-09-23", // exactly 30 days
        currency: "INR",
        buyerAccountId: "buyer-1",
      },
      {
        id: "inv-31",
        outstandingPaise: "200000",
        dueAt: "2026-09-22", // exactly 31 days
        currency: "INR",
        buyerAccountId: "buyer-1",
      },
    ],
    expected: {
      shopTotals: {
        totalByCurrency: { INR: "300000" },
        buckets: {
          current: {},
          "1-30": { INR: "100000" },
          "31-60": { INR: "200000" },
          "61-90": {},
          "90+": {},
        },
        overdueByCurrency: { INR: "300000" },
      },
    },
  },
  {
    name: "boundary test: 60 vs 61 days",
    asOfDate: "2026-10-23",
    invoices: [
      {
        id: "inv-60",
        outstandingPaise: "100000",
        dueAt: "2026-08-24", // exactly 60 days
        currency: "INR",
        buyerAccountId: "buyer-1",
      },
      {
        id: "inv-61",
        outstandingPaise: "200000",
        dueAt: "2026-08-23", // exactly 61 days
        currency: "INR",
        buyerAccountId: "buyer-1",
      },
    ],
    expected: {
      shopTotals: {
        totalByCurrency: { INR: "300000" },
        buckets: {
          current: {},
          "1-30": {},
          "31-60": { INR: "100000" },
          "61-90": { INR: "200000" },
          "90+": {},
        },
        overdueByCurrency: { INR: "300000" },
      },
    },
  },
  {
    name: "boundary test: 90 vs 91 days",
    asOfDate: "2026-10-23",
    invoices: [
      {
        id: "inv-90",
        outstandingPaise: "100000",
        dueAt: "2026-07-25", // exactly 90 days
        currency: "INR",
        buyerAccountId: "buyer-1",
      },
      {
        id: "inv-91",
        outstandingPaise: "200000",
        dueAt: "2026-07-24", // exactly 91 days
        currency: "INR",
        buyerAccountId: "buyer-1",
      },
    ],
    expected: {
      shopTotals: {
        totalByCurrency: { INR: "300000" },
        buckets: {
          current: {},
          "1-30": {},
          "31-60": {},
          "61-90": { INR: "100000" },
          "90+": { INR: "200000" },
        },
        overdueByCurrency: { INR: "300000" },
      },
    },
  },
  {
    name: "multi-currency invoices",
    asOfDate: "2026-10-23",
    invoices: [
      {
        id: "inv-inr-1",
        outstandingPaise: "100000",
        dueAt: "2026-10-08",
        currency: "INR",
        buyerAccountId: "buyer-1",
      },
      {
        id: "inv-usd-1",
        outstandingPaise: "50000",
        dueAt: "2026-10-08",
        currency: "USD",
        buyerAccountId: "buyer-1",
      },
      {
        id: "inv-inr-2",
        outstandingPaise: "200000",
        dueAt: "2026-09-08",
        currency: "INR",
        buyerAccountId: "buyer-2",
      },
    ],
    expected: {
      shopTotals: {
        totalByCurrency: { INR: "300000", USD: "50000" },
        buckets: {
          current: {},
          "1-30": { INR: "100000", USD: "50000" },
          "31-60": { INR: "200000" },
          "61-90": {},
          "90+": {},
        },
        overdueByCurrency: { INR: "300000", USD: "50000" },
      },
    },
  },
  {
    name: "null due date (treated as current)",
    asOfDate: "2026-10-23",
    invoices: [
      {
        id: "inv-1",
        outstandingPaise: "100000",
        dueAt: null,
        currency: "INR",
        buyerAccountId: "buyer-1",
      },
    ],
    expected: {
      shopTotals: {
        totalByCurrency: { INR: "100000" },
        buckets: {
          current: { INR: "100000" },
          "1-30": {},
          "31-60": {},
          "61-90": {},
          "90+": {},
        },
        overdueByCurrency: {},
      },
    },
  },
];

describe("parity test fixtures", () => {
  it.each(PARITY_TEST_FIXTURES)("$name", (fixture) => {
    const asOf = asOfDate(fixture.asOfDate);
    const invoices: OpenInvoice[] = fixture.invoices.map((inv) => ({
      id: inv.id,
      outstandingPaise: BigInt(inv.outstandingPaise),
      dueAt: inv.dueAt ? dueDate(inv.dueAt) : null,
      currency: inv.currency,
      buyerAccountId: inv.buyerAccountId,
    }));

    const result = calculateAging(invoices, asOf);
    const serialized = serializeAgingTotals(result.shopTotals);

    // Compare totals
    expect(serialized.totalByCurrency).toEqual(
      fixture.expected.shopTotals.totalByCurrency
    );

    // Compare each bucket
    for (const bucketKey of AGING_BUCKET_KEYS) {
      expect(serialized.buckets[bucketKey].byCurrency).toEqual(
        fixture.expected.shopTotals.buckets[bucketKey]
      );
    }

    // Compare overdue
    expect(serialized.overdueByCurrency).toEqual(
      fixture.expected.shopTotals.overdueByCurrency
    );
  });
});
