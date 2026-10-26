/**
 * Web Vitals Measurement Tooling (S23).
 *
 * TOOLING ONLY - This harness measures stand-in components with fixture data.
 * It does NOT verify S23 compliance. Real S23 verification requires measuring
 * the actual app in a dev-store session using App Bridge web vitals in the
 * Shopify admin.
 *
 * Metrics:
 * - LCP (Largest Contentful Paint)
 * - CLS (Cumulative Layout Shift)
 * - INP (Interaction to Next Paint)
 *
 * Profiles:
 * - Mobile throttled: 4x CPU slowdown, Fast 3G network
 * - Desktop: No throttling
 *
 * Usage:
 *   npx playwright test scripts/perf/web-vitals.spec.ts
 */

import { test, type Page } from "@playwright/test";
import { createServer, type Server } from "http";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { medianOfReported, countReported, formatMetric } from "./web-vitals-helpers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface WebVitalMetric {
  name: string;
  value: number;
  rating: string;
}

interface MeasurementResult {
  lcp: number | null;
  cls: number | null;
  inp: number | null;
}

const RUNS_PER_PAGE = 5;

const PAGES = [
  { route: "dashboard", label: "Dashboard (app._index)" },
  { route: "onboarding", label: "Onboarding" },
  { route: "account", label: "Account Page (app.accounts.$id)" },
  { route: "imports", label: "Imports" },
];

const PROFILES = [
  {
    label: "mobile-throttled",
    viewport: { width: 375, height: 812 },
    cpuSlowdown: 4,
    networkConditions: {
      offline: false,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
      latency: 150,
    },
  },
  {
    label: "desktop",
    viewport: { width: 1280, height: 800 },
    cpuSlowdown: 1,
    networkConditions: null,
  },
];

async function setupCDPThrottling(
  page: Page,
  cpuSlowdown: number,
  networkConditions: (typeof PROFILES)[0]["networkConditions"]
): Promise<void> {
  const cdpSession = await page.context().newCDPSession(page);

  await cdpSession.send("Emulation.setCPUThrottlingRate", {
    rate: cpuSlowdown,
  });

  if (networkConditions) {
    await cdpSession.send("Network.emulateNetworkConditions", networkConditions);
  }
}

async function measurePage(page: Page, route: string, port: number): Promise<MeasurementResult> {
  const metrics: MeasurementResult = { lcp: null, cls: null, inp: null };

  await page.addInitScript(() => {
    (window as unknown as { __WEB_VITALS_RESULTS__: WebVitalMetric[] }).__WEB_VITALS_RESULTS__ = [];
  });

  await page.goto(`http://localhost:${port}/test-harness.html?route=${route}`, {
    waitUntil: "networkidle",
  });

  await page.waitForSelector(".page", { timeout: 10000 });

  await page.waitForTimeout(500);

  await runInteraction(page, route);

  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });

  await page.waitForTimeout(300);

  const results = await page.evaluate(() => {
    return (window as unknown as { __WEB_VITALS_RESULTS__: WebVitalMetric[] }).__WEB_VITALS_RESULTS__ || [];
  });

  for (const metric of results) {
    if (metric.name === "LCP") metrics.lcp = metric.value;
    if (metric.name === "CLS") metrics.cls = metric.value;
    if (metric.name === "INP") metrics.inp = metric.value;
  }

  return metrics;
}

async function runInteraction(page: Page, route: string): Promise<void> {
  try {
    if (route === "dashboard") {
      const sortLink = page.locator('s-link[href*="sortBy"]').first();
      if (await sortLink.isVisible({ timeout: 1000 })) {
        await sortLink.click();
        await page.waitForTimeout(100);
      }
    }

    if (route === "onboarding") {
      const dismissBtn = page.locator('s-button:has-text("Dismiss")').first();
      if (await dismissBtn.isVisible({ timeout: 1000 })) {
        await dismissBtn.click();
        await page.waitForTimeout(100);
      }
    }

    if (route === "account") {
      const saveBtn = page.locator('s-button:has-text("Save")').first();
      if (await saveBtn.isVisible({ timeout: 1000 })) {
        await saveBtn.click();
        await page.waitForTimeout(100);
      }
    }

    if (route === "imports") {
      const uploadBtn = page.locator('s-button:has-text("Upload")').first();
      if (await uploadBtn.isVisible({ timeout: 1000 })) {
        await uploadBtn.click();
        await page.waitForTimeout(100);
      }
    }
  } catch {
    // Interactions are best-effort in the harness
  }
}

test.describe("Web Vitals Harness Measurements (tooling only)", () => {
  let server: Server;
  let serverPort: number;

  test.beforeAll(async () => {
    const harnessPath = join(__dirname, "test-harness.html");
    const harnessContent = readFileSync(harnessPath, "utf-8");

    server = createServer((req, res) => {
      if (req.url?.includes("test-harness.html") || req.url === "/" || req.url?.startsWith("/?")) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(harnessContent);
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        serverPort = (server.address() as { port: number }).port;
        console.log(`Harness server running on port ${serverPort}`);
        resolve();
      });
    });
  });

  test.afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("Generate harness measurement report", async ({ browser }) => {
    type ReportRow = {
      page: string;
      profileLabel: string;
      lcpValues: (number | null)[];
      clsValues: (number | null)[];
      inpValues: (number | null)[];
    };

    const report: ReportRow[] = [];

    for (const profile of PROFILES) {
      for (const pageConfig of PAGES) {
        const lcpValues: (number | null)[] = [];
        const clsValues: (number | null)[] = [];
        const inpValues: (number | null)[] = [];

        for (let run = 0; run < RUNS_PER_PAGE; run++) {
          const context = await browser.newContext({
            viewport: profile.viewport,
          });
          const page = await context.newPage();
          await setupCDPThrottling(page, profile.cpuSlowdown, profile.networkConditions);

          try {
            const metrics = await measurePage(page, pageConfig.route, serverPort);
            lcpValues.push(metrics.lcp);
            clsValues.push(metrics.cls);
            inpValues.push(metrics.inp);
          } finally {
            await context.close();
          }
        }

        report.push({
          page: pageConfig.label,
          profileLabel: profile.label,
          lcpValues,
          clsValues,
          inpValues,
        });
      }
    }

    console.log("\n## Web Vitals Harness Measurements (stand-in components, not the real app)\n");
    console.log(`Runs per page: ${RUNS_PER_PAGE}`);
    console.log("Note: These are harness measurements only. Real S23 verification requires");
    console.log("measuring the actual app in a dev-store session with App Bridge web vitals.\n");

    for (const profile of PROFILES) {
      console.log(`### ${profile.label}\n`);
      console.log("| Page | LCP | CLS | INP |");
      console.log("|------|-----|-----|-----|");

      for (const row of report.filter((r) => r.profileLabel === profile.label)) {
        const lcpMedian = medianOfReported(row.lcpValues);
        const clsMedian = medianOfReported(row.clsValues);
        const inpMedian = medianOfReported(row.inpValues);

        const lcpStr = formatMetric(lcpMedian, countReported(row.lcpValues), RUNS_PER_PAGE, "ms");
        const clsStr = formatMetric(clsMedian, countReported(row.clsValues), RUNS_PER_PAGE, "");
        const inpStr = formatMetric(inpMedian, countReported(row.inpValues), RUNS_PER_PAGE, "ms");
        console.log(`| ${row.page} | ${lcpStr} | ${clsStr} | ${inpStr} |`);
      }
      console.log("");
    }
  });
});
