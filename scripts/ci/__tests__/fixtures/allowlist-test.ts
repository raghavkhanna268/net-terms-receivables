/**
 * Test fixture for allowlist burn-down functionality.
 * This file has exactly 3 violations for testing count mechanics.
 */

// Violation 1: shop interpolation
export function violation1(shop: string) {
  console.log(`Processing ${shop}`);
}

// Violation 2: shop interpolation
export function violation2(shop: string) {
  console.log(`Webhook for ${shop}`);
}

// Violation 3: shop interpolation
export function violation3(shop: string) {
  console.log(`Completed ${shop}`);
}
