/**
 * Held checkout fixtures: re-seed the credit_status currency (seed-dev-store only).
 *
 * The 2 HELD seed fixtures on the main dev store carry a credit_status metafield
 * written while the store was USD. The store is now INR, so smoke 4c needs those
 * fixtures to carry the shop currency. This updates the EXISTING metafield on each
 * held seed fixture's owner (CompanyLocation or Customer) in place:
 *   - currencyCode := shop currency (must be INR; anything else refuses)
 *   - hold := true (the DB says the account is held)
 *   - updatedAt := now
 * Every other field (schemaVersion, limitPaise, exposurePaise, holdReasonCode) is kept.
 *
 * Idempotent: a fixture already on the target currency with hold=true is left alone.
 * It never creates a metafield (absent ones are counted, not written), never touches
 * a non-seed or non-held account, and never writes to the database (DB reads run in a
 * READ ONLY transaction).
 *
 * Public-output rules: prints counts, enums and booleans only. Never GIDs, domains,
 * names, amounts or metafield values.
 */

export const HELD_FIXTURE_ID_PREFIX = "seed-account-";
/** Shop currency the held fixtures are re-seeded to. Other shop currencies refuse. */
export const HELD_FIXTURE_TARGET_CURRENCY = "INR";
/** Sanity cap: more held seed fixtures than this means something is off; refuse. */
export const HELD_FIXTURE_MAX = 10;

const OWNER_GID_RE = /^gid:\/\/shopify\/(CompanyLocation|Customer)\/\d+$/;

export const HELD_FIXTURE_METAFIELDS_QUERY = `
  query HeldFixtureCreditStatus($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on CompanyLocation {
        id
        metafield(namespace: "$app", key: "credit_status") {
          jsonValue
          compareDigest
        }
      }
      ... on Customer {
        id
        metafield(namespace: "$app", key: "credit_status") {
          jsonValue
          compareDigest
        }
      }
    }
  }
`;

export const HELD_FIXTURE_METAFIELDS_SET_MUTATION = `
  mutation HeldFixtureCreditStatusSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
      }
      userErrors {
        field
        code
      }
    }
  }
`;

/** A held seed fixture row from the DB (only the columns this needs). */
export interface HeldFixtureRow {
  id: string;
  companyLocationId: string | null;
  customerId: string | null;
}

export interface OwnerMetafield {
  jsonValue: unknown;
  compareDigest: string | null;
}

export type CurrencyBucket = "INR" | "USD" | "other" | "absent";

export interface CurrencyCounts {
  INR: number;
  USD: number;
  other: number;
  absent: number;
  hold_true: number;
}

export interface HeldFixtureSummary {
  mode: "dry_run" | "apply";
  target_currency: string;
  held_total: number;
  owner_missing: number;
  before: CurrencyCounts;
  would_update: number;
  updated: number;
  unchanged: number;
  failed: number;
  after: CurrencyCounts | null;
}

/** Returns the owner GID (CompanyLocation first, like the diag), or null. */
export function ownerGidOf(row: HeldFixtureRow): string | null {
  const candidate = row.companyLocationId ?? row.customerId;
  if (!candidate || !OWNER_GID_RE.test(candidate)) return null;
  return candidate;
}

