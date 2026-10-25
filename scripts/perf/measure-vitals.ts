#!/usr/bin/env npx tsx
/**
 * Web Vitals Measurement Script (S23).
 *
 * Measures LCP, CLS, and INP for the main embedded pages using Playwright.
 * Runs against a local production build with fixture data.
 *
 * Usage:
 *   npm run build
 *   npx tsx scripts/perf/measure-vitals.ts
 *
 * Output: JSON results with medians for each page/profile.
 */

import { chromium, type Browser, type Page, type BrowserContext } from "playwright";
import { spawn, type ChildProcess } from "child_process";
import {
  generateDashboardFixture,
  generateOnboardingFixture,
  generateAccountFixture,
  generateImportsFixture,
} from "./fixtures.js";

interface WebVitalMetric {
  name: string;
  value: number;
  rating: "good" | "needs-improvement" | "poor";
}

interface PageResult {
  route: string;
  lcp: number[];
  cls: number[];
  inp: number[];
  medianLcp: number;
  medianCls: number;
  medianInp: number;
}

interface ProfileResult {
  profile: string;
  pages: PageResult[];
}

const RUNS_PER_PAGE = 3;
const MOBILE_VIEWPORT = { width: 375, height: 812 };
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };

const PAGES_TO_TEST = [
  { route: "/app", name: "Dashboard (app._index)", fixture: "dashboard" },
  { route: "/app/onboarding", name: "Onboarding", fixture: "onboarding" },
  { route: "/app/accounts/test-buyer-1", name: "Account Page", fixture: "account" },
  { route: "/app/imports", name: "Imports", fixture: "imports" },
];

const PROFILES = [
  {
    name: "mobile-throttled",
    viewport: MOBILE_VIEWPORT,
    cpuSlowdown: 4,
    networkConditions: {
      offline: false,
      downloadThroughput: (1.6 * 1024 * 1024) / 8, // 1.6 Mbps (Fast 3G download)
      uploadThroughput: (750 * 1024) / 8, // 750 Kbps
      latency: 150, // 150ms RTT
    },
  },
  {
    name: "desktop",
    viewport: DESKTOP_VIEWPORT,
    cpuSlowdown: 1,
    networkConditions: null,
  },
];

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function getFixtureData(fixtureType: string) {
  switch (fixtureType) {
    case "dashboard":
      return generateDashboardFixture();
    case "onboarding":
      return generateOnboardingFixture();
    case "account":
      return generateAccountFixture();
    case "imports":
      return generateImportsFixture();
    default:
      return {};
  }
}

async function startPreviewServer(): Promise<{ process: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const port = 4173;
    const server = spawn("npx", ["vite", "preview", "--port", port.toString()], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let started = false;

    server.stdout?.on("data", (data: Buffer) => {
      const output = data.toString();
      if (output.includes("Local:") && !started) {
        started = true;
        setTimeout(() => resolve({ process: server, port }), 500);
      }
    });

    server.stderr?.on("data", (data: Buffer) => {
      const output = data.toString();
      if (!started && output.includes("EADDRINUSE")) {
        reject(new Error(`Port ${port} already in use`));
      }
    });

    server.on("error", reject);

    setTimeout(() => {
      if (!started) {
        server.kill();
        reject(new Error("Server startup timeout"));
      }
    }, 30000);
  });
}

async function setupPage(
  browser: Browser,
  profile: (typeof PROFILES)[number]
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: profile.viewport,
    userAgent: profile.name.includes("mobile")
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1"
      : undefined,
  });

  const page = await context.newPage();

  const cdpSession = await page.context().newCDPSession(page);
  await cdpSession.send("Emulation.setCPUThrottlingRate", {
    rate: profile.cpuSlowdown,
  });

  if (profile.networkConditions) {
    await cdpSession.send("Network.emulateNetworkConditions", profile.networkConditions);
  }

  return { context, page };
}

