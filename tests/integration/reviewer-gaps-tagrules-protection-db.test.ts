/**
 * Reviewer-journey coverage-gap tests (DB-backed, runs in the "Sequential DB" project).
 *
 * Closes two gaps left by the reviewer-journey suite (#508):
 *
 * (A) Tag-rule route RECONCILE_CUSTOMERS enqueue + #498 dedupe.
 *     Drives the REAL `action` from app/routes/app.tag-rules.tsx with a real form POST
 *     Request against the real test DB. Only authentication is mocked; the enqueue path
 *     (enqueueReconcileStage -> pgmq.send on the shared s6_sync queue) runs for real.
 *     Assertions use per-shop delta counts because other tests share pgmq.q_s6_sync.
 *
 * (B) Checkout protection turned on at install/setup.
 *     Drives the REAL install flow (runAfterAuth -> runSetup) with the Admin API mocked
 *     to capture every GraphQL call. Asserts the exact mutations that turn protection on:
 *     validationCreate (credit-check-validation, enable:true), paymentCustomizationCreate
 *     (hide-terms-payment, enabled:true), the credit_status metafield definitions, and the
 *     $app:shop_config metafield write. Also covers idempotent re-run and the userErrors
 *     error path. The registration functions themselves are NOT mocked (the reviewer-journey
 *     suite mocks them, which is exactly the gap).
 *
 * All data is synthetic: test-*.myshopify.com domains, opaque ids, no gid:// strings.
 *
 * Mocks:
 * - authenticate.admin / the Admin GraphQL client (only)
 * - @shopify/shopify-app-react-router/server (boundary.headers) — route import side-effect
 * - @sentry/cloudflare — defensive, so no code path reports during these tests
 *
 * Never mocks the code under test, the enqueue path, or log.server.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { sqlOptions } from "../../app/lib/db-light.server.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

// Sentry: @sentry/cloudflare is only imported by app/lib/sentry.ts, which is in the import
// chain of both the enqueue path and the install flow. Mock it so no path reports.
vi.mock("@sentry/cloudflare", () => ({
  withSentry: (_opts: unknown, handler: unknown) => handler,
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

// The tag-rules route imports boundary at module load for its `headers` export. Partially
// mock so other exports (e.g. ApiVersion, used elsewhere in the import chain) are preserved.
vi.mock("@shopify/shopify-app-react-router/server", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    boundary: { headers: vi.fn(() => ({})) },
  };
});

interface ActionResultData {
  success?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  createdRuleId?: string;
}

function extractActionData(result: unknown): ActionResultData {
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    (result as { type: string }).type === "DataWithResponseInit" &&
    "data" in result
  ) {
    return (result as { data: ActionResultData }).data;
  }
  return result as ActionResultData;
}

function extractStatus(result: unknown): number | undefined {
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    (result as { type: string }).type === "DataWithResponseInit" &&
    "init" in result
  ) {
    const init = (result as { init: { status?: number } | null }).init;
    return init?.status;
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// -----------------------------------------------------------------------------
// (A) Tag-rule route: RECONCILE_CUSTOMERS enqueue + #498 dedupe
// -----------------------------------------------------------------------------

describeWithDb("Reviewer gap A: tag-rule RECONCILE_CUSTOMERS enqueue + #498 dedupe (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const RUN_ID = Date.now().toString(36) + "-tagrules-gap";
  const SHOP_ID = `test-shop-${RUN_ID}`;
  const SHOP_DOMAIN = `test-${RUN_ID}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
    `;
  });

  afterAll(async () => {
    // Clean up only this shop's queue messages and rows. Never DELETE across all shops.
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${SHOP_DOMAIN}`;
    await sql`DELETE FROM "AccountSource" WHERE "shopId" = ${SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
    await sql.end();
  });

  function actionArgs(formData: FormData) {
    return {
      request: new Request("https://example.com/app/tag-rules", {
        method: "POST",
        body: formData,
      }),
      context: {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({ session: { shop: SHOP_DOMAIN } }),
          },
        },
      },
      params: {},
      url: new URL("https://example.com/app/tag-rules"),
      pattern: "/app/tag-rules",
    } as unknown;
  }

  async function runCreate(tag: string, defaultTermsDays: string) {
    const formData = new FormData();
    formData.append("intent", "create_tag_rule");
    formData.append("tag", tag);
    formData.append("defaultTermsDays", defaultTermsDays);

    vi.doMock("../../app/lib/request-context.server.js", () => ({
      getRequestSql: () => sql,
      getRequestWaitUntil: () => undefined,
      getRequestEnv: () => ({}),
    }));

    vi.resetModules();
    const { action } = await import("../../app/routes/app.tag-rules.js");
    return action(actionArgs(formData) as never);
  }

  async function countCustomersQueued(): Promise<number> {
    const [row] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${SHOP_DOMAIN}
        AND message->>'topic' = 'RECONCILE_CUSTOMERS'
    `;
    return parseInt(row.n, 10);
  }

  async function readCustomersMessages() {
    return sql<{ message: Record<string, unknown> }[]>`
      SELECT message FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${SHOP_DOMAIN}
        AND message->>'topic' = 'RECONCILE_CUSTOMERS'
      ORDER BY msg_id
    `;
  }

  async function cleanShopState() {
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${SHOP_DOMAIN}`;
    await sql`DELETE FROM "AccountSource" WHERE "shopId" = ${SHOP_ID}`;
  }

  it("first tag rule enqueues exactly one RECONCILE_CUSTOMERS message with the #498 shape", async () => {
    await cleanShopState();

    const before = await countCustomersQueued();
    expect(before).toBe(0);

    const result = await runCreate("gap-net30", "30");
    expect(extractActionData(result).success).toBe(true);

    const after = await countCustomersQueued();
    expect(after - before).toBe(1);

    const messages = await readCustomersMessages();
    expect(messages).toHaveLength(1);

    const message = messages[0].message;
    expect(message.topic).toBe("RECONCILE_CUSTOMERS");
    expect(message.shop).toBe(SHOP_DOMAIN);
    expect(message.webhookId).toMatch(
      new RegExp(`^reconcile:${escapeRegExp(SHOP_DOMAIN)}:manual:\\d+:customers$`),
    );
    expect(message.manualKey).toMatch(/^manual:\d+$/);
    expect(typeof message.enqueuedAt).toBe("string");
    expect(new Date(message.enqueuedAt as string).toISOString()).toBe(message.enqueuedAt);
  });

  it("second distinct tag rule does NOT re-enqueue — #498 dedupe (exact delta 0; positive control)", async () => {
    await cleanShopState();

    // Seed the first rule so a RECONCILE_CUSTOMERS message is already queued for this shop.
    const first = await runCreate("gap-seed-a", "30");
    expect(extractActionData(first).success).toBe(true);

    const before = await countCustomersQueued();
    expect(before).toBe(1);

    // A genuinely new, distinct rule — a real successful insert, not a rejected duplicate.
    const second = await runCreate("gap-seed-b", "45");
    const secondData = extractActionData(second);
    expect(secondData.success).toBe(true);
    expect(secondData.createdRuleId).toBeDefined();

    const after = await countCustomersQueued();
    // #498: because a RECONCILE_CUSTOMERS message is already queued for this shop, the
    // second successful rule must NOT enqueue another one. Exact delta is 0.
    // Positive control: without the `if (!alreadyQueued)` guard this delta would be 1.
    expect(after - before).toBe(0);
    expect(after).toBe(1);

    // Prove the second rule really exists (it was a new insert, not an ON CONFLICT no-op).
    const rules = await sql<{ tag: string }[]>`
      SELECT tag FROM "AccountSource" WHERE "shopId" = ${SHOP_ID} ORDER BY tag
    `;
    expect(rules.map((r) => r.tag)).toEqual(["gap-seed-a", "gap-seed-b"]);
  });

  it("duplicate re-submit (ON CONFLICT) is rejected and does not enqueue (delta 0)", async () => {
    await cleanShopState();

    const first = await runCreate("gap-dup", "30");
    expect(extractActionData(first).success).toBe(true);

    const before = await countCustomersQueued();
    expect(before).toBe(1);

    const duplicate = await runCreate("gap-dup", "30");
    expect(extractStatus(duplicate)).toBe(400);
    expect(extractActionData(duplicate).success).toBe(false);

    const after = await countCustomersQueued();
    expect(after - before).toBe(0);
    expect(after).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// (B) Checkout protection turned on at install/setup
// -----------------------------------------------------------------------------

function readExtensionHandle(extensionDir: string): string {
  const tomlPath = path.resolve(
    process.cwd(),
    "extensions",
    extensionDir,
    "shopify.extension.toml",
  );
  const content = readFileSync(tomlPath, "utf8");
  const match = content.match(/^\s*handle\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error(`handle not found in ${tomlPath}`);
  }
  return match[1];
}

interface CapturedCall {
  query: string;
  variables: Record<string, unknown> | undefined;
}

interface ValidationNodeShape {
  id: string;
  shopifyFunction: { handle: string };
  title: string;
  enabled: boolean;
  blockOnFailure?: boolean;
}

interface PaymentCustomizationNodeShape {
  id: string;
  shopifyFunction: { handle: string };
  title: string;
  enabled: boolean;
}

interface AdminMockOptions {
  shopOwnerId: string;
  existingValidation?: ValidationNodeShape;
  existingPaymentCustomization?: PaymentCustomizationNodeShape;
  validationUserErrors?: Array<{ field?: string[]; message: string; code?: string }>;
  metafieldDefinitionTaken?: boolean;
}

describeWithDb("Reviewer gap B: checkout protection turned on at install (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const RUN_ID = Date.now().toString(36) + "-protect-gap";
  const DOMAIN_POSITIVE = `test-protect-create-${RUN_ID}.myshopify.com`;
  const DOMAIN_IDEMPOTENT = `test-protect-idem-${RUN_ID}.myshopify.com`;
  const DOMAIN_ERROR = `test-protect-err-${RUN_ID}.myshopify.com`;
  const DOMAIN_HIDECONFIG = `test-protect-hideconfig-${RUN_ID}.myshopify.com`;

  // Opaque id used where the source expects a shop GID. Deliberately NOT a gid:// string.
  const SHOP_OWNER_ID = `test-shop-owner-${RUN_ID}`;
  const VALIDATION_ID = `test-validation-${RUN_ID}`;
  const PAYMENT_CUSTOMIZATION_ID = `test-paymentcust-${RUN_ID}`;
  const METAFIELD_DEFINITION_ID = `test-metafielddef-${RUN_ID}`;
  const METAFIELD_ID = `test-metafield-${RUN_ID}`;

  // Handles read straight from the extension manifests, so the assertions prove the install
  // uses the same handle Shopify expects for each Function.
  const VALIDATION_HANDLE = readExtensionHandle("credit-check-validation");
  const PAYMENT_HANDLE = readExtensionHandle("hide-terms-payment");

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
    await cleanShops();
  });

  afterAll(async () => {
    await cleanShops();
    await sql.end();
  });

  async function cleanShops() {
    await sql`
      DELETE FROM "Shop"
      WHERE domain IN (${DOMAIN_POSITIVE}, ${DOMAIN_IDEMPOTENT}, ${DOMAIN_ERROR}, ${DOMAIN_HIDECONFIG})
    `;
  }

  function routeResponse(query: string, opts: AdminMockOptions): unknown {
    if (query.includes("ShopAuthInfo")) {
      return {
        data: {
          shop: {
            id: opts.shopOwnerId,
            ianaTimezone: "America/New_York",
            currencyCode: "INR",
          },
        },
      };
    }
    if (query.includes("MetafieldDefinitionCreate")) {
      return {
        data: {
          metafieldDefinitionCreate: {
            createdDefinition: opts.metafieldDefinitionTaken
              ? null
              : { id: METAFIELD_DEFINITION_ID },
            userErrors: opts.metafieldDefinitionTaken
              ? [{ code: "TAKEN", message: "already exists" }]
              : [],
          },
        },
      };
    }
    if (query.includes("WriteShopConfig")) {
      return {
        data: {
          metafieldsSet: {
            metafields: [{ id: METAFIELD_ID }],
            userErrors: [],
          },
        },
      };
    }
    if (query.includes("ValidationCreate")) {
      if (opts.validationUserErrors?.length) {
        return {
          data: {
            validationCreate: {
              validation: null,
              userErrors: opts.validationUserErrors,
            },
          },
        };
      }
      return {
        data: {
          validationCreate: {
            validation: {
              id: VALIDATION_ID,
              shopifyFunction: { handle: VALIDATION_HANDLE },
              title: "Termwise Credit Check",
              enabled: true,
            },
            userErrors: [],
          },
        },
      };
    }
    if (query.includes("GetValidations")) {
      return {
        data: {
          validations: {
            edges: opts.existingValidation ? [{ node: opts.existingValidation }] : [],
          },
        },
      };
    }
    if (query.includes("PaymentCustomizationCreate")) {
      return {
        data: {
          paymentCustomizationCreate: {
            paymentCustomization: {
              id: PAYMENT_CUSTOMIZATION_ID,
              shopifyFunction: { handle: PAYMENT_HANDLE },
              title: "Termwise Payment Hide",
              enabled: true,
            },
            userErrors: [],
          },
        },
      };
    }
    if (query.includes("GetPaymentCustomizations")) {
      return {
        data: {
          paymentCustomizations: {
            edges: opts.existingPaymentCustomization
              ? [{ node: opts.existingPaymentCustomization }]
              : [],
          },
        },
      };
    }
    return { data: {} };
  }

  function makeCapturingAdmin(opts: Partial<AdminMockOptions> = {}) {
    const resolved: AdminMockOptions = { shopOwnerId: SHOP_OWNER_ID, ...opts };
    const calls: CapturedCall[] = [];
    const graphql = vi.fn(
      async (query: string, options?: { variables?: Record<string, unknown> }) => {
        calls.push({ query, variables: options?.variables });
        const payload = routeResponse(query, resolved);
        return { json: () => Promise.resolve(payload) };
      },
    );
    return { admin: { graphql }, calls };
  }

  async function importAfterAuth() {
    vi.doMock("../../app/lib/request-context.server.js", () => ({
      getRequestSql: () => sql,
      getRequestWaitUntil: () => undefined,
      getRequestEnv: () => ({}),
    }));
    vi.resetModules();
    return import("../../app/lib/after-auth.server.js");
  }

  it("install registers both Shopify Functions and writes config metafields with exact handles/flags/shape", async () => {
    const { runAfterAuth, _resetSetupCacheForTesting, _isShopSetupComplete } =
      await importAfterAuth();
    _resetSetupCacheForTesting();

    const { admin, calls } = makeCapturingAdmin();
    const waitUntilPromises: Promise<unknown>[] = [];
    const waitUntil = (p: Promise<unknown>) => {
      waitUntilPromises.push(p);
    };

    await runAfterAuth(DOMAIN_POSITIVE, admin as never, waitUntil);
    await Promise.all(waitUntilPromises);
    await vi.waitFor(() => expect(_isShopSetupComplete(DOMAIN_POSITIVE)).toBe(true));

    // Credit-check validation create: exact handle + enable:true + blockOnFailure:false + title.
    const validationCreate = calls.find((c) => c.query.includes("ValidationCreate"));
    expect(validationCreate).toBeDefined();
    expect(validationCreate!.variables?.functionHandle).toBe(VALIDATION_HANDLE);
    expect(validationCreate!.variables?.functionHandle).toBe("credit-check-validation");
    expect(validationCreate!.variables?.title).toBe("Termwise Credit Check");
    expect(validationCreate!.query).toContain("enable: true");
    expect(validationCreate!.query).toContain("blockOnFailure: false");

    // Hide-terms payment customization create: exact handle + enabled:true + title.
    const paymentCreate = calls.find((c) => c.query.includes("PaymentCustomizationCreate"));
    expect(paymentCreate).toBeDefined();
    expect(paymentCreate!.variables?.functionHandle).toBe(PAYMENT_HANDLE);
    expect(paymentCreate!.variables?.functionHandle).toBe("hide-terms-payment");
    expect(paymentCreate!.variables?.title).toBe("Termwise Payment Hide");
    expect(paymentCreate!.query).toContain("enabled: true");

    // $app:shop_config metafield: exact namespace/key/type and JSON config shape.
    const shopConfig = calls.find((c) => c.query.includes("WriteShopConfig"));
    expect(shopConfig).toBeDefined();
    const metafields = shopConfig!.variables?.metafields as Array<Record<string, unknown>>;
    expect(metafields).toHaveLength(1);
    expect(metafields[0].ownerId).toBe(SHOP_OWNER_ID);
    expect(metafields[0].namespace).toBe("$app");
    expect(metafields[0].key).toBe("shop_config");
    expect(metafields[0].type).toBe("json");
    expect(JSON.parse(metafields[0].value as string)).toEqual({
      schemaVersion: 1,
      currencyCode: "INR",
    });

    // credit_status metafield definitions on both owner types.
    const definitionCreates = calls.filter((c) => c.query.includes("MetafieldDefinitionCreate"));
    expect(definitionCreates).toHaveLength(2);
    for (const def of definitionCreates) {
      expect(def.variables?.namespace).toBe("$app");
      expect(def.variables?.key).toBe("credit_status");
      expect(def.variables?.type).toBe("json");
    }
    expect(definitionCreates.map((d) => d.variables?.ownerType).sort()).toEqual([
      "COMPANY_LOCATION",
      "CUSTOMER",
    ]);

    // DB side effect of a successful install: the Shop row persists with the live currency.
    const [shopRow] = await sql<{ currency: string }[]>`
      SELECT currency FROM "Shop" WHERE domain = ${DOMAIN_POSITIVE}
    `;
    expect(shopRow.currency).toBe("INR");
  });

  it("re-running install with existing validation and customization creates no duplicates", async () => {
    const { runAfterAuth, _resetSetupCacheForTesting } = await importAfterAuth();
    _resetSetupCacheForTesting();

    // First install: both Functions are created.
    const first = makeCapturingAdmin();
    const firstWaitUntil: Promise<unknown>[] = [];
    await runAfterAuth(DOMAIN_IDEMPOTENT, first.admin as never, (p) => {
      firstWaitUntil.push(p);
    });
    await Promise.all(firstWaitUntil);
    expect(first.calls.filter((c) => c.query.includes("ValidationCreate"))).toHaveLength(1);
    expect(first.calls.filter((c) => c.query.includes("PaymentCustomizationCreate"))).toHaveLength(1);

    // Clear the per-isolate "setup complete" cache so setup runs again on re-install.
    _resetSetupCacheForTesting();

    // Second install: the Admin API now reports the existing Function registrations, matched
    // by handle, with the canonical titles (so no title update is needed either).
    const second = makeCapturingAdmin({
      existingValidation: {
        id: VALIDATION_ID,
        shopifyFunction: { handle: VALIDATION_HANDLE },
        title: "Termwise Credit Check",
        enabled: true,
        blockOnFailure: false,
      },
      existingPaymentCustomization: {
        id: PAYMENT_CUSTOMIZATION_ID,
        shopifyFunction: { handle: PAYMENT_HANDLE },
        title: "Termwise Payment Hide",
        enabled: true,
      },
      metafieldDefinitionTaken: true,
    });
    const secondWaitUntil: Promise<unknown>[] = [];
    await runAfterAuth(DOMAIN_IDEMPOTENT, second.admin as never, (p) => {
      secondWaitUntil.push(p);
    });
    await Promise.all(secondWaitUntil);

    // No duplicate create for either Function.
    expect(second.calls.filter((c) => c.query.includes("ValidationCreate"))).toHaveLength(0);
    expect(second.calls.filter((c) => c.query.includes("PaymentCustomizationCreate"))).toHaveLength(0);
    // It did re-query existing registrations (the idempotent path).
    expect(second.calls.filter((c) => c.query.includes("GetValidations"))).toHaveLength(1);
    expect(second.calls.filter((c) => c.query.includes("GetPaymentCustomizations"))).toHaveLength(1);
    // And issued no title update because the titles already matched.
    expect(second.calls.filter((c) => c.query.includes("ValidationUpdate"))).toHaveLength(0);
    expect(second.calls.filter((c) => c.query.includes("PaymentCustomizationUpdate"))).toHaveLength(0);
  });

  it("validationCreate userErrors do not mark setup complete (no false 'protection on')", async () => {
    const { runAfterAuth, _resetSetupCacheForTesting, _isShopSetupComplete } =
      await importAfterAuth();
    _resetSetupCacheForTesting();

    const { admin, calls } = makeCapturingAdmin({
      validationUserErrors: [{ field: ["functionHandle"], message: "registration rejected" }],
    });
    const waitUntilPromises: Promise<unknown>[] = [];
    await runAfterAuth(DOMAIN_ERROR, admin as never, (p) => {
      waitUntilPromises.push(p);
    });
    await Promise.all(waitUntilPromises);

    // The install attempted the real validationCreate with the correct handle...
    const validationCreate = calls.find((c) => c.query.includes("ValidationCreate"));
    expect(validationCreate).toBeDefined();
    expect(validationCreate!.variables?.functionHandle).toBe("credit-check-validation");

    // ...but because it returned userErrors, setup is NOT marked complete. This keeps UI
    // state accurate: the Setup Guide re-queries and shows protection as still pending,
    // instead of caching a false "protection on".
    expect(_isShopSetupComplete(DOMAIN_ERROR)).toBe(false);
  });

  // The Function reads an optional `$app:hide-terms-config` metafield but the install flow is
  // designed NOT to write one, so the Function's built-in DEFAULT_DEFERRED_PATTERNS apply. This
  // drives the same real install/setup flow and asserts no captured mutation writes a metafield
  // with key "hide-terms-config" (neither a metafieldsSet input nor a definition create, nor any
  // metafield on the payment-customization mutations). It fails if such a write is ever added.
  it("install never writes a $app:hide-terms-config metafield (Function defaults apply by design)", async () => {
    const { runAfterAuth, _resetSetupCacheForTesting, _isShopSetupComplete } =
      await importAfterAuth();
    _resetSetupCacheForTesting();

    const { admin, calls } = makeCapturingAdmin();
    const waitUntilPromises: Promise<unknown>[] = [];
    await runAfterAuth(DOMAIN_HIDECONFIG, admin as never, (p) => {
      waitUntilPromises.push(p);
    });
    await Promise.all(waitUntilPromises);
    await vi.waitFor(() => expect(_isShopSetupComplete(DOMAIN_HIDECONFIG)).toBe(true));

    // The real install flow actually ran (so the absence assertions below have teeth, not a
    // vacuous pass): it registered the payment customization, created metafield definitions and
    // wrote shop_config. Any of those is where a hide-terms-config write would plausibly appear.
    expect(calls.find((c) => c.query.includes("PaymentCustomizationCreate"))).toBeDefined();
    expect(calls.find((c) => c.query.includes("MetafieldDefinitionCreate"))).toBeDefined();
    expect(calls.find((c) => c.query.includes("WriteShopConfig"))).toBeDefined();

    const HIDE_TERMS_KEY = "hide-terms-config";

    // Any metafieldsSet-style write (e.g. WriteShopConfig, or a payment-customization mutation
    // carrying a `metafields` input) must not target the hide-terms-config key.
    const metafieldWriteKeys: unknown[] = [];
    for (const call of calls) {
      const mfs = call.variables?.metafields;
      if (Array.isArray(mfs)) {
        for (const mf of mfs) {
          if (mf && typeof mf === "object" && "key" in mf) {
            metafieldWriteKeys.push((mf as { key: unknown }).key);
          }
        }
      }
    }
    expect(metafieldWriteKeys).not.toContain(HIDE_TERMS_KEY);

    // No metafield-definition create targets the hide-terms-config key either.
    const definitionKeys = calls
      .filter((c) => c.query.includes("MetafieldDefinitionCreate"))
      .map((c) => c.variables?.key);
    expect(definitionKeys).not.toContain(HIDE_TERMS_KEY);

    // Belt-and-braces: the literal key never appears as a metafield `key` anywhere in any
    // captured mutation's variables (covers any current or future write path).
    const keyAppearsAnywhere = calls.some((c) =>
      JSON.stringify(c.variables ?? {}).includes(`"key":"${HIDE_TERMS_KEY}"`),
    );
    expect(keyAppearsAnywhere).toBe(false);
  });
});
