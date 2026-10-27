import { describe, it, expect } from "vitest";
import { parsePageParam } from "../parse-page-param";

/**
 * Tests for F4 page parameter parsing.
 *
 * Verifies parsePageParam returns 1 for invalid values
 * (non-finite, zero, negative, decimal, NaN) and N for valid N.
 */

describe("parsePageParam", () => {
  it("returns 1 for 'abc' (NaN)", () => {
    expect(parsePageParam("abc")).toBe(1);
  });

  it("returns 1 for '0' (zero)", () => {
    expect(parsePageParam("0")).toBe(1);
  });

  it("returns 1 for '-2' (negative)", () => {
    expect(parsePageParam("-2")).toBe(1);
  });

  it("returns 1 for '1.5' (decimal)", () => {
    expect(parsePageParam("1.5")).toBe(1);
  });

  it("returns 1 for null", () => {
    expect(parsePageParam(null)).toBe(1);
  });

  it("returns 1 for undefined", () => {
    expect(parsePageParam(undefined)).toBe(1);
  });

  it("returns 1 for empty string", () => {
    expect(parsePageParam("")).toBe(1);
  });

  it("returns 1 for Infinity string", () => {
    expect(parsePageParam("Infinity")).toBe(1);
  });

  it("returns 1 for '-Infinity' string", () => {
    expect(parsePageParam("-Infinity")).toBe(1);
  });

  it("returns 1 for 'NaN' string", () => {
    expect(parsePageParam("NaN")).toBe(1);
  });

  it("returns N for valid positive integer N", () => {
    expect(parsePageParam("1")).toBe(1);
    expect(parsePageParam("2")).toBe(2);
    expect(parsePageParam("5")).toBe(5);
    expect(parsePageParam("100")).toBe(100);
    expect(parsePageParam("999")).toBe(999);
  });
});
