import { describe, it, expect } from "vitest";
import {
  parseJsonl,
  parseCompanyBulkJsonl,
  parseOrderBulkJsonl,
  parseCustomerBulkJsonl,
  bulkLocationToShopifyLocation,
  bulkOrderToShopifyOrder,
  bulkCustomerToShopifyCustomer,
} from "../bulk-parser.server";
import type { BulkCompanyLocationLine, BulkOrderLine, BulkCustomerLine } from "../types";

describe("parseJsonl", () => {
  it("parses valid JSONL", () => {
    const jsonl = `{"id":"1","name":"Test"}
{"id":"2","name":"Test 2"}`;

    const result = parseJsonl<{ id: string; name: string }>(jsonl);

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toEqual({ id: "1", name: "Test" });
    expect(result.items[1]).toEqual({ id: "2", name: "Test 2" });
    expect(result.errors).toHaveLength(0);
    expect(result.totalLines).toBe(2);
  });

  it("handles empty JSONL", () => {
    const result = parseJsonl<unknown>("");

    expect(result.items).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.totalLines).toBe(0);
  });

  it("handles blank lines", () => {
    const jsonl = `{"id":"1"}

{"id":"2"}
`;

    const result = parseJsonl<{ id: string }>(jsonl);

    expect(result.items).toHaveLength(2);
    expect(result.totalLines).toBe(2);
  });

  it("captures parse errors with line numbers", () => {
    const jsonl = `{"id":"1"}
invalid json
{"id":"3"}`;

    const result = parseJsonl<{ id: string }>(jsonl);

    expect(result.items).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].line).toBe(2);
    expect(result.errors[0].raw).toBe("invalid json");
    expect(result.totalLines).toBe(3);
  });

  it("truncates long raw lines in errors", () => {
    const longLine = "x".repeat(300);
    const jsonl = `{"id":"1"}
${longLine}`;

    const result = parseJsonl<unknown>(jsonl);

    expect(result.errors[0].raw.length).toBe(200);
  });
});

describe("parseCompanyBulkJsonl", () => {
  it("groups locations under companies", () => {
    const jsonl = `{"id":"gid://shopify/Company/1","name":"Acme Corp"}
{"id":"gid://shopify/CompanyLocation/10","name":"HQ","__parentId":"gid://shopify/Company/1"}
{"id":"gid://shopify/CompanyLocation/11","name":"Branch","__parentId":"gid://shopify/Company/1"}`;

    const result = parseCompanyBulkJsonl(jsonl);

    expect(result.companies.size).toBe(1);
    const company = result.companies.get("gid://shopify/Company/1");
    expect(company?.company.name).toBe("Acme Corp");
    expect(company?.locations).toHaveLength(2);
    expect(company?.locations[0].name).toBe("HQ");
    expect(company?.locations[1].name).toBe("Branch");
    expect(result.orphanLocations).toHaveLength(0);
  });

  it("handles locations appearing before companies", () => {
    const jsonl = `{"id":"gid://shopify/CompanyLocation/10","name":"HQ","__parentId":"gid://shopify/Company/1"}
{"id":"gid://shopify/Company/1","name":"Acme Corp"}`;

    const result = parseCompanyBulkJsonl(jsonl);

    expect(result.companies.size).toBe(1);
    const company = result.companies.get("gid://shopify/Company/1");
    expect(company?.company.name).toBe("Acme Corp");
    expect(company?.locations).toHaveLength(1);
    expect(result.orphanLocations).toHaveLength(0);
  });

  it("tracks orphan locations without companies", () => {
    const jsonl = `{"id":"gid://shopify/CompanyLocation/10","name":"Orphan","__parentId":"gid://shopify/Company/999"}`;

    const result = parseCompanyBulkJsonl(jsonl);

    expect(result.companies.size).toBe(0);
    expect(result.orphanLocations).toHaveLength(1);
    expect(result.orphanLocations[0].name).toBe("Orphan");
  });

  it("handles multiple companies", () => {
    const jsonl = `{"id":"gid://shopify/Company/1","name":"Acme"}
{"id":"gid://shopify/Company/2","name":"Beta"}
{"id":"gid://shopify/CompanyLocation/10","name":"Acme HQ","__parentId":"gid://shopify/Company/1"}
{"id":"gid://shopify/CompanyLocation/20","name":"Beta HQ","__parentId":"gid://shopify/Company/2"}`;

    const result = parseCompanyBulkJsonl(jsonl);

    expect(result.companies.size).toBe(2);
    expect(result.companies.get("gid://shopify/Company/1")?.locations).toHaveLength(1);
    expect(result.companies.get("gid://shopify/Company/2")?.locations).toHaveLength(1);
  });
});

