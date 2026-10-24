/**
 * Gap 2 fixture: Wrappers that hide raw values
 * 
 * The guard should unwrap and check:
 * - JSON.stringify(x)
 * - String(x)
 * - Ternary: cond ? x : y
 * - Nullish coalescing: x ?? y
 * - Logical OR: x || y
 * - Parentheses: (x)
 * - Type casts: x as T
 */

// SHOULD FAIL: JSON.stringify wrapping error
export function logJsonStringifyError(err: Error) {
  console.log("Error:", JSON.stringify(err));
}

// SHOULD FAIL: String() wrapping error
export function logStringError(err: Error) {
  console.log("Error:", String(err));
}

// SHOULD FAIL: Ternary with error in true branch
export function logTernaryErrorTrue(err: Error | null) {
  console.log("Result:", err ? err : "no error");
}

// SHOULD FAIL: Ternary with sensitive value in false branch
export function logTernaryDomainFalse(shopDomain: string | null, fallback: string) {
  console.log("Shop:", shopDomain ?? fallback);
}

// SHOULD FAIL: Nullish coalescing with error
export function logNullishError(err: Error | undefined, defaultErr: Error) {
  console.log("Error:", err ?? defaultErr);
}

// SHOULD FAIL: Logical OR with sensitive value
export function logOrSensitive(shop: string | undefined, defaultShop: string) {
  console.log("Shop:", shop || defaultShop);
}

// SHOULD FAIL: Parentheses wrapping sensitive value
export function logParensSensitive(email: string) {
  console.log("Contact:", (email));
}

// SHOULD FAIL: Type cast wrapping sensitive value
export function logAsCastSensitive(domain: unknown) {
  console.log("Domain:", domain as string);
}

// SHOULD FAIL: Nested wrappers
export function logNestedWrappers(err: Error | null) {
  console.log("Error:", JSON.stringify(err ?? new Error("default")));
}

// SHOULD PASS: Safe wrapped values
export function logSafeWrapped(shopId: string | null, defaultId: string) {
  console.log("Shop ID:", shopId ?? defaultId);
}

// SHOULD PASS: toErrorCode wrapped (safe)
export function logToErrorCodeWrapped(err: Error) {
  const toErrorCode = (e: Error) => e.name;
  console.log(`Error: ${toErrorCode(err)}`);
}
