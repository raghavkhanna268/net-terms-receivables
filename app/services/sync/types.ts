/**
 * Type definitions for Shopify webhook payloads and bulk JSONL data.
 *
 * These types represent the minimal fields we extract from Shopify payloads
 * for syncing to our BuyerAccount and Invoice tables.
 */

/**
 * Shopify Company from webhook or bulk export.
 */
export interface ShopifyCompany {
  id: string; // GID: gid://shopify/Company/123
  name: string;
  externalId?: string | null;
  note?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Shopify CompanyLocation from webhook or bulk export.
 */
export interface ShopifyCompanyLocation {
  id: string; // GID: gid://shopify/CompanyLocation/456
  name: string;
  company: {
    id: string; // Parent company GID
  };
  billingAddress?: {
    firstName?: string | null;
    lastName?: string | null;
    company?: string | null;
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    province?: string | null;
    provinceCode?: string | null;
    country?: string | null;
    countryCode?: string | null;
    zip?: string | null;
    phone?: string | null;
  } | null;
  buyerExperienceConfiguration?: {
    paymentTermsTemplate?: {
      id: string;
      name: string;
      dueInDays: number;
      paymentTermsType: string;
    } | null;
  } | null;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Shopify Order from webhook or bulk export.
 * Only orders with paymentTerms are relevant for net-terms tracking.
 */
export interface ShopifyOrder {
  id: string; // GID: gid://shopify/Order/789
  name: string; // Display name, e.g., "#1001"
  createdAt: string;
  updatedAt?: string;
  cancelledAt?: string | null;
  closedAt?: string | null;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  totalPriceSet?: {
    shopMoney: {
      amount: string;
      currencyCode: string;
    };
  };
  currentSubtotalPriceSet?: {
    shopMoney: {
      amount: string;
      currencyCode: string;
    };
  };
  paymentTerms?: {
    id: string;
    paymentTermsName: string;
    paymentTermsType: string;
    dueInDays?: number | null;
    paymentSchedules?: {
      edges: Array<{
        node: {
          id: string;
          dueAt?: string | null;
          issuedAt?: string | null;
          completedAt?: string | null;
          amount: {
            shopMoney: {
              amount: string;
              currencyCode: string;
            };
          };
        };
      }>;
    };
  } | null;
  purchasingEntity?: {
    __typename: string;
    // For PurchasingCompany
    company?: {
      id: string;
    };
    location?: {
      id: string;
    };
    // For Customer
    id?: string;
  } | null;
  customer?: {
    id: string;
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    tags?: string[];
  } | null;
}

/**
 * Result of processing a sync message.
 */
export interface SyncResult {
  /** Whether the sync was successful */
  success: boolean;
  /** Action taken: created, updated, deleted, skipped */
  action: "created" | "updated" | "deleted" | "skipped";
  /** ID of the affected BuyerAccount or Invoice */
  entityId?: string;
  /** Reason for skipping (if action is skipped) */
  skipReason?: string;
  /** Error message if success is false */
  error?: string;
}

/**
 * Bulk JSONL line for company export.
 */
export interface BulkCompanyLine {
  id: string;
  name: string;
  externalId?: string | null;
  note?: string | null;
  __parentId?: string; // For nested locations
}

/**
 * Bulk JSONL line for company location export.
 */
export interface BulkCompanyLocationLine {
  id: string;
  name: string;
  __parentId: string; // Company GID
  billingAddress?: ShopifyCompanyLocation["billingAddress"];
  buyerExperienceConfiguration?: ShopifyCompanyLocation["buyerExperienceConfiguration"];
}

/**
 * Bulk JSONL line for order export.
 */
export interface BulkOrderLine {
  id: string;
  name: string;
  createdAt: string;
  cancelledAt?: string | null;
  closedAt?: string | null;
  displayFinancialStatus?: string | null;
  totalPriceSet?: ShopifyOrder["totalPriceSet"];
  paymentTerms?: ShopifyOrder["paymentTerms"];
  purchasingEntity?: ShopifyOrder["purchasingEntity"];
  customer?: ShopifyOrder["customer"];
}

/**
 * Parsed bulk JSONL result.
 */
export interface ParsedBulkResult<T> {
  /** Successfully parsed lines */
  items: T[];
  /** Lines that failed to parse */
  errors: Array<{ line: number; error: string; raw: string }>;
  /** Total lines processed */
  totalLines: number;
}
