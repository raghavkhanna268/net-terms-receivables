/**
 * P2 (extended): Template spans with .message/.stack and sensitive last property
 *
 * These should all FAIL:
 * - ${err.message}
 * - ${buyer.email}
 * - ${company.name}
 */

interface Buyer {
  email: string;
  id: string;
}

interface Company {
  name: string;
  id: string;
}

// SHOULD FAIL: ${err.message} in template
export function logErrMessageTemplate(err: Error) {
  console.log(`Error occurred: ${err.message}`);
}

// SHOULD FAIL: ${err.stack} in template
export function logErrStackTemplate(err: Error) {
  console.log(`Stack trace: ${err.stack}`);
}

// SHOULD FAIL: ${buyer.email} in template
export function logBuyerEmailTemplate(buyer: Buyer) {
  console.log(`Buyer email: ${buyer.email}`);
}

// SHOULD FAIL: ${company.name} in template
export function logCompanyNameTemplate(company: Company) {
  console.log(`Company: ${company.name}`);
}

// SHOULD PASS: safe template interpolation
export function logSafeTemplate(buyer: { id: string }) {
  console.log(`Buyer ID: ${buyer.id}`);
}
