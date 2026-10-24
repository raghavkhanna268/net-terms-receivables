/**
 * P3.10: Walk arrays inside object literals and arguments
 *
 * { items: [{ email }] } should FAIL
 */

// SHOULD FAIL: Array with object containing sensitive key
export function logArrayWithEmail(emails: string[]) {
  console.log("Users", { items: [{ email: emails[0] }] });
}

// SHOULD FAIL: Array with shorthand sensitive key
export function logArrayShorthand(shop: string) {
  console.log("Shops", { list: [{ shop }] });
}

// SHOULD FAIL: Nested array with sensitive data
export function logNestedArray(domain: string) {
  console.log("Data", { 
    outer: [
      { inner: [{ domain }] }
    ]
  });
}

// SHOULD FAIL: Direct array argument with sensitive identifier
export function logDirectArray(shop: string, email: string) {
  console.log("Items", [shop, email]);
}

// SHOULD PASS: Safe array
export function logSafeArray(shopId: string, count: number) {
  console.log("Items", { list: [{ shopId, count }] });
}
