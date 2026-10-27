import { describe, it, expect } from "vitest";
import {
  parseJsonl,
  parseCompanyBulkJsonl,
  parseOrderBulkJsonl,
  parseCustomerBulkJsonl,
  parseDraftOrderBulkJsonl,
  bulkLocationToShopifyLocation,
  bulkOrderToShopifyOrder,
  bulkCustomerToShopifyCustomer,
  bulkDraftOrderToShopifyDraftOrder,
} from "../bulk-parser.server";
import type { BulkCompanyLocationLine, BulkOrderLine, BulkCustomerLine, BulkDraftOrderLine } from "../types";

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
  it("parses all orders without filtering by paymentTerms", () => {
    const jsonl = `{"id":"gid://shopify/Order/1","name":"#1001","createdAt":"2025-01-01T00:00:00Z","paymentTerms":{"id":"pt1","paymentTermsName":"Net 30"}}
{"id":"gid://shopify/Order/2","name":"#1002","createdAt":"2025-01-02T00:00:00Z"}
{"id":"gid://shopify/Order/3","name":"#1003","createdAt":"2025-01-03T00:00:00Z","paymentTerms":{"id":"pt2","paymentTermsName":"Net 60"}}`;

    const result = parseOrderBulkJsonl(jsonl);

    // All orders returned - eligibility filtering happens via checkOrderEligibility
    expect(result.orders).toHaveLength(3);
    expect(result.orders[0].name).toBe("#1001");
    expect(result.orders[1].name).toBe("#1002");
    expect(result.orders[2].name).toBe("#1003");
    expect(result.attachedChildCount).toBe(0);
    expect(result.orphanChildCount).toBe(0);
    expect(result.orphanSchedules).toHaveLength(0);
  });

  it("returns orders without payment terms for eligibility check", () => {
    const jsonl = `{"id":"gid://shopify/Order/1","name":"#1001","createdAt":"2025-01-01T00:00:00Z"}
{"id":"gid://shopify/Order/2","name":"#1002","createdAt":"2025-01-02T00:00:00Z"}`;

    const result = parseOrderBulkJsonl(jsonl);

    // Orders without paymentTerms are returned - eligibility rules (b) and (c) may apply
    expect(result.orders).toHaveLength(2);
    expect(result.orders[0].paymentTerms).toBeUndefined();
    expect(result.orders[1].paymentTerms).toBeUndefined();
    expect(result.attachedChildCount).toBe(0);
  });

  it("handles null payment terms", () => {
    const jsonl = `{"id":"gid://shopify/Order/1","name":"#1001","createdAt":"2025-01-01T00:00:00Z","paymentTerms":null}`;

    const result = parseOrderBulkJsonl(jsonl);

    // Orders with null paymentTerms are returned for eligibility check
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0].paymentTerms).toBeNull();
    expect(result.attachedChildCount).toBe(0);
  });

  describe("PaymentSchedule child line handling (bug fix)", () => {
    it("attaches PaymentSchedule dueAt to parent order", () => {
      // Shopify bulk exports write CONNECTION nodes as separate JSONL lines
      // with __parentId pointing to the parent Order
      const jsonl = `{"id":"gid://shopify/Order/123","name":"#1001","createdAt":"2025-01-01T00:00:00Z","displayFinancialStatus":"PENDING","paymentTerms":{"id":"pt1","paymentTermsName":"Net 30","paymentTermsType":"NET","dueInDays":30}}
{"id":"gid://shopify/PaymentSchedule/456","dueAt":"2025-01-31T00:00:00Z","issuedAt":"2025-01-01T00:00:00Z","amount":{"amount":"1000.00","currencyCode":"USD"},"__parentId":"gid://shopify/Order/123"}`;

      const result = parseOrderBulkJsonl(jsonl);

      // Should have 1 order, not 2
      expect(result.orders).toHaveLength(1);
      expect(result.orders[0].name).toBe("#1001");

      // PaymentSchedule should be attached to order's paymentTerms
      const schedules = result.orders[0].paymentTerms?.paymentSchedules?.edges;
      expect(schedules).toHaveLength(1);
      expect(schedules?.[0].node.id).toBe("gid://shopify/PaymentSchedule/456");
      expect(schedules?.[0].node.dueAt).toBe("2025-01-31T00:00:00Z");
      expect(schedules?.[0].node.issuedAt).toBe("2025-01-01T00:00:00Z");
      expect(schedules?.[0].node.amount?.amount).toBe("1000.00");

      // Child lines counted separately
      expect(result.attachedChildCount).toBe(1);
      expect(result.orphanChildCount).toBe(0);
    });

    it("does not count child lines as orders", () => {
      const jsonl = `{"id":"gid://shopify/Order/1","name":"#1001","createdAt":"2025-01-01T00:00:00Z","paymentTerms":{"id":"pt1","paymentTermsName":"Net 30"}}
{"id":"gid://shopify/PaymentSchedule/10","dueAt":"2025-01-31T00:00:00Z","__parentId":"gid://shopify/Order/1"}
{"id":"gid://shopify/Order/2","name":"#1002","createdAt":"2025-01-02T00:00:00Z","paymentTerms":{"id":"pt2","paymentTermsName":"Net 60"}}
{"id":"gid://shopify/PaymentSchedule/20","dueAt":"2025-03-02T00:00:00Z","__parentId":"gid://shopify/Order/2"}`;

      const result = parseOrderBulkJsonl(jsonl);

      // Should have 2 orders, not 4
      expect(result.orders).toHaveLength(2);
      expect(result.attachedChildCount).toBe(2);

      // Each order should have its schedule attached
      expect(result.orders[0].paymentTerms?.paymentSchedules?.edges).toHaveLength(1);
      expect(result.orders[1].paymentTerms?.paymentSchedules?.edges).toHaveLength(1);
    });

    it("handles order without PaymentSchedule children", () => {
      const jsonl = `{"id":"gid://shopify/Order/1","name":"#1001","createdAt":"2025-01-01T00:00:00Z","displayFinancialStatus":"PENDING","paymentTerms":{"id":"pt1","paymentTermsName":"Net 30"}}`;

      const result = parseOrderBulkJsonl(jsonl);

      expect(result.orders).toHaveLength(1);
      expect(result.attachedChildCount).toBe(0);
      // No schedules added
      expect(result.orders[0].paymentTerms?.paymentSchedules).toBeUndefined();
    });

    it("handles PaymentSchedule appearing before its parent order (streaming robustness)", () => {
      // Though Shopify typically puts children after parents, we handle reverse order
      const jsonl = `{"id":"gid://shopify/PaymentSchedule/456","dueAt":"2025-01-31T00:00:00Z","__parentId":"gid://shopify/Order/123"}
{"id":"gid://shopify/Order/123","name":"#1001","createdAt":"2025-01-01T00:00:00Z","paymentTerms":{"id":"pt1","paymentTermsName":"Net 30"}}`;

      const result = parseOrderBulkJsonl(jsonl);

      expect(result.orders).toHaveLength(1);
      expect(result.attachedChildCount).toBe(1);
      // Schedule should still be attached (via orphan re-attachment pass)
      expect(result.orders[0].paymentTerms?.paymentSchedules?.edges).toHaveLength(1);
      expect(result.orders[0].paymentTerms?.paymentSchedules?.edges?.[0].node.dueAt).toBe("2025-01-31T00:00:00Z");
    });

    it("returns orphan PaymentSchedule without matching parent", () => {
      const jsonl = `{"id":"gid://shopify/Order/1","name":"#1001","createdAt":"2025-01-01T00:00:00Z","paymentTerms":{"id":"pt1","paymentTermsName":"Net 30"}}
{"id":"gid://shopify/PaymentSchedule/orphan","dueAt":"2025-01-31T00:00:00Z","__parentId":"gid://shopify/Order/999"}`;

      const result = parseOrderBulkJsonl(jsonl);

      // Orphan schedule returned separately for processor to update existing invoices
      expect(result.orders).toHaveLength(1);
      expect(result.attachedChildCount).toBe(0);
      expect(result.orphanChildCount).toBe(1);
      expect(result.orphanSchedules).toHaveLength(1);
      expect(result.orphanSchedules[0].__parentId).toBe("gid://shopify/Order/999");
      expect(result.orphanSchedules[0].dueAt).toBe("2025-01-31T00:00:00Z");
      expect(result.orders[0].paymentTerms?.paymentSchedules).toBeUndefined();
    });

    it("does not attach schedule to order without paymentTerms", () => {
      const jsonl = `{"id":"gid://shopify/Order/1","name":"#1001","createdAt":"2025-01-01T00:00:00Z"}
{"id":"gid://shopify/PaymentSchedule/456","dueAt":"2025-01-31T00:00:00Z","__parentId":"gid://shopify/Order/1"}`;

      const result = parseOrderBulkJsonl(jsonl);

      expect(result.orders).toHaveLength(1);
      expect(result.attachedChildCount).toBe(1);
      // Schedule is attached even if order has no paymentTerms initially
      // (The attachScheduleToOrder function does nothing if paymentTerms is missing)
      expect(result.orders[0].paymentTerms).toBeUndefined();
    });
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

describe("parseDraftOrderBulkJsonl", () => {
  it("parses draft order JSONL with payment terms", () => {
    const jsonl = `{"id":"gid://shopify/DraftOrder/1","name":"#D1","status":"open","createdAt":"2026-10-25T10:00:00Z","paymentTerms":{"id":"gid://shopify/PaymentTerms/1","paymentTermsName":"Net 30","paymentTermsType":"NET","dueInDays":30}}
{"id":"gid://shopify/DraftOrder/2","name":"#D2","status":"invoice_sent","createdAt":"2026-10-25T11:00:00Z"}`;

    const result = parseDraftOrderBulkJsonl(jsonl);

    expect(result.draftOrders).toHaveLength(2);
    expect(result.draftOrders[0].id).toBe("gid://shopify/DraftOrder/1");
    expect(result.draftOrders[0].name).toBe("#D1");
    expect(result.draftOrders[0].status).toBe("open");
    expect(result.draftOrders[0].paymentTerms?.dueInDays).toBe(30);
    expect(result.draftOrders[1].id).toBe("gid://shopify/DraftOrder/2");
    expect(result.draftOrders[1].status).toBe("invoice_sent");
    expect(result.errors).toHaveLength(0);
  });

  it("handles empty JSONL", () => {
    const result = parseDraftOrderBulkJsonl("");

    expect(result.draftOrders).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("captures parse errors", () => {
    const jsonl = `{"id":"gid://shopify/DraftOrder/1","name":"#D1","status":"open","createdAt":"2026-10-25T10:00:00Z"}
invalid json line
{"id":"gid://shopify/DraftOrder/2","name":"#D2","status":"open","createdAt":"2026-10-25T11:00:00Z"}`;

    const result = parseDraftOrderBulkJsonl(jsonl);

    expect(result.draftOrders).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].line).toBe(2);
    expect(result.errors[0].raw).toBe("invalid json line");
  });

  it("handles draft orders with purchasing entity", () => {
    const jsonl = `{"id":"gid://shopify/DraftOrder/1","name":"#D1","status":"open","createdAt":"2026-10-25T10:00:00Z","purchasingEntity":{"company":{"id":"gid://shopify/Company/123"},"location":{"id":"gid://shopify/CompanyLocation/456"}}}`;

    const result = parseDraftOrderBulkJsonl(jsonl);

    expect(result.draftOrders).toHaveLength(1);
    expect(result.draftOrders[0].purchasingEntity?.company?.id).toBe("gid://shopify/Company/123");
    expect(result.draftOrders[0].purchasingEntity?.location?.id).toBe("gid://shopify/CompanyLocation/456");
  });
});

describe("bulkDraftOrderToShopifyDraftOrder", () => {
  it("converts bulk line to ShopifyDraftOrder with all fields", () => {
    const bulkLine: BulkDraftOrderLine = {
      id: "gid://shopify/DraftOrder/123",
      name: "#D123",
      createdAt: "2026-10-25T10:00:00Z",
      updatedAt: "2026-10-25T12:00:00Z",
      status: "open",
      totalPriceSet: {
        shopMoney: {
          amount: "500.00",
          currencyCode: "USD",
        },
      },
      paymentTerms: {
        id: "gid://shopify/PaymentTerms/1",
        paymentTermsName: "Net 30",
        paymentTermsType: "NET",
        dueInDays: 30,
      },
      purchasingEntity: {
        company: { id: "gid://shopify/Company/456" },
        location: { id: "gid://shopify/CompanyLocation/789" },
      },
      customer: { id: "gid://shopify/Customer/111" },
    };

    const result = bulkDraftOrderToShopifyDraftOrder(bulkLine);

    expect(result.id).toBe("gid://shopify/DraftOrder/123");
    expect(result.name).toBe("#D123");
    expect(result.createdAt).toBe("2026-10-25T10:00:00Z");
    expect(result.updatedAt).toBe("2026-10-25T12:00:00Z");
    expect(result.status).toBe("open");
    expect(result.totalPriceSet?.shopMoney.amount).toBe("500.00");
    expect(result.paymentTerms?.dueInDays).toBe(30);
    expect(result.purchasingEntity?.company?.id).toBe("gid://shopify/Company/456");
    expect(result.customer?.id).toBe("gid://shopify/Customer/111");
  });

  it("handles minimal draft order", () => {
    const bulkLine: BulkDraftOrderLine = {
      id: "gid://shopify/DraftOrder/456",
      name: "#D456",
      createdAt: "2026-10-25T10:00:00Z",
    };

    const result = bulkDraftOrderToShopifyDraftOrder(bulkLine);

    expect(result.id).toBe("gid://shopify/DraftOrder/456");
    expect(result.name).toBe("#D456");
    expect(result.paymentTerms).toBeUndefined();
    expect(result.purchasingEntity).toBeUndefined();
    expect(result.customer).toBeUndefined();
  });
});
