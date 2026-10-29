import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Settings } from "luxon";

describe("formatDate (locale pinning)", () => {
  let originalDefaultLocale: string;

  beforeEach(() => {
    originalDefaultLocale = Settings.defaultLocale;
  });

  afterEach(() => {
    Settings.defaultLocale = originalDefaultLocale;
  });

  it("renders 2026-10-27T03:00:00.000Z as 'October 26, 2026' for America/New_York", async () => {
    const { formatDate } = await import("../reminders.server");
    const date = new Date("2026-10-27T03:00:00.000Z");
    expect(formatDate(date, "America/New_York")).toBe("October 26, 2026");
  });

  it("renders 2026-10-27T03:00:00.000Z as 'October 27, 2026' for Asia/Kolkata", async () => {
    const { formatDate } = await import("../reminders.server");
    const date = new Date("2026-10-27T03:00:00.000Z");
    expect(formatDate(date, "Asia/Kolkata")).toBe("October 27, 2026");
  });

  it("renders 2026-10-27T16:00:00.000Z as 'October 27, 2026' for America/New_York", async () => {
    const { formatDate } = await import("../reminders.server");
    const date = new Date("2026-10-27T16:00:00.000Z");
    expect(formatDate(date, "America/New_York")).toBe("October 27, 2026");
  });

  it("output is identical when defaultLocale is en-IN", async () => {
    Settings.defaultLocale = "en-IN";
    const { formatDate } = await import("../reminders.server");

    const date = new Date("2026-10-27T03:00:00.000Z");
    expect(formatDate(date, "America/New_York")).toBe("October 26, 2026");
    expect(formatDate(date, "Asia/Kolkata")).toBe("October 27, 2026");
  });

  it("output is identical when defaultLocale is en-GB", async () => {
    Settings.defaultLocale = "en-GB";
    const { formatDate } = await import("../reminders.server");

    const date = new Date("2026-10-27T03:00:00.000Z");
    expect(formatDate(date, "America/New_York")).toBe("October 26, 2026");
    expect(formatDate(date, "Asia/Kolkata")).toBe("October 27, 2026");
  });
});
