/**
 * P2.4 (extended): Direct arguments to console/safeLog
 *
 * These should all FAIL:
 * - console.error("x", err.message)
 * - console.error("x", String(err))
 * - console.log("x", session.shop)
 * - console.error(err)
 * - console.log(shopDomain)
 */

interface Session {
  shop: string;
  id: string;
}

// SHOULD FAIL: err.message as direct argument
export function logErrMessage(err: Error) {
  console.error("Failed:", err.message);
}

// SHOULD FAIL: String(err) as direct argument
export function logStringErr(err: Error) {
  console.error("Error:", String(err));
}

// SHOULD FAIL: session.shop as direct argument
export function logSessionShop(session: Session) {
  console.log("Shop:", session.shop);
}

// SHOULD FAIL: err as first argument (no argIndex > 0 condition)
export function logErrFirst(err: Error) {
  console.error(err);
}

// SHOULD FAIL: shopDomain as first argument
export function logShopDomainFirst(shopDomain: string) {
  console.log(shopDomain);
}

// SHOULD PASS: safe arguments
export function logSafeArgs(shopId: string, count: number) {
  console.log("Processing:", shopId, count);
}
