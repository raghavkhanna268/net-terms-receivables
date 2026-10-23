import { describe, it, expect } from "vitest";
import {
  serializeCreditStatus,
  parseCreditStatus,
  checkCreditStatus,
  toPaiseString,
  fromPaiseString,
  type CreditStatus,
} from "../metafields-contract";
import fixturesJson from "../../../tests/fixtures/credit-status.json";

const fixtures = fixturesJson as {
  valid: Record<string, CreditStatus>;
  invalid: Record<string, Record<string, unknown>>;
};

describe("metafields-contract", () => {
  describe("toPaiseString", () => {
    it("converts whole numbers", () => {
      expect(toPaiseString(100)).toBe("10000");
      expect(toPaiseString(1000)).toBe("100000");
    });

    it("converts decimals", () => {
      expect(toPaiseString(100.5)).toBe("10050");
      expect(toPaiseString(1234.56)).toBe("123456");
    });

    it("rounds to avoid floating point issues", () => {
      expect(toPaiseString(0.1 + 0.2)).toBe("30");
    });

    it("throws for invalid amounts", () => {
      expect(() => toPaiseString(-100)).toThrow("Invalid amount");
      expect(() => toPaiseString(NaN)).toThrow("Invalid amount");
      expect(() => toPaiseString(Infinity)).toThrow("Invalid amount");
    });
  });

  describe("fromPaiseString", () => {
    it("converts paise to main unit", () => {
      expect(fromPaiseString("10000")).toBe(100);
      expect(fromPaiseString("123456")).toBe(1234.56);
    });

    it("handles zero", () => {
      expect(fromPaiseString("0")).toBe(0);
    });
  });

  describe("serializeCreditStatus", () => {
    it("creates valid JSON matching the schema", () => {
      const json = serializeCreditStatus({
        currencyCode: "INR",
        hold: false,
        limit: 100000,
        exposure: 50000,
      });

      const parsed = JSON.parse(json);
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.currencyCode).toBe("INR");
      expect(parsed.hold).toBe(false);
      expect(parsed.holdReasonCode).toBe(null);
      expect(parsed.limitPaise).toBe("10000000");
      expect(parsed.exposurePaise).toBe("5000000");
      expect(parsed.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("includes holdReasonCode when provided", () => {
      const json = serializeCreditStatus({
        currencyCode: "INR",
        hold: true,
        holdReasonCode: "PAYMENT_OVERDUE",
        limit: 100000,
        exposure: 50000,
      });

      const parsed = JSON.parse(json);
      expect(parsed.holdReasonCode).toBe("PAYMENT_OVERDUE");
    });
  });

  describe("parseCreditStatus", () => {
    it("parses valid status from fixtures", () => {
      const json = JSON.stringify(fixtures.valid.notOnHold);
      const status = parseCreditStatus(json);

      expect(status).not.toBeNull();
      expect(status?.schemaVersion).toBe(1);
      expect(status?.currencyCode).toBe("INR");
      expect(status?.hold).toBe(false);
      expect(status?.limitPaise).toBe("10000000");
      expect(status?.exposurePaise).toBe("5000000");
    });

    it("returns null for wrong schema version", () => {
      const json = JSON.stringify(fixtures.invalid.wrongSchemaVersion);
      expect(parseCreditStatus(json)).toBeNull();
    });

    it("returns null for missing fields", () => {
      const json = JSON.stringify(fixtures.invalid.missingFields);
      expect(parseCreditStatus(json)).toBeNull();
    });

    it("returns null for invalid paise format", () => {
      const json = JSON.stringify(fixtures.invalid.invalidPaise);
      expect(parseCreditStatus(json)).toBeNull();
    });

    it("returns null for malformed JSON", () => {
      const json = JSON.stringify(fixtures.invalid.malformed);
      expect(parseCreditStatus(json)).toBeNull();
    });

    it("returns null for invalid JSON string", () => {
      expect(parseCreditStatus("not json")).toBeNull();
      expect(parseCreditStatus("")).toBeNull();
    });
  });

  describe("checkCreditStatus", () => {
    it("returns blocked=false for null status (fail-open)", () => {
      const result = checkCreditStatus(null, 100000n, "INR");
      expect(result.blocked).toBe(false);
    });

    it("blocks when hold is true", () => {
      const status = fixtures.valid.onHold;
      const result = checkCreditStatus(status, 100000n, "INR");
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe("hold");
    });

    it("allows when under limit", () => {
      const status = fixtures.valid.notOnHold;
      const result = checkCreditStatus(status, 1000000n, "INR");
      expect(result.blocked).toBe(false);
    });

    it("blocks when over limit", () => {
      const status = fixtures.valid.notOnHold;
      const result = checkCreditStatus(status, 6000000n, "INR");
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe("over_limit");
    });

    it("allows when exactly at limit", () => {
      const status = fixtures.valid.notOnHold;
      const result = checkCreditStatus(status, 5000000n, "INR");
      expect(result.blocked).toBe(false);
    });

    it("allows on currency mismatch (fail-open)", () => {
      const status = fixtures.valid.notOnHold;
      const result = checkCreditStatus(status, 999999999n, "USD");
      expect(result.blocked).toBe(false);
    });
  });

  describe("roundtrip serialization", () => {
    it("serialized output can be parsed back", () => {
      const input = {
        currencyCode: "INR",
        hold: true,
        holdReasonCode: "MANUAL_HOLD" as const,
        limit: 50000,
        exposure: 25000,
      };

      const json = serializeCreditStatus(input);
      const parsed = parseCreditStatus(json);

      expect(parsed).not.toBeNull();
      expect(parsed?.currencyCode).toBe("INR");
      expect(parsed?.hold).toBe(true);
      expect(parsed?.holdReasonCode).toBe("MANUAL_HOLD");
      expect(parsed?.limitPaise).toBe("5000000");
      expect(parsed?.exposurePaise).toBe("2500000");
    });
  });

  describe("matches Rust implementation expectations", () => {
    it("uses the same fixture values as Rust tests", () => {
      const status = fixtures.valid.notOnHold;
      expect(status.limitPaise).toBe("10000000");
      expect(status.exposurePaise).toBe("5000000");

      const check1 = checkCreditStatus(status, 5000000n, "INR");
      expect(check1.blocked).toBe(false);

      const check2 = checkCreditStatus(status, 5000001n, "INR");
      expect(check2.blocked).toBe(true);
    });
  });
});
