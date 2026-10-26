/**
 * Test fixture with only safe patterns - should pass all checks.
 */

import { safeLog, shopHash } from "~/lib/log.server";

// Safe: shopId is allowlisted
export function logWithShopId(shopId: string) {
  console.log("Processing", { shopId });
}

// Safe: shopHash is allowlisted (keyed by LOG_HASH_KEY, returns undefined if key missing)
export async function logWithShopHash(shop: string) {
  const hash = await shopHash(shop);
  if (hash) {
    safeLog("info", "test_event", { shopHash: hash });
  }
}

// Safe: count metrics are allowlisted
export function logCounts() {
  console.log("Metrics", { 
    count: 5, 
    totalCount: 100, 
    orderCount: 50,
    invoiceCount: 25 
  });
}

// Safe: IDs and GIDs are allowlisted
export function logIds(orderId: string, orderGid: string, customerId: string) {
  console.log("Order", { orderId, orderGid, customerId, requestId: "req-123" });
}

// Safe: status/action enums are allowlisted
export function logStatus(status: string, action: string) {
  console.log("Result", { status, action, success: true });
}

// Safe: error codes are allowlisted
export function logError(errorCode: string, code: string) {
  console.log("Error", { errorCode, code, err: "timeout" });
}

// Safe: timing metrics are allowlisted
export function logTiming(durationMs: number, elapsedMs: number) {
  console.log("Performance", { durationMs, elapsedMs });
}

// Safe: validation regex patterns are OK
export function isValidShop(domain: string): boolean {
  return /\.myshopify\.com$/.test(domain);
}

// Safe: type definitions don't trigger violations
type SafeData = {
  shopId: string;
  count: number;
};

export function processData(data: SafeData) {
  console.log("Data", data);
}
