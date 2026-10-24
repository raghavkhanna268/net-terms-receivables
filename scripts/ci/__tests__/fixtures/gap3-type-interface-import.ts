/**
 * Gap 3: Lines containing type, interface, import, // or /* were skipped entirely
 * The grep-based checker skipped any line with these keywords.
 * The AST-based checker properly analyzes all executable code.
 */

// Type definition - this should be ignored (not a log call)
type _PaymentData = {
  amount: number;
  shop: string;
};

// Interface definition - this should be ignored (not a log call)
interface OrderInfo {
  totalAmount: number;
  shopDomain: string;
}

// Import statement - this should be ignored (not a log call)
import { safeLog as _safeLog } from "~/lib/log.server";

// SHOULD FAIL: Console.log after import (the import keyword in the file shouldn't
// cause the whole file to be skipped)
export function logAfterImport(shop: string) {
  console.log(`Processing ${shop}`);
}

// SHOULD FAIL: Console.log with inline comment
export function logWithComment(shopDomain: string) {
  console.log(`Webhook received for ${shopDomain}`); // this is the domain
}

// SHOULD FAIL: Console.log in function that returns an interface-typed value
export function processAndLog(shop: string): OrderInfo {
  console.log(`Processing order for ${shop}`);
  return { totalAmount: 0, shopDomain: shop };
}

// SHOULD PASS: Type assertion doesn't make sensitive data safe
export function logTypedData(shopId: string) {
  console.log("Typed data", { shopId, status: "ok" });
}
