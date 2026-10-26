import { describe, it, expect } from "vitest";
import { enqueueCreditStatusRecompute } from "../credit-status-recompute.server";

/**
 * Unit test verifying enqueueCreditStatusRecompute uses the transaction client (tx)
 * for both FOR SHARE and pgmq.send, never the root sql client.
 *
 * This is critical for #239: if pgmq.send uses root sql instead of tx, the message
 * would be visible outside the transaction before commit, breaking the guard.
 */
describe("enqueueCreditStatusRecompute tx handle", () => {
  it("FOR SHARE and pgmq.send both go through tx, root sql never called inside begin", async () => {
    let insideBegin = false;
    const txCalls: string[] = [];

    const mockTx = Object.assign(
      async (strings: TemplateStringsArray, ..._values: unknown[]) => {
        const query = strings.join("?");
        txCalls.push(query);
        if (query.includes('FROM "Shop"') && query.includes("FOR SHARE")) {
          return [{ id: "shop-123" }];
        }
        if (query.includes("pgmq.send")) {
          return [{ send: 1 }];
        }
        return [];
      },
      {
        json: (obj: unknown) => JSON.stringify(obj),
      },
    );

    const mockSql = Object.assign(
      async (_strings: TemplateStringsArray, ..._values: unknown[]) => {
        if (insideBegin) {
          throw new Error("Root sql called inside begin - should use tx!");
        }
        return [];
      },
      {
        begin: async <T>(cb: (tx: typeof mockTx) => Promise<T>): Promise<T> => {
          insideBegin = true;
          try {
            return await cb(mockTx);
          } finally {
            insideBegin = false;
          }
        },
        json: (obj: unknown) => JSON.stringify(obj),
      },
    );

    const result = await enqueueCreditStatusRecompute(
      mockSql as never,
      "test.myshopify.com",
      "buyer-123",
      "invoice_change",
    );

    expect(result).toBe(true);
    expect(txCalls.length).toBe(2);
    expect(txCalls[0]).toContain("FOR SHARE");
    expect(txCalls[1]).toContain("pgmq.send");
  });

  it("returns false when shop not found (no pgmq.send)", async () => {
    const txCalls: string[] = [];

    const mockTx = Object.assign(
      async (strings: TemplateStringsArray, ..._values: unknown[]) => {
        const query = strings.join("?");
        txCalls.push(query);
        if (query.includes('FROM "Shop"')) {
          return [];
        }
        return [];
      },
      {
        json: (obj: unknown) => JSON.stringify(obj),
      },
    );

    const mockSql = Object.assign(
      async () => [],
      {
        begin: async <T>(cb: (tx: typeof mockTx) => Promise<T>): Promise<T> => {
          return await cb(mockTx);
        },
        json: (obj: unknown) => JSON.stringify(obj),
      },
    );

    const result = await enqueueCreditStatusRecompute(
      mockSql as never,
      "missing.myshopify.com",
      "buyer-123",
      "invoice_change",
    );

    expect(result).toBe(false);
    expect(txCalls.length).toBe(1);
    expect(txCalls[0]).toContain("FOR SHARE");
  });
});
