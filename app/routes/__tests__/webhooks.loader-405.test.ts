/**
 * Tests for webhook route GET 405 responses.
 *
 * F12: All webhook resource routes must return 405 Method Not Allowed with
 * Allow: POST header when accessed via GET.
 *
 * Table-driven test covering all webhooks.* routes, plus a guard that fails
 * if a new webhooks.* route is added without a loader export.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Routes that received loaders in F12 - these include Allow: POST header
const NEW_LOADER_ROUTES = [
  "webhooks.orders",
  "webhooks.customers",
  "webhooks.compliance",
  "webhooks.companies",
  "webhooks.company_locations",
  "webhooks.draft_orders",
  "webhooks.app.scopes_update",
  "webhooks.app.uninstalled",
  "webhooks.bulk_operations.finish",
] as const;

// Routes that already had loaders before F12 - these return 405 but use
// statusText instead of Allow header (not modified to keep diff minimal for #536)
const EXISTING_LOADER_ROUTES = [
  "webhooks.app.subscriptions_update",
  "webhooks.shop.update",
] as const;

const ALL_WEBHOOK_ROUTES = [...NEW_LOADER_ROUTES, ...EXISTING_LOADER_ROUTES];

describe("webhooks.* loader 405 responses", () => {
  describe.each(NEW_LOADER_ROUTES)("%s (F12 new loader)", (routeName) => {
    it("returns 405 with Allow: POST header on GET", async () => {
      const module = await import(`../${routeName}`);
      expect(module.loader).toBeDefined();

      const response = await module.loader();

      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("POST");
    });
  });

  describe.each(EXISTING_LOADER_ROUTES)("%s (pre-existing loader)", (routeName) => {
    it("returns 405 on GET", async () => {
      const module = await import(`../${routeName}`);
      expect(module.loader).toBeDefined();

      const response = await module.loader({
        request: new Request(`https://example.com/${routeName.replace(/\./g, "/")}`),
        context: {},
        params: {},
      });

      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(405);
    });
  });

  it("guard: all webhooks.* routes on disk are covered by test tables", () => {
    const routesDir = path.resolve(__dirname, "..");
    const files = fs.readdirSync(routesDir);

    const webhookFiles = files
      .filter((f) => f.startsWith("webhooks.") && f.endsWith(".tsx"))
      .map((f) => f.replace(/\.tsx$/, ""));

    const uncovered = webhookFiles.filter(
      (routeName) => !ALL_WEBHOOK_ROUTES.includes(routeName as (typeof ALL_WEBHOOK_ROUTES)[number])
    );

    expect(
      uncovered,
      `The following webhooks.* routes are not in NEW_LOADER_ROUTES or EXISTING_LOADER_ROUTES: ${uncovered.join(", ")}. ` +
        `Add new webhook routes to the appropriate list and ensure they export a 405 loader.`
    ).toEqual([]);
  });

  it("guard: all webhooks.* routes have a loader export", () => {
    const routesDir = path.resolve(__dirname, "..");

    const missingLoader: string[] = [];

    for (const routeName of ALL_WEBHOOK_ROUTES) {
      const filePath = path.join(routesDir, `${routeName}.tsx`);
      const content = fs.readFileSync(filePath, "utf-8");

      const hasLoaderExport =
        content.includes("export const loader") ||
        content.includes("export async function loader") ||
        content.includes("export function loader");

      if (!hasLoaderExport) {
        missingLoader.push(routeName);
      }
    }

    expect(
      missingLoader,
      `The following webhooks.* routes are missing a loader export: ${missingLoader.join(", ")}. ` +
        `All webhook routes must export a loader that returns 405 for GET requests.`
    ).toEqual([]);
  });

  it("F12 loaders return Allow: POST header", async () => {
    for (const routeName of NEW_LOADER_ROUTES) {
      const module = await import(`../${routeName}`);
      const response = await module.loader();

      const allowHeader = response.headers.get("Allow");
      expect(
        allowHeader,
        `${routeName} loader should return Allow: POST header`
      ).toBe("POST");
    }
  });
});
