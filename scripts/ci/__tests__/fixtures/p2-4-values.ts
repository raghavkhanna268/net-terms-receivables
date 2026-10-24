/**
 * P2.4: Check values, not just keys
 *
 * - { store: shop } (identifier value matching deny regex)
 * - { error: err.message } or any .message or .stack
 * - Raw error passed positionally: console.error(x, err)
 */

// SHOULD FAIL: Identifier value matching deny regex
export function logStoreAsShop(shop: string) {
  console.log("Store info", { store: shop });
}

export function logIdAsDomain(domain: string) {
  console.log("ID", { id: domain });
}

// SHOULD FAIL: .message property access
export function logErrorMessage(err: Error) {
  console.log("Error", { error: err.message });
}

// SHOULD FAIL: .stack property access
export function logErrorStack(err: Error) {
  console.log("Stack", { trace: err.stack });
}

// SHOULD FAIL: Raw error as positional argument
export function logRawError() {
  try {
    throw new Error("test");
  } catch (err) {
    console.error("Failed:", err);
  }
}

// SHOULD FAIL: String(err) stringification
export function logStringifiedError(err: Error) {
  console.log("Error", { text: String(err) });
}

// SHOULD PASS: Safe value usage
export function logSafeValues(shopId: string, status: string) {
  console.log("Info", { id: shopId, state: status });
}