async function injectMockAppBridge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { shopify: unknown }).shopify = {
      webVitals: {
        onReport: () => {},
      },
      environment: {
        embedded: false,
        mobile: false,
      },
      config: {
        apiKey: "test-api-key",
        shop: "test-shop.myshopify.com",
        locale: "en",
      },
      toast: {
        show: () => {},
      },
      modal: {
        show: () => {},
      },
      idToken: () => Promise.resolve("test-token"),
    };
  });
}

async function measurePage(
  page: Page,
  baseUrl: string,
  route: string,
  fixtureType: string,
  runInteraction: boolean
): Promise<{ lcp: number; cls: number; inp: number }> {
  const metrics: { lcp: number; cls: number; inp: number } = {
    lcp: 0,
    cls: 0,
    inp: 0,
  };

  await page.route("**/*", async (routeHandler, request) => {
    const url = request.url();

    if (url.includes("/api/") || url.includes("/__data")) {
      const fixtureData = getFixtureData(fixtureType);
      await routeHandler.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(fixtureData),
      });
      return;
    }

    await routeHandler.continue();
  });

  await page.addInitScript(() => {
    (window as unknown as { __WEB_VITALS_RESULTS__: WebVitalMetric[] }).__WEB_VITALS_RESULTS__ = [];

    const script = document.createElement("script");
    script.type = "module";
    script.textContent = `
      import { onLCP, onCLS, onINP } from 'https://unpkg.com/web-vitals@4/dist/web-vitals.js';
      
      function report(metric) {
        window.__WEB_VITALS_RESULTS__.push({
          name: metric.name,
          value: metric.value,
          rating: metric.rating
        });
      }
      
      onLCP(report);
      onCLS(report);
      onINP(report, { reportAllChanges: true });
    `;
    document.head.appendChild(script);
  });

  await injectMockAppBridge(page);

  await page.goto(`${baseUrl}${route}`, { waitUntil: "networkidle" });

  await page.waitForTimeout(1000);

  if (runInteraction) {
    await runPageInteraction(page, route);
  }

  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });

  await page.waitForTimeout(500);

  const results = await page.evaluate(() => {
    return (window as unknown as { __WEB_VITALS_RESULTS__: WebVitalMetric[] }).__WEB_VITALS_RESULTS__;
  });

  for (const metric of results) {
    if (metric.name === "LCP") metrics.lcp = metric.value;
    if (metric.name === "CLS") metrics.cls = metric.value;
    if (metric.name === "INP") metrics.inp = metric.value;
  }

  return metrics;
}

async function runPageInteraction(page: Page, route: string): Promise<void> {
  try {
    if (route === "/app" || route.includes("accounts")) {
      const sortLink = page.locator('s-link[href*="sortBy"]').first();
      if (await sortLink.isVisible({ timeout: 2000 })) {
        await sortLink.click();
        await page.waitForTimeout(300);
      }

      const pageBtn = page.locator('s-button:has-text("Next")').first();
      if (await pageBtn.isVisible({ timeout: 1000 })) {
        await pageBtn.click();
        await page.waitForTimeout(300);
      }
    }

    if (route === "/app/onboarding") {
      const retryBtn = page.locator('s-button:has-text("Retry")').first();
      if (await retryBtn.isVisible({ timeout: 2000 })) {
        await retryBtn.click();
        await page.waitForTimeout(300);
      }

      const dismissBtn = page.locator('s-button:has-text("Dismiss")').first();
      if (await dismissBtn.isVisible({ timeout: 1000 })) {
        await dismissBtn.click();
        await page.waitForTimeout(300);
      }
    }

    if (route === "/app/imports") {
      const uploadBtn = page.locator('input[type="file"]').first();
      if (await uploadBtn.isVisible({ timeout: 2000 })) {
        await uploadBtn.focus();
        await page.waitForTimeout(100);
      }
    }
  } catch {
    // Interactions are best-effort; continue measurement
  }
}

