/**
 * Gap 1: Multi-line safeLog/console calls
 * The grep-based checker ran line by line, so multi-line calls slipped through.
 * The AST-based checker properly handles these.
 */

// SHOULD FAIL: Multi-line console.log with shop interpolation
export function multiLineConsole(shop: string) {
  console.log(
    `[multiline] Processing webhook for ${shop}`
  );
}

// SHOULD FAIL: Multi-line safeLog with sensitive key in object literal
export function multiLineSafeLog(amount: number) {
  safeLog("info", "payment_received", {
    amount,
    currency: "INR"
  });
}

// SHOULD FAIL: Multi-line Sentry call with shop in template
import { captureMessage } from "~/lib/sentry";

export function multiLineSentry(shop: string) {
  captureMessage(
    `Order sync failed for ${shop}`
  );
}

// SHOULD PASS: Multi-line call with safe keys only
export function multiLineSafe(shopId: string) {
  console.log(
    "[multiline] Processing completed",
    { shopId, count: 5 }
  );
}

function safeLog(_level: string, _event: string, _fields: Record<string, unknown>) {}
