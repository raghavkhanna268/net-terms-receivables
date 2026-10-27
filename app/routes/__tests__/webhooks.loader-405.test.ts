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

const WEBHOOK_ROUTES = [
  "webhooks.orders",
  "webhooks.customers",
  "webhooks.compliance",
  "webhooks.companies",
  "webhooks.company_locations",
  "webhooks.draft_orders",
  "webhooks.app.scopes_update",
  "webhooks.app.subscriptions_update",
  "webhooks.app.uninstalled",
  "webhooks.bulk_operations.finish",
  "webhooks.shop.update",
] as const;

describe("webhooks.* loader 405 responses", () => {
  describe.each(WEBHOOK_ROUTES)("%s", (routeName) => {
    it("returns 405 with Allow: POST header on GET", async () => {
      const module = await import(`../${routeName}`);
      expect(module.loader).toBeDefined();

      const response = await module.loader({
        request: new Request(`https://example.com/${routeName.replace(/\./g, "/")}`),
        context: {},
        params: {},
      });

      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("POST");
    });
  });

  it("guard: all webhooks.* routes in app/routes have a loader export", () => {
    const routesDir = path.resolve(__dirname, "..");
    const files = fs.readdirSync(routesDir);

    const webhookFiles = files.filter(
      (f) => f.startsWith("webhooks.") && f.endsWith(".tsx")
    );

    const missingLoader: string[] = [];

    for (const file of webhookFiles) {
      const filePath = path.join(routesDir, file);
      const content = fs.readFileSync(filePath, "utf-8");

      const hasLoaderExport =
        content.includes("export const loader") ||
        content.includes("export async function loader") ||
        content.includes("export function loader");

      if (!hasLoaderExport) {
        missingLoader.push(file);
      }
    }

    expect(
      missingLoader,
      `The following webhooks.* routes are missing a loader export: ${missingLoader.join(", ")}. ` +
        `All webhook routes must export a loader that returns 405 for GET requests.`
    ).toEqual([]);
  });

  it("all webhook loaders return Response with Allow header value POST", async () => {
    for (const routeName of WEBHOOK_ROUTES) {
      const module = await import(`../${routeName}`);
      const response = await module.loader({
        request: new Request(`https://example.com/${routeName}`),
        context: {},
        params: {},
      });

      const allowHeader = response.headers.get("Allow");
      expect(
        allowHeader,
        `${routeName} loader should return Allow: POST header`
      ).toBe("POST");
    }
  });
});