describe("parseOrderBulkJsonl", () => {
  it("filters orders with payment terms", () => {
    const jsonl = `{"id":"gid://shopify/Order/1","name":"#1001","createdAt":"2025-01-01T00:00:00Z","paymentTerms":{"id":"pt1","paymentTermsName":"Net 30"}}
{"id":"gid://shopify/Order/2","name":"#1002","createdAt":"2025-01-02T00:00:00Z"}
{"id":"gid://shopify/Order/3","name":"#1003","createdAt":"2025-01-03T00:00:00Z","paymentTerms":{"id":"pt2","paymentTermsName":"Net 60"}}`;

    const result = parseOrderBulkJsonl(jsonl);

    expect(result.orders).toHaveLength(2);
    expect(result.orders[0].name).toBe("#1001");
    expect(result.orders[1].name).toBe("#1003");
    expect(result.skippedNoTerms).toBe(1);
  });

  it("skips orders without payment terms", () => {
    const jsonl = `{"id":"gid://shopify/Order/1","name":"#1001","createdAt":"2025-01-01T00:00:00Z"}
{"id":"gid://shopify/Order/2","name":"#1002","createdAt":"2025-01-02T00:00:00Z"}`;

    const result = parseOrderBulkJsonl(jsonl);

    expect(result.orders).toHaveLength(0);
    expect(result.skippedNoTerms).toBe(2);
  });

  it("handles null payment terms", () => {
    const jsonl = `{"id":"gid://shopify/Order/1","name":"#1001","createdAt":"2025-01-01T00:00:00Z","paymentTerms":null}`;

    const result = parseOrderBulkJsonl(jsonl);

    expect(result.orders).toHaveLength(0);
    expect(result.skippedNoTerms).toBe(1);
  });
});

describe("bulkLocationToShopifyLocation", () => {
  it("converts bulk line to ShopifyCompanyLocation", () => {
    // Note: CompanyAddress.company was renamed to companyName in 2026-10
    const bulkLine: BulkCompanyLocationLine = {
      id: "gid://shopify/CompanyLocation/123",
      name: "Headquarters",
      __parentId: "gid://shopify/Company/456",
      billingAddress: {
        companyName: "Acme Corp",
      },
      buyerExperienceConfiguration: {
        paymentTermsTemplate: {
          id: "pt1",
          name: "Net 30",
          dueInDays: 30,
          paymentTermsType: "NET",
        },
      },
    };

    const result = bulkLocationToShopifyLocation(bulkLine);

    expect(result.id).toBe("gid://shopify/CompanyLocation/123");
    expect(result.name).toBe("Headquarters");
    expect(result.company.id).toBe("gid://shopify/Company/456");
    expect(result.billingAddress?.companyName).toBe("Acme Corp");
    expect(result.buyerExperienceConfiguration?.paymentTermsTemplate?.dueInDays).toBe(30);
  });
});

