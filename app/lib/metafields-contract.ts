/**
 * Metafields Contract Types
 *
 * This module contains the TypeScript types and serialization utilities for the
 * credit_status metafield used by the Net Terms Receivables app.
 *
 * See docs/metafields-contract.md for the complete specification.
 */

/**
 * Machine-readable reason codes for credit holds.
 * Never contains PII.
 */
export type HoldReasonCode =
  | "MANUAL_HOLD"
  | "PAYMENT_OVERDUE"
  | "CREDIT_REVIEW"
  | "NEW_ACCOUNT"
  | "FRAUD_SUSPECTED"
  | null;

/**
 * The credit status metafield schema.
 * Amounts are stored as integer paise (smallest currency unit) as strings.
 */
export interface CreditStatus {
  /** Schema version for forward compatibility. Always 1 for this version. */
  schemaVersion: 1;
  /** ISO 4217 currency code (e.g., INR, USD). */
  currencyCode: string;
  /** True if the account is on credit hold. */
  hold: boolean;
  /** Machine-readable reason code for the hold (no PII). */
  holdReasonCode: HoldReasonCode;
  /** Credit limit in integer paise as a string. */
  limitPaise: string;
  /** Current outstanding exposure in integer paise as a string. */
  exposurePaise: string;
  /** ISO 8601 timestamp of last update. */
  updatedAt: string;
}

/**
 * Input parameters for creating a CreditStatus.
 * Amounts can be provided as numbers (will be converted to paise strings).
 */
export interface CreditStatusInput {
  currencyCode: string;
  hold: boolean;
  holdReasonCode?: HoldReasonCode;
  /** Credit limit in the currency's main unit (e.g., rupees, dollars). */
  limit: number;
  /** Current outstanding exposure in the currency's main unit. */
  exposure: number;
}

/**
 * Convert a currency amount to paise (smallest unit) as a string.
 * Amounts are multiplied by 100 and rounded to avoid floating-point issues.
 */
export function toPaiseString(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`Invalid amount: ${amount}`);
  }
  const paise = Math.round(amount * 100);
  return paise.toString();
}

/**
 * Convert a paise string back to the currency's main unit.
 */
export function fromPaiseString(paiseStr: string): number {
  const paise = BigInt(paiseStr);
  return Number(paise) / 100;
}

/**
 * Serialize a CreditStatus to a JSON string for metafieldsSet.
 *
 * @param input - The credit status parameters
 * @returns JSON string suitable for metafield value
 *
 * @example
 * ```ts
 * const json = serializeCreditStatus({
 *   currencyCode: 'INR',
 *   hold: false,
 *   limit: 100000,      // ₹100,000
 *   exposure: 50000,    // ₹50,000
 * });
 * // Returns: '{"schemaVersion":1,"currencyCode":"INR","hold":false,...}'
 * ```
 */
export function serializeCreditStatus(input: CreditStatusInput): string {
  const status: CreditStatus = {
    schemaVersion: 1,
    currencyCode: input.currencyCode,
    hold: input.hold,
    holdReasonCode: input.holdReasonCode ?? null,
    limitPaise: toPaiseString(input.limit),
    exposurePaise: toPaiseString(input.exposure),
    updatedAt: new Date().toISOString(),
  };

  return JSON.stringify(status);
}

/**
 * Parse a CreditStatus from a JSON string.
 * Returns null for invalid or malformed JSON (fail-open behavior).
 *
 * @param json - The JSON string from a metafield value
 * @returns Parsed CreditStatus or null if invalid
 */
