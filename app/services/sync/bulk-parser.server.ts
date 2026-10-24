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
  BulkPaymentScheduleLine,
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
 * Type guard for PaymentSchedule child lines.
 * PaymentSchedule lines have __parentId pointing to an Order AND
 * an id starting with 'gid://shopify/PaymentSchedule/'.
 * This distinguishes PaymentSchedule from other potential child line types.
 */
function isPaymentScheduleLine(
  item: BulkOrderLine | BulkPaymentScheduleLine
): item is BulkPaymentScheduleLine {
  return (
    "__parentId" in item &&
    item.__parentId !== undefined &&
    typeof item.id === "string" &&
    item.id.startsWith("gid://shopify/PaymentSchedule/")
  );
}

/**
 * Parse order bulk JSONL with child line grouping.
 *
 * Shopify bulk exports write CONNECTION nodes (like paymentSchedules) as
 * separate JSONL lines with __parentId pointing to the parent Order.
 * This function groups PaymentSchedule children to their parent Order
 * and attaches the schedule's dueAt to the parent's paymentTerms.
 *
 * Orphan schedules (whose parent Order is not in this batch) are returned
 * separately so the processor can update existing Invoices with dueAt.
 *
 * @param jsonl - Raw JSONL from bulk order query
 * @returns Orders with attached schedules, orphan schedules, counts, and errors
 */
export function parseOrderBulkJsonl(jsonl: string): {
  orders: BulkOrderLine[];
  orphanSchedules: BulkPaymentScheduleLine[];
  attachedChildCount: number;
  orphanChildCount: number;
  errors: ParsedBulkResult<unknown>["errors"];
} {
  const parsed = parseJsonl<BulkOrderLine | BulkPaymentScheduleLine>(jsonl);

  const orders: BulkOrderLine[] = [];
  const ordersById = new Map<string, BulkOrderLine>();
  const pendingOrphanSchedules: BulkPaymentScheduleLine[] = [];
  let attachedChildCount = 0;

  for (const item of parsed.items) {
    if (isPaymentScheduleLine(item)) {
      const parentId = item.__parentId;
      const parent = ordersById.get(parentId);
      if (parent) {
        attachScheduleToOrder(parent, item);
        attachedChildCount++;
      } else {
        pendingOrphanSchedules.push(item);
      }
    } else {
      orders.push(item);
      ordersById.set(item.id, item);
    }
  }

  // Try to attach pending orphan schedules to orders added after them
  // (Shopify typically puts children after parents, but be safe)
  const remainingOrphans: BulkPaymentScheduleLine[] = [];
  for (const schedule of pendingOrphanSchedules) {
    const parent = ordersById.get(schedule.__parentId);
    if (parent) {
      attachScheduleToOrder(parent, schedule);
      attachedChildCount++;
    } else {
      remainingOrphans.push(schedule);
    }
  }

  return {
    orders,
    orphanSchedules: remainingOrphans,
    attachedChildCount,
    orphanChildCount: remainingOrphans.length,
    errors: parsed.errors,
  };
}

/**
 * Attach a PaymentSchedule to its parent Order.
 * Modifies the parent order's paymentTerms.paymentSchedules in place.
 */
function attachScheduleToOrder(
  order: BulkOrderLine,
  schedule: BulkPaymentScheduleLine
): void {
  if (!order.paymentTerms) {
    return;
  }

  if (!order.paymentTerms.paymentSchedules) {
    order.paymentTerms.paymentSchedules = { edges: [] };
  }

  order.paymentTerms.paymentSchedules.edges.push({
    node: {
      id: schedule.id,
      dueAt: schedule.dueAt,
      issuedAt: schedule.issuedAt,
      completedAt: schedule.completedAt,
      amount: schedule.amount,
    },
  });
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
    totalOutstandingSet: order.totalOutstandingSet,
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
