import { describe, expect, it } from "vitest";
import { medianOfReported, countReported, formatMetric } from "../web-vitals-helpers";

describe("medianOfReported", () => {
  it("returns null when all values are null", () => {
    expect(medianOfReported([null, null, null])).toBe(null);
  });

  it("returns null for empty array", () => {
    expect(medianOfReported([])).toBe(null);
  });

  it("returns the single value when only one is reported", () => {
    expect(medianOfReported([null, 100, null])).toBe(100);
  });

  it("returns median of reported values, ignoring nulls", () => {
    expect(medianOfReported([100, null, 300])).toBe(200);
    expect(medianOfReported([100, 200, 300])).toBe(200);
  });

  it("handles real CLS of 0 correctly (not treated as missing)", () => {
    expect(medianOfReported([0, 0, 0])).toBe(0);
    expect(medianOfReported([0, null, 0.1])).toBe(0.05);
  });

  it("returns average of two middle values for even count", () => {
    expect(medianOfReported([100, 200, 300, 400])).toBe(250);
    expect(medianOfReported([null, 100, 200, null])).toBe(150);
  });
});

describe("countReported", () => {
  it("returns 0 when all values are null", () => {
    expect(countReported([null, null, null])).toBe(0);
  });

  it("returns 0 for empty array", () => {
    expect(countReported([])).toBe(0);
  });

  it("counts non-null values correctly", () => {
    expect(countReported([100, null, 300])).toBe(2);
    expect(countReported([100, 200, 300])).toBe(3);
    expect(countReported([null, 200, null])).toBe(1);
  });

  it("counts 0 as a reported value (not null)", () => {
    expect(countReported([0, 0, 0])).toBe(3);
    expect(countReported([0, null, 0])).toBe(2);
  });
});

describe("formatMetric", () => {
  it("returns 'not measured' for null value", () => {
    expect(formatMetric(null, 0, 3, "ms")).toBe("not measured");
    expect(formatMetric(null, 0, 3, "")).toBe("not measured");
  });

  it("formats ms values with count", () => {
    expect(formatMetric(1500, 3, 3, "ms")).toBe("1500ms (3/3)");
    expect(formatMetric(200, 2, 3, "ms")).toBe("200ms (2/3)");
  });

  it("formats CLS (non-ms) values with 4 decimal places", () => {
    expect(formatMetric(0.1234, 3, 3, "")).toBe("0.1234 (3/3)");
    expect(formatMetric(0, 2, 3, "")).toBe("0.0000 (2/3)");
  });

  it("shows real CLS of 0 correctly (not 'not measured')", () => {
    expect(formatMetric(0, 3, 3, "")).toBe("0.0000 (3/3)");
  });

  it("shows partial report counts", () => {
    expect(formatMetric(100, 1, 3, "ms")).toBe("100ms (1/3)");
    expect(formatMetric(0.05, 2, 3, "")).toBe("0.0500 (2/3)");
  });
});