describe("bulkOrderToShopifyOrder", () => {
  it("converts bulk line to ShopifyOrder", () => {
    const bulkLine: BulkOrderLine = {
      id: "gid://shopify/Order/789",
      name: "#1001",
      createdAt: "2025-07-15T10:00:00Z",
      cancelledAt: null,
      displayFinancialStatus: "PENDING",
      totalPriceSet: {
        shopMoney: {
          amount: "10000.00",
          currencyCode: "INR",
        },
      },
      paymentTerms: {
        id: "pt1",
        paymentTermsName: "Net 30",
        paymentTermsType: "NET",
        dueInDays: 30,
      },
      purchasingEntity: {
        __typename: "PurchasingCompany",
        company: { id: "gid://shopify/Company/456" },
        location: { id: "gid://shopify/CompanyLocation/123" },
      },
    };

    const result = bulkOrderToShopifyOrder(bulkLine);

    expect(result.id).toBe("gid://shopify/Order/789");
    expect(result.name).toBe("#1001");
    expect(result.createdAt).toBe("2025-07-15T10:00:00Z");
    expect(result.paymentTerms?.dueInDays).toBe(30);
    expect(result.purchasingEntity?.company?.id).toBe("gid://shopify/Company/456");
    expect(result.totalPriceSet?.shopMoney.amount).toBe("10000.00");
  });
});

describe("parseCustomerBulkJsonl", () => {
  it("parses customer JSONL with tags", () => {
    const jsonl = `{"id":"gid://shopify/Customer/1","tags":["net-terms","wholesale"]}
{"id":"gid://shopify/Customer/2","tags":["retail"]}
{"id":"gid://shopify/Customer/3"}`;

    const result = parseCustomerBulkJsonl(jsonl);

    expect(result.customers).toHaveLength(3);
    expect(result.customers[0].id).toBe("gid://shopify/Customer/1");
    expect(result.customers[0].tags).toEqual(["net-terms", "wholesale"]);
    expect(result.customers[1].tags).toEqual(["retail"]);
    expect(result.customers[2].tags).toBeUndefined();
    expect(result.errors).toHaveLength(0);
  });

  it("handles empty JSONL", () => {
    const result = parseCustomerBulkJsonl("");

    expect(result.customers).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("captures parse errors", () => {
    const jsonl = `{"id":"gid://shopify/Customer/1","tags":["valid"]}
invalid json line
{"id":"gid://shopify/Customer/2"}`;

    const result = parseCustomerBulkJsonl(jsonl);

    expect(result.customers).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].line).toBe(2);
    expect(result.errors[0].raw).toBe("invalid json line");
  });

  it("handles customers with empty tags array", () => {
    const jsonl = `{"id":"gid://shopify/Customer/1","tags":[]}`;

    const result = parseCustomerBulkJsonl(jsonl);

    expect(result.customers).toHaveLength(1);
    expect(result.customers[0].tags).toEqual([]);
  });
});

describe("bulkCustomerToShopifyCustomer", () => {
  it("converts bulk line to ShopifyCustomer with tags", () => {
    const bulkLine: BulkCustomerLine = {
      id: "gid://shopify/Customer/123",
      tags: ["net-terms", "gold-tier"],
    };

    const result = bulkCustomerToShopifyCustomer(bulkLine);

    expect(result.id).toBe("gid://shopify/Customer/123");
    expect(result.tags).toEqual(["net-terms", "gold-tier"]);
  });

  it("handles missing tags", () => {
    const bulkLine: BulkCustomerLine = {
      id: "gid://shopify/Customer/456",
    };

    const result = bulkCustomerToShopifyCustomer(bulkLine);

    expect(result.id).toBe("gid://shopify/Customer/456");
    expect(result.tags).toEqual([]);
  });

  it("handles null-ish tags", () => {
    const bulkLine: BulkCustomerLine = {
      id: "gid://shopify/Customer/789",
      tags: undefined,
    };

    const result = bulkCustomerToShopifyCustomer(bulkLine);

    expect(result.tags).toEqual([]);
  });
});