function asObject(v: unknown): Record<string, unknown> | null {
  if (typeof v === "string") {
    try {
      return asObject(JSON.parse(v));
    } catch {
      return null;
    }
  }
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function currencyBucket(mf: OwnerMetafield | null | undefined): CurrencyBucket {
  const value = mf ? asObject(mf.jsonValue) : null;
  if (!value) return "absent";
  const code = value.currencyCode;
  if (code === "INR") return "INR";
  if (code === "USD") return "USD";
  return "other";
}

export function countCurrencies(metafields: Array<OwnerMetafield | null | undefined>): CurrencyCounts {
  const counts: CurrencyCounts = { INR: 0, USD: 0, other: 0, absent: 0, hold_true: 0 };
  for (const mf of metafields) {
    counts[currencyBucket(mf)]++;
    const value = mf ? asObject(mf.jsonValue) : null;
    if (value && value.hold === true) counts.hold_true++;
  }
  return counts;
}

/**
 * Build the in-place update for one held fixture's credit_status, or null when it
 * needs no change (idempotent) or must not be written (absent / not schemaVersion 1).
 */
export function buildHeldCreditStatusUpdate(
  mf: OwnerMetafield | null | undefined,
  targetCurrency: string,
  now: Date
): Record<string, unknown> | null {
  const value = mf ? asObject(mf.jsonValue) : null;
  if (!value) return null; // never create a metafield
  if (value.schemaVersion !== 1) return null; // unknown schema: leave it alone
  if (value.currencyCode === targetCurrency && value.hold === true) return null;
  return { ...value, currencyCode: targetCurrency, hold: true, updatedAt: now.toISOString() };
}

/** Public-output line: counts, enums and booleans only. */
export function formatSummary(summary: HeldFixtureSummary): string {
  return `held_fixture_currency_summary: ${JSON.stringify(summary)}`;
}

export interface HeldFixtureDeps {
  /** Shop currency from the Admin API (already read by the seed preflight). */
  shopCurrency: string;
  dryRun: boolean;
  /** Reads held seed fixtures for the configured shop (READ ONLY). */
  loadHeldFixtures: () => Promise<HeldFixtureRow[]>;
  /** Reads credit_status for owner GIDs; missing owners are absent from the map. */
  readMetafields: (ownerIds: string[]) => Promise<Map<string, OwnerMetafield | null>>;
  /** Writes one credit_status value; returns true on success (no userErrors). */
  writeMetafield: (ownerId: string, value: string, compareDigest: string | null) => Promise<boolean>;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface HeldFixtureResult {
  ok: boolean;
  /** Enum reason when ok is false. */
  reason?: "shop_currency_not_target" | "no_held_fixtures" | "too_many_held_fixtures" | "write_failed" | "verify_failed";
  summary?: HeldFixtureSummary;
}

export async function reseedHeldFixtureCurrency(deps: HeldFixtureDeps): Promise<HeldFixtureResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => new Date());
  const target = HELD_FIXTURE_TARGET_CURRENCY;

  if (deps.shopCurrency !== target) {
    log(`held_fixture_currency: refused (reason=shop_currency_not_target)`);
    return { ok: false, reason: "shop_currency_not_target" };
  }

  const rows = (await deps.loadHeldFixtures()).filter((r) => r.id.startsWith(HELD_FIXTURE_ID_PREFIX));
  if (rows.length === 0) {
    log(`held_fixture_currency: refused (reason=no_held_fixtures)`);
    return { ok: false, reason: "no_held_fixtures" };
  }
  if (rows.length > HELD_FIXTURE_MAX) {
    log(`held_fixture_currency: refused (reason=too_many_held_fixtures, held_total=${rows.length})`);
    return { ok: false, reason: "too_many_held_fixtures" };
  }

  const owners = rows.map(ownerGidOf);
  const ownerIds = [...new Set(owners.filter((o): o is string => o !== null))];
  const ownerMissingDb = owners.filter((o) => o === null).length;

  const before = ownerIds.length > 0 ? await deps.readMetafields(ownerIds) : new Map<string, OwnerMetafield | null>();
  const ownerMissing = ownerMissingDb + ownerIds.filter((id) => !before.has(id)).length;
  const presentIds = ownerIds.filter((id) => before.has(id));
  const beforeCounts = countCurrencies(presentIds.map((id) => before.get(id)));

  const plan: Array<{ ownerId: string; value: string; digest: string | null }> = [];
  for (const id of presentIds) {
    const mf = before.get(id) ?? null;
    const next = buildHeldCreditStatusUpdate(mf, target, now());
    if (next) plan.push({ ownerId: id, value: JSON.stringify(next), digest: mf?.compareDigest ?? null });
  }

  const summary: HeldFixtureSummary = {
    mode: deps.dryRun ? "dry_run" : "apply",
    target_currency: target,
    held_total: rows.length,
    owner_missing: ownerMissing,
    before: beforeCounts,
    would_update: plan.length,
    updated: 0,
    unchanged: presentIds.length - plan.length,
    failed: 0,
    after: null,
  };

  if (deps.dryRun) {
    log(formatSummary(summary));
    return { ok: true, summary };
  }

  for (const item of plan) {
    let ok = false;
    try {
      ok = await deps.writeMetafield(item.ownerId, item.value, item.digest);
    } catch {
      ok = false;
    }
    if (ok) summary.updated++;
    else summary.failed++;
  }

  const after = presentIds.length > 0 ? await deps.readMetafields(presentIds) : new Map<string, OwnerMetafield | null>();
  summary.after = countCurrencies(presentIds.map((id) => after.get(id)));
  log(formatSummary(summary));

  if (summary.failed > 0) return { ok: false, reason: "write_failed", summary };
  const stillWrong = presentIds.filter((id) => buildHeldCreditStatusUpdate(after.get(id), target, now()) !== null).length;
  if (stillWrong > 0) return { ok: false, reason: "verify_failed", summary };
  return { ok: true, summary };
}