async function runMeasurements(): Promise<ProfileResult[]> {
  const browser = await chromium.launch({ headless: true });
  const results: ProfileResult[] = [];

  let server: { process: ChildProcess; port: number } | null = null;

  try {
    console.log("Starting preview server...");
    server = await startPreviewServer();
    const baseUrl = `http://localhost:${server.port}`;
    console.log(`Server running at ${baseUrl}`);

    for (const profile of PROFILES) {
      console.log(`\n--- Profile: ${profile.name} ---`);
      const profileResult: ProfileResult = {
        profile: profile.name,
        pages: [],
      };

      for (const pageConfig of PAGES_TO_TEST) {
        console.log(`  Testing: ${pageConfig.name}`);
        const pageResult: PageResult = {
          route: pageConfig.route,
          lcp: [],
          cls: [],
          inp: [],
          medianLcp: 0,
          medianCls: 0,
          medianInp: 0,
        };

        for (let run = 0; run < RUNS_PER_PAGE; run++) {
          const { context, page } = await setupPage(browser, profile);

          try {
            const metrics = await measurePage(
              page,
              baseUrl,
              pageConfig.route,
              pageConfig.fixture,
              true
            );

            pageResult.lcp.push(metrics.lcp);
            pageResult.cls.push(metrics.cls);
            pageResult.inp.push(metrics.inp);

            console.log(`    Run ${run + 1}: LCP=${metrics.lcp.toFixed(0)}ms, CLS=${metrics.cls.toFixed(4)}, INP=${metrics.inp.toFixed(0)}ms`);
          } catch (err) {
            console.log(`    Run ${run + 1}: Error - ${err instanceof Error ? err.message : "unknown"}`);
          } finally {
            await context.close();
          }
        }

        pageResult.medianLcp = median(pageResult.lcp);
        pageResult.medianCls = median(pageResult.cls);
        pageResult.medianInp = median(pageResult.inp);

        profileResult.pages.push(pageResult);
      }

      results.push(profileResult);
    }
  } finally {
    await browser.close();
    if (server) {
      server.process.kill();
    }
  }

  return results;
}

function formatResults(results: ProfileResult[]): string {
  const lines: string[] = [];

  lines.push("\n## Web Vitals Measurement Results\n");
  lines.push(`Runs per page: ${RUNS_PER_PAGE}`);
  lines.push(`Targets: LCP ≤ 2500ms, CLS ≤ 0.1, INP ≤ 200ms\n`);

  for (const profile of results) {
    lines.push(`### ${profile.profile}\n`);
    lines.push("| Page | LCP (ms) | CLS | INP (ms) | Pass |");
    lines.push("|------|----------|-----|----------|------|");

    for (const page of profile.pages) {
      const lcpPass = page.medianLcp <= 2500;
      const clsPass = page.medianCls <= 0.1;
      const inpPass = page.medianInp <= 200;
      const allPass = lcpPass && clsPass && inpPass;

      const lcpStr = `${page.medianLcp.toFixed(0)}${lcpPass ? "" : " ❌"}`;
      const clsStr = `${page.medianCls.toFixed(4)}${clsPass ? "" : " ❌"}`;
      const inpStr = `${page.medianInp.toFixed(0)}${inpPass ? "" : " ❌"}`;
      const passStr = allPass ? "✅" : "❌";

      lines.push(`| ${page.route} | ${lcpStr} | ${clsStr} | ${inpStr} | ${passStr} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function main() {
  console.log("Web Vitals Measurement (S23)\n");
  console.log("Building production bundle first...\n");

  const build = spawn("npm", ["run", "build"], {
    cwd: process.cwd(),
    stdio: "inherit",
  });

  await new Promise<void>((resolve, reject) => {
    build.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Build failed with code ${code}`));
    });
  });

  console.log("\nStarting measurements...\n");

  const results = await runMeasurements();

  console.log(formatResults(results));

  const outputPath = "scripts/perf/results.json";
  const fs = await import("fs");
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to ${outputPath}`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
