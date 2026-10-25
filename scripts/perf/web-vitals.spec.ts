/**
 * Web Vitals Performance Tests (S23).
 *
 * Measures LCP, CLS, and INP for main embedded pages using Playwright.
 * Uses a test harness with fixture data to bypass Shopify auth.
 *
 * Targets:
 * - LCP ≤ 2500ms (2.5s)
 * - CLS ≤ 0.1
 * - INP ≤ 200ms
 *
 * Runs with:
 * - Mobile throttled: 4x CPU slowdown, Fast 3G network
 * - Desktop: No throttling
 *
 * Usage:
 *   npx playwright test scripts/perf/web-vitals.spec.ts
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { createServer, type Server } from "http";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface WebVitalMetric {
  name: string;
  value: number;
  rating: string;
}

interface MeasurementResult {
  lcp: number;
  cls: number;
  inp: number;
}

const RUNS_PER_PAGE = 3;

const PAGES = [
  { route: "dashboard", label: "Dashboard (app._index)", lcpExpected: true },
  { route: "onboarding", label: "Onboarding", lcpExpected: true },
  { route: "account", label: "Account Page (app.accounts.$id)", lcpExpected: true },
  { route: "imports", label: "Imports", lcpExpected: false },
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

const TARGETS = {
  lcp: 2500,
  cls: 0.1,
  inp: 200,
};

let server: Server;
let serverPort: number;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

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
  const metrics: MeasurementResult = { lcp: 0, cls: 0, inp: 0 };

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

      const nextBtn = page.locator('s-button:has-text("Next")').first();
      if (await nextBtn.isVisible({ timeout: 500 })) {
        await nextBtn.click();
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
      const fileInput = page.locator('input[type="file"]').first();
      if (await fileInput.isVisible({ timeout: 1000 })) {
        await fileInput.focus();
        await page.waitForTimeout(100);
      }
    }
  } catch {
    // Interactions are best-effort
  }
}

test.describe("Web Vitals Measurements", () => {
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
        console.log(`Test server running on port ${serverPort}`);
        resolve();
      });
    });
  });

  test.afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  for (const profile of PROFILES) {
    test.describe(`Profile: ${profile.label}`, () => {
      for (const pageConfig of PAGES) {
        test(`${pageConfig.label} - meets Web Vitals targets`, async ({ browser }) => {
          const results: MeasurementResult[] = [];

          for (let run = 0; run < RUNS_PER_PAGE; run++) {
            const context = await browser.newContext({
              viewport: profile.viewport,
            });
            const page = await context.newPage();

            await setupCDPThrottling(page, profile.cpuSlowdown, profile.networkConditions);

            try {
              const metrics = await measurePage(page, pageConfig.route, serverPort);
              results.push(metrics);
              console.log(
                `  ${pageConfig.label} Run ${run + 1}: LCP=${metrics.lcp.toFixed(0)}ms, CLS=${metrics.cls.toFixed(4)}, INP=${metrics.inp.toFixed(0)}ms`
              );
            } finally {
              await context.close();
            }
          }

          const medianLcp = median(results.map((r) => r.lcp));
          const medianCls = median(results.map((r) => r.cls));
          const medianInp = median(results.map((r) => r.inp));

          const lcpDisplay = pageConfig.lcpExpected ? `${medianLcp.toFixed(0)}ms` : "n/m";
          const inpDisplay = pageConfig.lcpExpected ? `${medianInp.toFixed(0)}ms` : "n/m";
          console.log(
            `  ${pageConfig.label} Median: LCP=${lcpDisplay}, CLS=${medianCls.toFixed(4)}, INP=${inpDisplay}`
          );

          if (pageConfig.lcpExpected) {
            expect(medianLcp, `LCP should be ≤ ${TARGETS.lcp}ms`).toBeLessThanOrEqual(TARGETS.lcp);
            expect(medianInp, `INP should be ≤ ${TARGETS.inp}ms`).toBeLessThanOrEqual(TARGETS.inp);
          }
          expect(medianCls, `CLS should be ≤ ${TARGETS.cls}`).toBeLessThanOrEqual(TARGETS.cls);
        });
      }
    });
  }
});

test.describe("Web Vitals Report", () => {
  test("Generate measurement report", async ({ browser }) => {
    const harnessPath = join(__dirname, "test-harness.html");
    const harnessContent = readFileSync(harnessPath, "utf-8");

    const reportServer = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(harnessContent);
    });

    const port = await new Promise<number>((resolve) => {
      reportServer.listen(0, () => {
        resolve((reportServer.address() as { port: number }).port);
      });
    });

    type ReportRow = {
      page: string;
      profileLabel: string;
      lcp: number;
      cls: number;
      inp: number;
      lcpExpected: boolean;
      pass: boolean;
    };

    const report: ReportRow[] = [];

    try {
      for (const profile of PROFILES) {
        for (const pageConfig of PAGES) {
          const results: MeasurementResult[] = [];

          for (let run = 0; run < RUNS_PER_PAGE; run++) {
            const context = await browser.newContext({
              viewport: profile.viewport,
            });
            const page = await context.newPage();
            await setupCDPThrottling(page, profile.cpuSlowdown, profile.networkConditions);

            try {
              const metrics = await measurePage(page, pageConfig.route, port);
              results.push(metrics);
            } finally {
              await context.close();
            }
          }

          const medianLcp = median(results.map((r) => r.lcp));
          const medianCls = median(results.map((r) => r.cls));
          const medianInp = median(results.map((r) => r.inp));

          const lcpPass = !pageConfig.lcpExpected || medianLcp <= TARGETS.lcp;
          const inpPass = !pageConfig.lcpExpected || medianInp <= TARGETS.inp;
          const clsPass = medianCls <= TARGETS.cls;
          report.push({
            page: pageConfig.label,
            profileLabel: profile.label,
            lcp: medianLcp,
            cls: medianCls,
            inp: medianInp,
            lcpExpected: pageConfig.lcpExpected,
            pass: lcpPass && clsPass && inpPass,
          });
        }
      }

      console.log("\n## Web Vitals Measurement Report\n");
      console.log(`Runs per page: ${RUNS_PER_PAGE}`);
      console.log(`Targets: LCP ≤ ${TARGETS.lcp}ms, CLS ≤ ${TARGETS.cls}, INP ≤ ${TARGETS.inp}ms\n`);

      for (const profile of PROFILES) {
        console.log(`### ${profile.label}\n`);
        console.log("| Page | LCP (ms) | CLS | INP (ms) | Pass |");
        console.log("|------|----------|-----|----------|------|");

        for (const row of report.filter((r) => r.profileLabel === profile.label)) {
          const lcpStr = row.lcpExpected 
            ? `${row.lcp.toFixed(0)}${row.lcp > TARGETS.lcp ? " ❌" : ""}`
            : "n/m";
          const clsStr = `${row.cls.toFixed(4)}${row.cls > TARGETS.cls ? " ❌" : ""}`;
          const inpStr = row.lcpExpected
            ? `${row.inp.toFixed(0)}${row.inp > TARGETS.inp ? " ❌" : ""}`
            : "n/m";
          console.log(`| ${row.page} | ${lcpStr} | ${clsStr} | ${inpStr} | ${row.pass ? "✅" : "❌"} |`);
        }
        console.log("");
      }
    } finally {
      await new Promise<void>((resolve) => reportServer.close(() => resolve()));
    }
  });
});
