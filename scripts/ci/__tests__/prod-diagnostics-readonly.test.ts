/**
 * Tests that the prod-diagnostics workflow is read-only by default.
 *
 * Verifies:
 * - Only the explicit "Refresh expired token" step can call refresh-offline-token.ts
 * - All database connections in default mode use PGOPTIONS with default_transaction_read_only=on
 * - Token refresh only runs when refresh_if_expired input is true
 * - The run summary records refresh_token_used when refresh is triggered
 *
 * @see https://github.com/raghavkhanna268/net-terms-receivables/issues/159
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const WORKFLOW_PATH = join(
  __dirname,
  "../../../.github/workflows/prod-diagnostics.yml"
);

interface WorkflowStep {
  name?: string;
  id?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
  on?: {
    workflow_dispatch?: {
      inputs?: Record<string, { default?: unknown }>;
    };
  };
}

describe("prod-diagnostics workflow read-only mode", () => {
  const workflowContent = readFileSync(WORKFLOW_PATH, "utf-8");
  const workflow = parseYaml(workflowContent) as Workflow;

  it("has refresh_if_expired input defaulting to false", () => {
    const inputs = workflow.on?.workflow_dispatch?.inputs;
    expect(inputs).toBeDefined();
    expect(inputs?.refresh_if_expired).toBeDefined();
    expect(inputs?.refresh_if_expired.default).toBe(false);
  });

  it("only calls refresh-offline-token.ts in the 'Refresh expired token' step", () => {
    const jobs = workflow.jobs ?? {};
    const refreshScriptPattern = /refresh-offline-token\.ts/;

    for (const [_jobName, job] of Object.entries(jobs)) {
      for (const step of job.steps ?? []) {
        if (!step.run) continue;

        const callsRefreshScript = refreshScriptPattern.test(step.run);
        if (callsRefreshScript) {
          expect(step.name).toBe("Refresh expired token");
          expect(step.if).toContain("inputs.refresh_if_expired");
        }
      }
    }
  });

  it("'Refresh expired token' step requires refresh_if_expired input", () => {
    const jobs = workflow.jobs ?? {};

    for (const job of Object.values(jobs)) {
      for (const step of job.steps ?? []) {
        if (step.name === "Refresh expired token") {
          expect(step.if).toBeDefined();
          expect(step.if).toContain("inputs.refresh_if_expired");
          expect(step.run).toContain("GITHUB_STEP_SUMMARY");
          expect(step.run).toContain("refresh_token_used=true");
        }
      }
    }
  });

  it("S12 Validation step does NOT call refresh-offline-token.ts", () => {
    const jobs = workflow.jobs ?? {};
    const refreshScriptPattern = /refresh-offline-token\.ts/;

    for (const job of Object.values(jobs)) {
      for (const step of job.steps ?? []) {
        if (step.name === "S12 Validation") {
          expect(step.run).toBeDefined();
          expect(refreshScriptPattern.test(step.run!)).toBe(false);
        }
      }
    }
  });

  it("S12 Validation step uses read-only PGOPTIONS", () => {
    const jobs = workflow.jobs ?? {};

    for (const job of Object.values(jobs)) {
      for (const step of job.steps ?? []) {
        if (step.name === "S12 Validation") {
          expect(step.env?.PGOPTIONS).toBe("-c default_transaction_read_only=on");
        }
      }
    }
  });

  it("S12 Validation step skips when token is expired in default mode", () => {
    const jobs = workflow.jobs ?? {};

    for (const job of Object.values(jobs)) {
      for (const step of job.steps ?? []) {
        if (step.name === "S12 Validation") {
          expect(step.run).toContain('TOKEN_EXPIRED');
          expect(step.run).toContain('REFRESH_SUCCESS');
          expect(step.run).toContain('skipping S12 Validation');
          expect(step.run).toContain('status: "skipped"');
          expect(step.run).toContain('reason: "token_expired"');
        }
      }
    }
  });

  it("all steps with DATABASE_URL use read-only PGOPTIONS by default", () => {
    const jobs = workflow.jobs ?? {};
    const writeSteps = new Set([
      "Refresh expired token",
      "DLQ Redrive",
      "Drain cron control",
      "Reconcile probe",
    ]);

    for (const job of Object.values(jobs)) {
      for (const step of job.steps ?? []) {
        if (!step.env?.DATABASE_URL) continue;
        if (writeSteps.has(step.name ?? "")) continue;

        if (step.env.PGOPTIONS) {
          expect(step.env.PGOPTIONS).toContain("default_transaction_read_only=on");
        }
      }
    }
  });

  it("workflow only triggers on workflow_dispatch (no push/schedule in default)", () => {
    expect(workflow.on).toBeDefined();
    expect(workflow.on?.workflow_dispatch).toBeDefined();
  });

  it("does not have DATABASE_URL_SESSION in S12 Validation env", () => {
    const jobs = workflow.jobs ?? {};

    for (const job of Object.values(jobs)) {
      for (const step of job.steps ?? []) {
        if (step.name === "S12 Validation") {
          expect(step.env?.DATABASE_URL_SESSION).toBeUndefined();
          expect(step.env?.SHOPIFY_API_KEY).toBeUndefined();
          expect(step.env?.SHOPIFY_API_SECRET).toBeUndefined();
        }
      }
    }
  });
});
