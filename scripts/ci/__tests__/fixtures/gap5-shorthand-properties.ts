/**
 * Gap 5: Shorthand properties weren't caught
 * The grep-based checker missed { shop } and { shopDomain } shorthand syntax.
 * The AST-based checker properly detects shorthand property assignments.
 */

// SHOULD FAIL: { shop } shorthand in console.log
export function logShopShorthand(shop: string) {
  console.log("Order received", { shop });
}

// SHOULD FAIL: { shopDomain } shorthand
export function logShopDomainShorthand(shopDomain: string) {
  console.log("Webhook", { shopDomain, topic: "orders/create" });
}

// SHOULD FAIL: { domain } shorthand
export function logDomainShorthand(domain: string) {
  console.log("Request", { domain });
}

// SHOULD FAIL: { email } shorthand
export function logEmailShorthand(email: string) {
  console.log("User", { email });
}

// SHOULD FAIL: { amount } shorthand
export function logAmountShorthand(amount: number) {
  console.log("Payment", { amount });
}

// SHOULD FAIL: { narration } shorthand
export function logNarrationShorthand(narration: string) {
  console.log("Transaction", { narration });
}

// SHOULD FAIL: Multiple shorthand sensitive keys
export function logMultipleShorthand(shop: string, amount: number, payer: string) {
  console.log("Details", { shop, amount, payer });
}

// SHOULD FAIL: Nested object with shorthand
export function logNestedShorthand(shop: string) {
  console.log("Nested", { 
    data: { shop },
    status: "ok"
  });
}

// SHOULD PASS: Safe shorthand keys
export function safeshorthand(shopId: string, count: number, status: string) {
  console.log("Safe", { shopId, count, status });
}
