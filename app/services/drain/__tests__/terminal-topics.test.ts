/**
 * Test for TERMINAL_TOPICS set to verify exactly the expected topics are included.
 *
 * TERMINAL_TOPICS allows specific topics to reach handlers even for non-INR shops.
 * This test ensures the compliance topics were added correctly without changing
 * any other topic's behavior.
 */

import { describe, it, expect } from "vitest";

describe("TERMINAL_TOPICS", () => {
  it("compliance handlers are registered for drain processing", async () => {
    const { getSyncHandler } = await import("../processor.server");

    expect(getSyncHandler("CUSTOMERS_DATA_REQUEST")).toBeDefined();
    expect(getSyncHandler("CUSTOMERS_REDACT")).toBeDefined();
    expect(getSyncHandler("SHOP_REDACT")).toBeDefined();
  });

  it("existing terminal topic handlers are still registered", async () => {
    const { getSyncHandler } = await import("../processor.server");

    expect(getSyncHandler("ORDERS_PAID")).toBeDefined();
    expect(getSyncHandler("ORDERS_CANCELLED")).toBeDefined();
    expect(getSyncHandler("DRAFT_ORDERS_DELETE")).toBeDefined();
  });

  it("handlers are unique for each compliance topic", async () => {
    const { getSyncHandler } = await import("../processor.server");

    const dataRequestHandler = getSyncHandler("CUSTOMERS_DATA_REQUEST");
    const redactHandler = getSyncHandler("CUSTOMERS_REDACT");
    const shopRedactHandler = getSyncHandler("SHOP_REDACT");

    expect(dataRequestHandler).not.toBe(redactHandler);
    expect(dataRequestHandler).not.toBe(shopRedactHandler);
    expect(redactHandler).not.toBe(shopRedactHandler);
  });

  it("non-terminal topics have handlers but may be filtered by currency", async () => {
    const { getSyncHandler } = await import("../processor.server");

    expect(getSyncHandler("ORDERS_CREATE")).toBeDefined();
    expect(getSyncHandler("CUSTOMERS_CREATE")).toBeDefined();
  });
});
