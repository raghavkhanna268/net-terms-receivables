/**
 * Tests that the prod-diagnostics workflow is read-only by default.
 *
 * Verifies:
 * - Only the explicit "Refresh expired token" step (id: refresh) can call refresh code
 * - All database steps use PGOPTIONS with default_transaction_read_only=on unless in write allowlist
 * - Token refresh only runs when refresh_if_expired input is true (exact if expression)
 * - Workflow triggers are exactly [workflow_dispatch]
 * - Write steps are gated on their own dedicated inputs
 *
 * @see https://github.com/raghavkhanna268/net-terms-receivables/issues/159
 */

import { describe, it, expect, beforeAll } from "vitest";
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

interface WorkflowInput {
  default?: unknown;
  type?: string;
  description?: string;
  required?: boolean;
}

type WorkflowTrigger =
  | { inputs?: Record<string, WorkflowInput> }
  | Record<string, unknown>
  | null;

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
  on?: Record<string, WorkflowTrigger> | string | string[];
}

const WRITE_STEP_IDS = new Set(["refresh"]);

const WRITE_STEP_NAMES_TO_INPUT_GATES: Record<string, string> = {
  "Refresh expired token": "inputs.refresh_if_expired",
  "DLQ Redrive": "inputs.redrive_dlq",
  "Drain cron control": "inputs.drain_cron",
  "Reconcile probe": "inputs.invoke_reconcile",
};

const REFRESH_CODE_PATTERN =
  /refresh-offline-token|offline-token\.server|refreshOfflineToken/;

const EXPECTED_REFRESH_IF =
  "${{ inputs.refresh_if_expired && steps.session.outputs.token_expired == 'true' && steps.session.outputs.has_refresh_token == 'true' }}";

