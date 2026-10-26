import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

describe("wrangler.jsonc config", () => {
  it("APP_HANDLE equals 'net-terms-receivables-1'", () => {
    const wranglerPath = join(process.cwd(), "wrangler.jsonc");
    const content = readFileSync(wranglerPath, "utf-8");

    const match = content.match(/"APP_HANDLE":\s*"([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("net-terms-receivables-1");
  });

  it("RESEND_FROM equals 'reminders@mail.termwiseapp.com'", () => {
    const wranglerPath = join(process.cwd(), "wrangler.jsonc");
    const content = readFileSync(wranglerPath, "utf-8");

    const match = content.match(/"RESEND_FROM":\s*"([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("reminders@mail.termwiseapp.com");
  });
});
