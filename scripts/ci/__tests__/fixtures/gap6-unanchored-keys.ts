/**
 * P1.1: Unanchored regex + snake_case + phone/address/notes
 *
 * All these keys should FAIL because the deny regex is unanchored:
 * /amount|paise|total|outstanding|balance|shop|domain|email|name|narration|payer|remitter|phone|address|note/i
 */

// SHOULD FAIL: email variations
export function logBuyerEmail(buyerEmail: string) {
  console.log("Buyer", { buyerEmail });
}

export function logCustomerEmail(customerEmail: string) {
  console.log("Customer", { customerEmail });
}

// SHOULD FAIL: name variations
export function logCompanyName(companyName: string) {
  console.log("Company", { companyName });
}

export function logFirstName(firstName: string) {
  console.log("User", { firstName });
}

export function logPayerName(payerName: string) {
  console.log("Payer", { payerName });
}

// SHOULD FAIL: domain variations
export function logMyshopifyDomain(myshopifyDomain: string) {
  console.log("Domain", { myshopifyDomain });
}

// SHOULD FAIL: snake_case variations (P1.1)
export function logShopDomainSnake(shop_domain: string) {
  console.log("Shop", { shop_domain });
}

export function logBuyerEmailSnake(buyer_email: string) {
  console.log("Buyer", { buyer_email });
}

// SHOULD FAIL: phone (P1.1 extension)
export function logPhone(phone: string) {
  console.log("Contact", { phone });
}

export function logPhoneNumber(phoneNumber: string) {
  console.log("Contact", { phoneNumber });
}

export function logMobilePhone(mobilePhone: string) {
  console.log("Contact", { mobilePhone });
}

// SHOULD FAIL: address (P1.1 extension)
export function logAddress(address: string) {
  console.log("Location", { address });
}

export function logShippingAddress(shippingAddress: string) {
  console.log("Order", { shippingAddress });
}

// SHOULD FAIL: notes (P1.1 extension)
export function logNotes(notes: string) {
  console.log("Record", { notes });
}

export function logOrderNotes(orderNotes: string) {
  console.log("Order", { orderNotes });
}

// SHOULD PASS: Allowlisted keys
export function logSafeKeys(shopId: string, shopHash: string, totalCount: number) {
  console.log("Safe", { shopId, shopHash, totalCount });
}
