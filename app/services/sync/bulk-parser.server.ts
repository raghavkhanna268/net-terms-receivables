/**
 * Bulk JSONL parser for S6.
 *
 * Parses JSONL output from Shopify bulk operations.
 * Each line is a JSON object representing a Company, CompanyLocation, or Order.
 *
 * Bulk operations use a flat structure where nested objects reference their
 * parent via __parentId. For example:
 *
 * {"id":"gid://shopify/Company/1","name":"Acme"}
 * {"id":"gid://shopify/CompanyLocation/1","name":"HQ","__parentId":"gid://shopify/Company/1"}
 *
 * The parser groups locations under their parent companies and handles
 * nested order data similarly.
 */

import type {
  BulkCompanyLine,
  BulkCompanyLocationLine,
  BulkOrderLine,
  BulkCustomerLine,
  ParsedBulkResult,
  ShopifyCompanyLocation,
  ShopifyOrder,
  ShopifyCustomer,
} from "./types";

/**
 * Parse a JSONL string into typed lines.
 *
 * @param jsonl - Raw JSONL content (newline-separated JSON objects)
 * @returns Parsed result with items and errors
 */
export function parseJsonl<T>(jsonl: string): ParsedBulkResult<T> {
  const lines = jsonl.split("\n").filter((line) => line.trim().length > 0);
  const items: T[] = [];
  const errors: ParsedBulkResult<T>["errors"] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    try {
      const parsed = JSON.parse(line) as T;
      items.push(parsed);
    } catch (e) {
      errors.push({
        line: i + 1,
        error: e instanceof Error ? e.message : "Parse error",
        raw: line.substring(0, 200), // Truncate for logging
      });
    }
  }

  return {
    items,
    errors,
    totalLines: lines.length,
  };
}

/**
 * Parse company bulk JSONL and group locations under companies.
 *
 * Returns companies with their locations attached for efficient processing.
 *
 * @param jsonl - Raw JSONL from bulk company query
 * @returns Map of company ID to company with locations
 */
export function parseCompanyBulkJsonl(jsonl: string): {
  companies: Map<string, { company: BulkCompanyLine; locations: BulkCompanyLocationLine[] }>;
  orphanLocations: BulkCompanyLocationLine[];
  errors: ParsedBulkResult<unknown>["errors"];
} {
  const parsed = parseJsonl<BulkCompanyLine | BulkCompanyLocationLine>(jsonl);

  const companies = new Map<
    string,
    { company: BulkCompanyLine; locations: BulkCompanyLocationLine[] }
  >();
  const orphanLocations: BulkCompanyLocationLine[] = [];

  for (const item of parsed.items) {
    if (isCompanyLocation(item)) {
      // This is a CompanyLocation
      const parentId = item.__parentId;
      const existing = companies.get(parentId);
      if (existing) {
        existing.locations.push(item);
      } else {
        orphanLocations.push(item);
      }
    } else {
      // This is a Company
      const existing = companies.get(item.id);
      if (existing) {
        existing.company = item;
      } else {
        companies.set(item.id, { company: item, locations: [] });
      }
    }
  }

  // Try to attach orphan locations to companies added after them
  for (const location of orphanLocations) {
    const parent = companies.get(location.__parentId);
    if (parent) {
      parent.locations.push(location);
    }
  }

  const remainingOrphans = orphanLocations.filter(
    (loc) => !companies.has(loc.__parentId)
  );

  return {
    companies,
    orphanLocations: remainingOrphans,
    errors: parsed.errors,
  };
}

/**
 * Type guard to check if a bulk line is a CompanyLocation.
 */
function isCompanyLocation(
  item: BulkCompanyLine | BulkCompanyLocationLine
): item is BulkCompanyLocationLine {
  return "__parentId" in item && item.__parentId !== undefined;
}

/**
 * Parse order bulk JSONL.
 *
 * Returns all orders - eligibility is determined by the shared eligibility
 * function which considers paymentTerms (a), company account terms (b),
 * and tag rules (c).
 *
 * @param jsonl - Raw JSONL from bulk order query
 * @returns All parsed orders for eligibility check
 */
export function parseOrderBulkJsonl(jsonl: string): {
  orders: BulkOrderLine[];
  errors: ParsedBulkResult<unknown>["errors"];
} {
  const parsed = parseJsonl<BulkOrderLine>(jsonl);

  return {
    orders: parsed.items,
    errors: parsed.errors,
  };
}

/**
 * Convert bulk CompanyLocation line to full ShopifyCompanyLocation format.
 *
 * @param location - Bulk line data
 * @returns Full ShopifyCompanyLocation for sync processing
 */
export function bulkLocationToShopifyLocation(
  location: BulkCompanyLocationLine
): ShopifyCompanyLocation {
  return {
    id: location.id,
    name: location.name,
    company: {
      id: location.__parentId,
    },
    billingAddress: location.billingAddress,
    buyerExperienceConfiguration: location.buyerExperienceConfiguration,
  };
}

/**
 * Convert bulk Order line to full ShopifyOrder format.
 *
 * @param order - Bulk line data
 * @returns Full ShopifyOrder for sync processing
 */
export function bulkOrderToShopifyOrder(order: BulkOrderLine): ShopifyOrder {
  return {
    id: order.id,
    name: order.name,
    createdAt: order.createdAt,
    processedAt: order.processedAt,
    cancelledAt: order.cancelledAt,
    closedAt: order.closedAt,
    displayFinancialStatus: order.displayFinancialStatus,
    totalPriceSet: order.totalPriceSet,
    paymentTerms: order.paymentTerms,
    purchasingEntity: order.purchasingEntity,
    customer: order.customer,
  };
}

/**
 * Parse customer bulk JSONL (S8).
 *
 * Returns all customers with their tags for tag rule matching.
 * The sync processor filters to only those matching AccountSource tag rules.
 *
 * DPDP note: Only id and tags are present in the bulk export.
 *
 * @param jsonl - Raw JSONL from bulk customer query
 * @returns Parsed customers
 */
export function parseCustomerBulkJsonl(jsonl: string): {
  customers: BulkCustomerLine[];
  errors: ParsedBulkResult<unknown>["errors"];
} {
  const parsed = parseJsonl<BulkCustomerLine>(jsonl);

  return {
    customers: parsed.items,
    errors: parsed.errors,
  };
}

/**
 * Convert bulk Customer line to ShopifyCustomer format.
 *
 * @param customer - Bulk line data
 * @returns ShopifyCustomer for sync processing
 */
export function bulkCustomerToShopifyCustomer(customer: BulkCustomerLine): ShopifyCustomer {
  return {
    id: customer.id,
    tags: customer.tags ?? [],
  };
}
