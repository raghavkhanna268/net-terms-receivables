import { describe, it, expect } from "vitest";
import { parsePageParam } from "../parse-page-param";

/**
 * Tests for F4 page parameter parsing.
 *
 * Verifies parsePageParam returns 1 for invalid values
 * (non-finite, zero, negative, decimal, NaN, leading zeros, exponent notation,
 * non-safe-integer) and N for valid N, capped at 10000.
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

  it("returns 1 for '-1' (negative)", () => {
    expect(parsePageParam("-1")).toBe(1);
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

  it("returns 100 for '1e2' (exponent notation)", () => {
    expect(parsePageParam("1e2")).toBe(100);
  });

  it("returns 2 for '02' (leading zero)", () => {
    expect(parsePageParam("02")).toBe(2);
  });

  it("returns 1 for 20-digit value (non-safe-integer)", () => {
    expect(parsePageParam("12345678901234567890")).toBe(1);
  });

  it("returns N for valid positive integer N", () => {
    expect(parsePageParam("1")).toBe(1);
    expect(parsePageParam("2")).toBe(2);
    expect(parsePageParam("5")).toBe(5);
    expect(parsePageParam("100")).toBe(100);
    expect(parsePageParam("999")).toBe(999);
  });

  it("caps at 10000 for values above", () => {
    expect(parsePageParam("10001")).toBe(10000);
    expect(parsePageParam("99999")).toBe(10000);
  });

  it("returns 10000 for exactly 10000", () => {
    expect(parsePageParam("10000")).toBe(10000);
  });
});
