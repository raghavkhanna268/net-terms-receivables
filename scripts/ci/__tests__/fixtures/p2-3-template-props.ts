/**
 * P2.3: Template interpolation should match on last property name
 *
 * ${session.shop}, ${payload.shop}, ${x.shopDomain} should all FAIL.
 */

interface Session {
  shop: string;
  id: string;
}

interface Payload {
  shop: string;
  data: unknown;
}

// SHOULD FAIL: session.shop
export function logSessionShop(session: Session) {
  console.log(`Processing ${session.shop}`);
}

// SHOULD FAIL: payload.shop
export function logPayloadShop(payload: Payload) {
  console.log(`Webhook for ${payload.shop}`);
}

// SHOULD FAIL: x.shopDomain
export function logShopDomain(x: { shopDomain: string }) {
  console.log(`Domain is ${x.shopDomain}`);
}

// SHOULD FAIL: input.shop
export function logInputShop(input: { shop: string }) {
  console.log(`Input shop: ${input.shop}`);
}

// SHOULD FAIL: job.shop (any property named shop)
export function logJobShop(job: { shop: string; id: string }) {
  console.log(`Job for ${job.shop}`);
}

// SHOULD PASS: Safe property access
export function logSafeProps(session: { shopId: string }) {
  console.log(`Session for ${session.shopId}`);
}
