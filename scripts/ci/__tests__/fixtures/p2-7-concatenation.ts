/**
 * P2.7: String concatenation with sensitive identifiers
 *
 * "sync " + shop should FAIL
 */

// SHOULD FAIL: Simple concatenation with shop
export function logConcatShop(shop: string) {
  console.log("Processing " + shop);
}

// SHOULD FAIL: Concatenation with property access
export function logConcatDomain(data: { domain: string }) {
  console.log("Domain: " + data.domain);
}

// SHOULD FAIL: Multiple concatenations
export function logMultiConcat(shop: string, email: string) {
  console.log("Shop: " + shop + ", Email: " + email);
}

// SHOULD PASS: Safe concatenation
export function logSafeConcat(shopId: string, count: number) {
  console.log("ID: " + shopId + ", Count: " + count);
}
