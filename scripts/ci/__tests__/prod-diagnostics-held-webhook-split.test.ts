/**
 * prod-diagnostics.yml held_webhook_split option (read-only), static side.
 *
 * Pins:
 * - held_webhook_split is a boolean input defaulting to false and is the
 *   only gate of its step; no new input carries a shop, id or window;
 * - the step is read-only (PGOPTIONS + BEGIN TRANSACTION READ ONLY ...
 *   ROLLBACK) and gets the shop label vars only from the masked
 *   ALLOWED_DEV_STORE / E2E_SHOP secrets (invalid/unset -> "" -> unknown);
 * - every section embeds the canonical shop_labels CTE; outside it the
 *   domain is only compared in the webhook_receipts join, never selected;
 * - every output column is a count, enum or boolean in the readonly column
 *   guard's dialect (no ids, GIDs, timestamps, money or free text);
 * - the webhook lookback is a hard-coded 6 hours.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { checkSql } from "../check-readonly-columns";
import { SHOP_LABELS_CTE, stripShopLabelsCte } from "../shop-labels";

const ROOT = join(__dirname, "../../..");
const STEP_NAME = "Held and webhook split by shop_kind (read-only)";
const PLANTED_ALLOWED = "planted-split-main-store.myshopify.com";
const PLANTED_E2E = "planted-split-e2e-store.myshopify.com";

interface Step {
  name?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
}
interface Workflow {
  on: { workflow_dispatch: { inputs: Record<string, { type?: string; default?: unknown }> } };
  jobs: Record<string, { steps?: Step[] }>;
}

const wfText = readFileSync(join(ROOT, ".github/workflows/prod-diagnostics.yml"), "utf8");
const wf = parseYaml(wfText) as Workflow;
const inputs = wf.on.workflow_dispatch.inputs;
const steps = Object.values(wf.jobs).flatMap((j) => j.steps ?? []);
const step = steps.find((s) => s.name === STEP_NAME);
const run = step?.run ?? "";
const heredocs = [...run.matchAll(/<<'EOSQL'\n([\s\S]*?)\nEOSQL/g)].map((m) => m[1]);
const sql = heredocs[0] ?? "";

function between(text: string, start: string, end: string): string {
  const a = text.indexOf(start);
  const b = text.indexOf(end, a);
  expect(a, `missing ${start}`).toBeGreaterThanOrEqual(0);
  expect(b, `missing ${end}`).toBeGreaterThan(a);
  return text.slice(a, b + end.length);
}

describe("prod-diagnostics held_webhook_split option", () => {
  it("is a boolean input defaulting to false, described as read-only", () => {
    expect(inputs.held_webhook_split).toBeDefined();
    expect(inputs.held_webhook_split.type).toBe("boolean");
    expect(inputs.held_webhook_split.default).toBe(false);
    expect(String((inputs.held_webhook_split as { description?: string }).description)).toMatch(/^Read-only:/);
  });

  it("gates exactly one step, in the default diagnostics job", () => {
    expect(step).toBeDefined();
    expect(step?.if).toBe("${{ inputs.held_webhook_split }}");
    expect(wfText.match(/inputs\.held_webhook_split/g)).toHaveLength(1);
    expect(wf.jobs.diagnostics.steps?.some((s) => s.name === STEP_NAME)).toBe(true);
  });

  it("reads no workflow input (no shop, id or lookback input)", () => {
    expect(JSON.stringify(step?.env ?? {})).not.toMatch(/inputs\./);
    expect(run).not.toMatch(/inputs\.|SHOP_DOMAIN|GITHUB_EVENT_PATH/);
  });

  it("is read-only and takes the label vars only from secrets", () => {
    expect(step?.env).toEqual({
      DATABASE_URL: "${{ secrets.DATABASE_URL_MIGRATIONS }}",
      ALLOWED_DEV_STORE: "${{ secrets.ALLOWED_DEV_STORE }}",
      E2E_SHOP: "${{ secrets.E2E_SHOP }}",
      PGOPTIONS: "-c default_transaction_read_only=on",
    });
    expect(heredocs).toHaveLength(1);
    expect(sql.trimStart().startsWith("BEGIN TRANSACTION READ ONLY;")).toBe(true);
    expect(sql.trimEnd().endsWith("ROLLBACK;")).toBe(true);
    expect(run.match(/^\s*psql /gm)).toHaveLength(1);
    expect(run).toMatch(/psql -X -q -v ON_ERROR_STOP=1 -v "allowed=\$\{LABEL_ALLOWED\}" -v "e2e=\$\{LABEL_E2E\}" "\$DATABASE_URL" <<'EOSQL'/);
    for (const line of run.split("\n")) {
      if (/\becho\b/.test(line) && !line.includes("::add-mask::")) {
        expect(line).not.toMatch(/\$\{?(LABEL_ALLOWED|LABEL_E2E|ALLOWED_DEV_STORE|E2E_SHOP)\b/);
      }
    }
  });

  it("embeds the canonical shop_labels CTE in every section and never selects the domain", () => {
    const sections = sql.split(/^\\echo .*$/m).slice(1);
    expect(sections).toHaveLength(3);
    for (const s of sections) expect(s).toContain(`WITH ${SHOP_LABELS_CTE}`);
    const rest = stripShopLabelsCte(sql);
    expect(rest).not.toMatch(/ROW_NUMBER|RANK\s*\(|shop_idx/i);
    const domainUses = [...rest.matchAll(/[^\n]*\.domain\b[^\n]*/g)].map((m) => m[0].trim());
    expect(domainUses).toEqual(['LEFT JOIN "Shop" s ON s.domain = wr.shop']);
    expect(rest).not.toMatch(/order_gid\s*(AS|,|$)|\bwr\.shop\s*(AS|,)/im);
  });

  it("prints counts, enums and booleans only (readonly column guard)", () => {
    const { violations, columns } = checkSql("prod-diagnostics/held_webhook_split.sql", sql);
    expect(violations).toEqual([]);
    expect(columns.map((c) => `${c.column}:${c.kind}`)).toEqual([
      "shop_kind:enum",
      "shop_row:boolean",
      "held_orders:count",
      "held_orders_6h:count",
      "held_orders_with_invoice:count",
      "shop_kind:enum",
      "hold_state:enum",
      "manual_hold:boolean",
      "bypass:boolean",
      "accounts:count",
      "seed_fixtures:count",
      "shop_kind:enum",
      "shop_row:boolean",
      "topic:enum",
      "receipts_6h:count",
    ]);
  });

  it("uses a hard-coded 6 hour lookback for webhook receipts", () => {
    const receipts = sql.slice(sql.indexOf("FROM webhook_receipts wr"));
    expect(receipts).toContain("WHERE wr.received_at > NOW() - INTERVAL '6 hours'");
    expect(sql).not.toMatch(/:'?since'?|:'?hours'?|:'?window'?/);
  });

  const snippet = between(run, "# Split shop label secrets", "# End split shop label secrets");
  const probe = `set -euo pipefail\n${snippet}\necho "allowed=\${LABEL_ALLOWED:+set} e2e=\${LABEL_E2E:+set}"\n`;

  it.each([
    ["valid", { ALLOWED_DEV_STORE: PLANTED_ALLOWED, E2E_SHOP: PLANTED_E2E }, "allowed=set e2e=set"],
    ["E2E_SHOP missing", { ALLOWED_DEV_STORE: PLANTED_ALLOWED }, "allowed=set e2e="],
    ["E2E_SHOP invalid", { ALLOWED_DEV_STORE: PLANTED_ALLOWED, E2E_SHOP: `${PLANTED_E2E}\nx` }, "allowed=set e2e="],
    ["both missing", {}, "allowed= e2e="],
  ] as const)("label secrets %s -> vars (unknown labels, no failure, no domain)", (_l, env, want) => {
    const r = spawnSync("bash", ["-c", probe], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    const visible = `${r.stdout}\n${r.stderr}`
      .split("\n")
      .filter((l) => !l.startsWith("::add-mask::"))
      .join("\n");
    expect(r.status).toBe(0);
    expect(visible.trim()).toBe(want);
    expect(visible).not.toContain("myshopify");
  });
});