export function parseCreditStatus(json: string): CreditStatus | null {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;

    if (parsed.schemaVersion !== 1) {
      return null;
    }

    if (
      typeof parsed.currencyCode !== "string" ||
      typeof parsed.hold !== "boolean" ||
      typeof parsed.limitPaise !== "string" ||
      typeof parsed.exposurePaise !== "string" ||
      typeof parsed.updatedAt !== "string"
    ) {
      return null;
    }

    if (!/^\d+$/.test(parsed.limitPaise) || !/^\d+$/.test(parsed.exposurePaise)) {
      return null;
    }

    return {
      schemaVersion: 1,
      currencyCode: parsed.currencyCode,
      hold: parsed.hold,
      holdReasonCode: (parsed.holdReasonCode as HoldReasonCode) ?? null,
      limitPaise: parsed.limitPaise,
      exposurePaise: parsed.exposurePaise,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Check if a credit status would block checkout.
 *
 * @param status - The credit status to check
 * @param cartTotalPaise - The cart total in paise
 * @param cartCurrency - The cart's currency code
 * @returns Object with blocked flag and reason
 */
export function checkCreditStatus(
  status: CreditStatus | null,
  cartTotalPaise: bigint,
  cartCurrency: string,
): { blocked: boolean; reason?: "hold" | "over_limit" } {
  if (!status) {
    return { blocked: false };
  }

  if (status.hold) {
    return { blocked: true, reason: "hold" };
  }

  if (status.currencyCode !== cartCurrency) {
    return { blocked: false };
  }

  const limitPaise = BigInt(status.limitPaise);
  const exposurePaise = BigInt(status.exposurePaise);
  const totalExposure = exposurePaise + cartTotalPaise;

  if (totalExposure > limitPaise) {
    return { blocked: true, reason: "over_limit" };
  }

  return { blocked: false };
}

/**
 * Metafield namespace and key constants.
 * The $app namespace is resolved at deploy time to the app's unique namespace.
 */
export const METAFIELD = {
  namespace: "$app",
  key: "credit_status",
  type: "json",
} as const;

/**
 * #292: Shop config metafield written during OAuth and read by Rust functions.
 * Contains shop currency for INR-only validation.
 */
export const SHOP_CONFIG_METAFIELD = {
  namespace: "$app",
  key: "shop_config",
  type: "json",
} as const;

/**
 * #292: The shop config metafield schema.
 * Written by after-auth and read by Rust functions to determine shop currency.
 */
export interface ShopConfig {
  /** Schema version for forward compatibility. Always 1 for this version. */
  schemaVersion: 1;
  /** ISO 4217 currency code (e.g., INR, USD). */
  currencyCode: string;
}

/**
 * #292: Serialize a ShopConfig to a JSON string for metafieldsSet.
 */
export function serializeShopConfig(currencyCode: string): string {
  const config: ShopConfig = {
    schemaVersion: 1,
    currencyCode,
  };
  return JSON.stringify(config);
}

/**
 * #292: Parse a ShopConfig from a JSON string.
 * Returns null for invalid or malformed JSON (fail-open behavior).
 */
export function parseShopConfig(json: string): ShopConfig | null {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;

    if (parsed.schemaVersion !== 1) {
      return null;
    }

    if (typeof parsed.currencyCode !== "string") {
      return null;
    }

    return {
      schemaVersion: 1,
      currencyCode: parsed.currencyCode,
    };
  } catch {
    return null;
  }
}

/**
 * Input for serializing credit status from database values.
 * Amounts are already in paise (bigint).
 */
export interface CreditStatusDbInput {
  currencyCode: string;
  hold: boolean;
  holdReasonCode: HoldReasonCode;
  /** Credit limit in paise. Null = no limit (serialize as a very large value). */
  limitPaise: bigint | null;
  /** Current exposure in paise. */
  exposurePaise: bigint;
}

/**
 * Serialize a CreditStatus from database values where amounts are already in paise.
 *
 * This is used by the credit-status writer service to create the metafield value
 * that the Rust validation function will read.
 *
 * @param input - The credit status parameters with amounts in paise
 * @returns JSON string suitable for metafield value
 */
export function serializeCreditStatusFromDb(input: CreditStatusDbInput): string {
  const status: CreditStatus = {
    schemaVersion: 1,
    currencyCode: input.currencyCode,
    hold: input.hold,
    holdReasonCode: input.holdReasonCode,
    limitPaise: input.limitPaise?.toString() ?? "999999999999999",
    exposurePaise: input.exposurePaise.toString(),
    updatedAt: new Date().toISOString(),
  };

  return JSON.stringify(status);
}

/**
 * Parse paise string to bigint, with validation.
 * Returns null for invalid values.
 */
export function parsePaiseString(value: string | null | undefined): bigint | null {
  if (!value) return null;
  if (!/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}
