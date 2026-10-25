/**
 * Type definitions for Shopify webhook payloads and bulk JSONL data.
 *
 * These types represent the minimal fields we extract from Shopify payloads
 * for syncing to our BuyerAccount and Invoice tables.
 *
 * DPDP compliance notes:
 * - ShopifyCustomer: Only id and tags are stored; no names, emails, phones, addresses
 * - ShopifyDraftOrder: Only order metadata; no customer PII
 */

/**
 * Shopify Customer from webhook or bulk export.
 *
 * DPDP compliance (Level 1 + Name + Email, confirmed 2026-10-23):
 * - Always fetched: id, tags
 * - Optional PII (CUSTOMER_PII_FIELDS=1): email, displayName
 * - NEVER fetched: phone, addresses, firstName, lastName, defaultAddress
 */
export interface ShopifyCustomer {
  id: string; // GID: gid://shopify/Customer/123
  tags?: string[]; // Array of customer tags
  email?: string | null; // Optional: requires CUSTOMER_PII_FIELDS=1
  displayName?: string | null; // Optional: requires CUSTOMER_PII_FIELDS=1
}

/**
 * Shopify DraftOrder from webhook or bulk export.
 *
 * Tracked when payment terms are present for pending credit exposure.
 */
export interface ShopifyDraftOrder {
  id: string; // GID: gid://shopify/DraftOrder/123
  name: string; // Display name, e.g., "#D1"
  createdAt: string;
  updatedAt?: string;
  status?: string; // "open", "invoice_sent", "completed"
  totalPriceSet?: {
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
  } | null;
  purchasingEntity?: {
    __typename: string;
    company?: { id: string };
    location?: { id: string };
    id?: string; // For Customer
  } | null;
  customer?: {
    id: string;
  } | null;
}

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
 *
 * DPDP note: billingAddress only includes companyName (name fallback).
 * No PII fields (names, addresses, phones) are stored.
 *
 * Note: CompanyAddress.company was renamed to companyName in 2026-10.
 */
export interface ShopifyCompanyLocation {
  id: string; // GID: gid://shopify/CompanyLocation/456
  name: string;
  company: {
    id: string; // Parent company GID
  };
  billingAddress?: {
    companyName?: string | null;
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
  /** The date the order was processed (for backdated orders via orderCreate processedAt) */
  processedAt?: string | null;
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
  /** Total outstanding amount not yet transacted (from Shopify totalOutstandingSet) */
  totalOutstandingSet?: {
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
          amount?: {
            amount: string;
            currencyCode: string;
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
    /** Customer tags for tag-rule eligibility (not PII) */
    tags?: string[];
  } | null;
}

/**
 * Result of processing a sync message.
 */
export interface SyncResult {
  /** Whether the sync was successful */
  success: boolean;
  /** Action taken: created, updated, deleted, skipped, gated (S21: over-limit) */
  action: "created" | "updated" | "deleted" | "skipped" | "gated";
  /** ID of the affected BuyerAccount or Invoice */
  entityId?: string;
  /** Reason for skipping (if action is skipped) */
  skipReason?: string;
  /** Error message if success is false (internal use only, not exposed externally) */
  error?: string;
  /** Error code for safe logging/response (no PII) */
  errorCode?: string;
  /**
   * Whether the error is retryable (for failed results).
   * false = schema/validation/auth error → DLQ immediately
   * true = transient error (5xx, timeout) → retry with read_ct
   * undefined = legacy handler, use read_ct fallback
   */
  retryable?: boolean;
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
  /** The date the order was processed (for backdated orders via orderCreate processedAt) */
  processedAt?: string | null;
  cancelledAt?: string | null;
  closedAt?: string | null;
  displayFinancialStatus?: string | null;
  totalPriceSet?: ShopifyOrder["totalPriceSet"];
  totalOutstandingSet?: ShopifyOrder["totalOutstandingSet"];
  paymentTerms?: ShopifyOrder["paymentTerms"];
  purchasingEntity?: ShopifyOrder["purchasingEntity"];
  customer?: ShopifyOrder["customer"];
}

/**
 * Bulk JSONL line for PaymentSchedule (child of Order).
 *
 * Shopify bulk exports write CONNECTION nodes (like paymentSchedules) as
 * separate JSONL lines with __parentId pointing to the parent Order.
 */
export interface BulkPaymentScheduleLine {
  id: string;
  __parentId: string; // Order GID
  dueAt?: string | null;
  issuedAt?: string | null;
  completedAt?: string | null;
  amount?: {
    amount: string;
    currencyCode: string;
  };
}

/**
 * Bulk JSONL line for customer export (S8).
 *
 * DPDP compliance (Level 1 + Name + Email, confirmed 2026-10-23):
 * - Always fetched: id, tags
 * - Optional PII (CUSTOMER_PII_FIELDS=1): email, displayName
 * - NEVER fetched: phone, addresses, firstName, lastName, defaultAddress
 */
export interface BulkCustomerLine {
  id: string;
  tags?: string[];
  email?: string | null; // Optional: requires CUSTOMER_PII_FIELDS=1
  displayName?: string | null; // Optional: requires CUSTOMER_PII_FIELDS=1
}

/**
 * Bulk JSONL line for draft order export (S8 PR-B).
 *
 * Tracked when payment terms are present for pending credit exposure.
 * Only draft orders with status=open or status=invoice_sent are exported.
 *
 * Note: Bulk JSONL does not include __typename like webhook payloads.
 */
export interface BulkDraftOrderLine {
  id: string;
  name: string;
  createdAt: string;
  updatedAt?: string;
  status?: string;
  totalPriceSet?: {
    shopMoney: {
      amount: string;
      currencyCode: string;
    };
  };
  paymentTerms?: ShopifyDraftOrder["paymentTerms"];
  purchasingEntity?: {
    company?: { id: string };
    location?: { id: string };
  } | null;
  customer?: { id: string } | null;
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