describe("prod-diagnostics workflow read-only mode", () => {
  let workflow: Workflow;
  let allSteps: WorkflowStep[];
  let refreshStep: WorkflowStep | undefined;
  let s12Step: WorkflowStep | undefined;

  beforeAll(() => {
    const workflowContent = readFileSync(WORKFLOW_PATH, "utf-8");
    workflow = parseYaml(workflowContent) as Workflow;

    allSteps = [];
    for (const job of Object.values(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        allSteps.push(step);
      }
    }

    refreshStep = allSteps.find((s) => s.id === "refresh");
    s12Step = allSteps.find((s) => s.id === "s12_validation");
  });

  describe("step lookup by id", () => {
    it("finds refresh step by id", () => {
      expect(refreshStep).toBeDefined();
      expect(refreshStep?.name).toBe("Refresh expired token");
    });

    it("finds S12 Validation step by id", () => {
      expect(s12Step).toBeDefined();
      expect(s12Step?.name).toBe("S12 Validation");
    });
  });

  describe("workflow triggers", () => {
    it("triggers are exactly [workflow_dispatch]", () => {
      expect(workflow.on).toBeDefined();

      const triggers = workflow.on;
      if (typeof triggers === "string") {
        expect(triggers).toBe("workflow_dispatch");
      } else if (Array.isArray(triggers)) {
        expect(triggers).toEqual(["workflow_dispatch"]);
      } else {
        const triggerKeys = Object.keys(triggers ?? {});
        expect(triggerKeys).toEqual(["workflow_dispatch"]);
      }
    });
  });

  describe("refresh_if_expired input", () => {
    it("defaults to false", () => {
      const triggers = workflow.on;
      expect(triggers).toBeDefined();
      expect(typeof triggers).toBe("object");
      expect(triggers).not.toBeNull();

      const workflowDispatch = (triggers as Record<string, WorkflowTrigger>)
        .workflow_dispatch;
      expect(workflowDispatch).toBeDefined();

      const inputs = (workflowDispatch as { inputs?: Record<string, WorkflowInput> })
        ?.inputs;
      expect(inputs).toBeDefined();
      expect(inputs?.refresh_if_expired).toBeDefined();
      expect(inputs?.refresh_if_expired.default).toBe(false);
    });
  });

  describe("refresh step if expression", () => {
    it("has exact expected if expression (string equality)", () => {
      expect(refreshStep).toBeDefined();
      expect(refreshStep?.if).toBe(EXPECTED_REFRESH_IF);
    });

    it("contains no || (OR) in if expression", () => {
      expect(refreshStep).toBeDefined();
      expect(refreshStep?.if).not.toContain("||");
    });

    it("contains no negation (!) in if expression", () => {
      expect(refreshStep).toBeDefined();
      expect(refreshStep?.if).not.toMatch(/[^=]!/);
      expect(refreshStep?.if).not.toMatch(/^!/);
    });

    it("records refresh_token_used in summary when triggered", () => {
      expect(refreshStep).toBeDefined();
      expect(refreshStep?.run).toContain("GITHUB_STEP_SUMMARY");
      expect(refreshStep?.run).toContain("refresh_token_used=true");
    });
  });

  describe("refresh code isolation", () => {
    it("only step with id:refresh may reference refresh code", () => {
      for (const step of allSteps) {
        if (!step.run) continue;

        const matchesRefreshCode = REFRESH_CODE_PATTERN.test(step.run);
        if (matchesRefreshCode) {
          expect(step.id).toBe("refresh");
        }
      }
    });

    it("refresh step is the only step that references refresh code", () => {
      const stepsWithRefreshCode = allSteps.filter(
        (s) => s.run && REFRESH_CODE_PATTERN.test(s.run)
      );

      expect(stepsWithRefreshCode.length).toBeGreaterThan(0);
      expect(stepsWithRefreshCode.every((s) => s.id === "refresh")).toBe(true);
    });

    it("S12 Validation step does NOT reference refresh code", () => {
      expect(s12Step).toBeDefined();
      expect(s12Step?.run).toBeDefined();
      expect(REFRESH_CODE_PATTERN.test(s12Step!.run!)).toBe(false);
    });
  });

  describe("read-only PGOPTIONS enforcement", () => {
    it("every step with DATABASE_URL in env has read-only PGOPTIONS (unless in write allowlist)", () => {
      for (const step of allSteps) {
        const env = step.env ?? {};
        const hasDbUrl =
          env.DATABASE_URL !== undefined ||
          env.DATABASE_URL_MIGRATIONS !== undefined ||
          env.DATABASE_URL_SESSION !== undefined;

        if (!hasDbUrl) continue;
        if (WRITE_STEP_IDS.has(step.id ?? "")) continue;
        if (Object.keys(WRITE_STEP_NAMES_TO_INPUT_GATES).includes(step.name ?? "")) continue;

        expect(
          env.PGOPTIONS,
          `Step "${step.name ?? step.id}" has DATABASE_URL but missing PGOPTIONS`
        ).toBeDefined();
        expect(
          env.PGOPTIONS,
          `Step "${step.name ?? step.id}" PGOPTIONS is not read-only`
        ).toContain("default_transaction_read_only=on");
      }
    });

    it("every step with DATABASE_URL reference in run script has PGOPTIONS (unless in write allowlist)", () => {
      const dbUrlPattern = /\$DATABASE_URL|\${DATABASE_URL}|\$\{?DATABASE_URL_/;

      for (const step of allSteps) {
        if (!step.run) continue;
        if (!dbUrlPattern.test(step.run)) continue;
        if (WRITE_STEP_IDS.has(step.id ?? "")) continue;
        if (Object.keys(WRITE_STEP_NAMES_TO_INPUT_GATES).includes(step.name ?? "")) continue;

        const env = step.env ?? {};
        expect(
          env.PGOPTIONS,
          `Step "${step.name ?? step.id}" references DATABASE_URL in run but has no PGOPTIONS`
        ).toBeDefined();
        expect(
          env.PGOPTIONS,
          `Step "${step.name ?? step.id}" PGOPTIONS is not read-only`
        ).toContain("default_transaction_read_only=on");
      }
    });
  });

  describe("write steps are gated on dedicated inputs", () => {
    it("each write step has if expression gated on its dedicated input", () => {
      for (const [stepName, requiredInputGate] of Object.entries(
        WRITE_STEP_NAMES_TO_INPUT_GATES
      )) {
        const step = allSteps.find((s) => s.name === stepName);
        if (!step) continue;

        expect(
          step.if,
          `Write step "${stepName}" must have an if expression`
        ).toBeDefined();
        expect(
          step.if,
          `Write step "${stepName}" if expression must contain ${requiredInputGate}`
        ).toContain(requiredInputGate);
      }
    });
  });

  describe("S12 Validation step properties", () => {
    it("uses read-only PGOPTIONS", () => {
      expect(s12Step).toBeDefined();
      expect(s12Step?.env?.PGOPTIONS).toBe("-c default_transaction_read_only=on");
    });

    it("does not have DATABASE_URL_SESSION in env", () => {
      expect(s12Step).toBeDefined();
      expect(s12Step?.env?.DATABASE_URL_SESSION).toBeUndefined();
    });

    it("does not have SHOPIFY_API_KEY in env", () => {
      expect(s12Step).toBeDefined();
      expect(s12Step?.env?.SHOPIFY_API_KEY).toBeUndefined();
    });

    it("does not have SHOPIFY_API_SECRET in env", () => {
      expect(s12Step).toBeDefined();
      expect(s12Step?.env?.SHOPIFY_API_SECRET).toBeUndefined();
    });

    it("checks TOKEN_EXPIRED and REFRESH_SUCCESS before proceeding", () => {
      expect(s12Step).toBeDefined();
      expect(s12Step?.run).toContain("TOKEN_EXPIRED");
      expect(s12Step?.run).toContain("REFRESH_SUCCESS");
    });

    it("skips with token_expired reason when token is expired", () => {
      expect(s12Step).toBeDefined();
      expect(s12Step?.run).toContain("skipping S12 Validation");
      expect(s12Step?.run).toContain('status: "skipped"');
      expect(s12Step?.run).toContain('reason: "token_expired"');
    });

    it("warns and records ensure_validation_skipped when ensure_validation=true but token expired", () => {
      expect(s12Step).toBeDefined();
      expect(s12Step?.run).toContain("ensure_validation=true but token is expired");
      expect(s12Step?.run).toContain("ensure_validation_skipped=true");
      expect(s12Step?.run).toContain("GITHUB_STEP_SUMMARY");
    });
  });
});
