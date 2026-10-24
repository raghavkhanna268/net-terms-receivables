/**
 * Gap 2: Amount keys with variations
 * The grep-based checker missed keys like amountPaise, totalPaise, outstandingPaise,
 * and "amount :" (with space before colon).
 * The AST-based checker catches all variations.
 */

// SHOULD FAIL: amountPaise key
export function logAmountPaise() {
  console.log("Payment details", { amountPaise: 50000 });
}

// SHOULD FAIL: totalPaise key
export function logTotalPaise() {
  console.log("Order total", { totalPaise: 100000 });
}

// SHOULD FAIL: outstandingPaise key
export function logOutstandingPaise() {
  console.log("Outstanding balance", { outstandingPaise: 25000 });
}

// SHOULD FAIL: amount key (original pattern)
export function logAmount() {
  console.log("Invoice", { amount: 500.00 });
}

// SHOULD FAIL: outstanding key
export function logOutstanding() {
  console.log("Account status", { outstanding: 1000 });
}

// SHOULD FAIL: balance key
export function logBalance() {
  console.log("Account balance", { balance: 5000 });
}

// SHOULD FAIL: total as shorthand
export function logTotalShorthand(total: number) {
  console.log("Summary", { total });
}

// SHOULD PASS: count keys are safe (aggregate metrics)
export function logCount() {
  console.log("Metrics", { count: 5, totalCount: 100, orderCount: 50 });
}

// SHOULD PASS: shopId is safe
export function logSafeAmount(shopId: string) {
  console.log("Processing", { shopId, status: "completed" });
}
