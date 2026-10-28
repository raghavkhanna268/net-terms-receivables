/**
 * Tests for double-encoding bug on account page form submissions.
 *
 * Bug: When saving credit settings on an account with a GID-style id containing
 * '/' characters (e.g. "gid://shopify/CompanyLocation/123"), the form POST
 * URL and subsequent browser URL become double-encoded (%2F → %252F).
 *
 * This test verifies:
 * 1. Link href is correctly single-encoded
 * 2. Decoding the href recovers the original id
 * 3. React Router matchRoutes decodes params.id correctly
 * 4. Round-trip: href → matchRoutes → params.id → equals original
 * 5. normalizeParamsId only replaces %2F with /, leaves %3A and UUIDs untouched
 *
 * Coverage includes:
 * - Seeded-style IDs with embedded GIDs (contain slashes, need encoding)
 * - Real B2B CompanyLocation account IDs (UUIDs, no special chars)
 * - Real tag-rule/TAGGED_CUSTOMER account IDs (UUIDs, no special chars)
 */
import { describe, it, expect, vi } from "vitest";
import { matchRoutes, type RouteObject } from "react-router";
import { accountHref } from "~/lib/account-href";

/**
 * Narrowly-scoped normalization matching the route implementation.
 * Only replaces literal '%2F' (case-insensitive) with '/'.
 * No other decoding (no decodeURIComponent, no %3A handling).
 */
function normalizeParamsId(id: string): string {
  return id.replace(/%2f/gi, "/");
}

const SYNTHETIC_GID_ID = "gid://shopify/CompanyLocation/1001";

const SYNTHETIC_UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

const SYNTHETIC_B2B_UUID = "b2b-loc-" + SYNTHETIC_UUID;
const SYNTHETIC_TAGGED_UUID = "tag-cust-" + SYNTHETIC_UUID;
const EXPECTED_ENCODED_PATH = `/app/accounts/${encodeURIComponent(SYNTHETIC_GID_ID)}`;

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { headers: vi.fn(() => ({})) },
  ApiVersion: { October26: "2026-10" },
}));

vi.mock("@sentry/cloudflare", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  setUser: vi.fn(),
  setContext: vi.fn(),
}));

describe("Account id encoding round-trip", () => {
  describe("accountHref produces single-encoded path", () => {
    it("encodes GID-style id with slashes to single-encoded %2F", () => {
      const href = accountHref(SYNTHETIC_GID_ID);

      expect(href).toBe(EXPECTED_ENCODED_PATH);
      expect(href).toContain("%2F");
      expect(href).not.toContain("%252F");
    });

    it("decoded href matches original id", () => {
      const href = accountHref(SYNTHETIC_GID_ID);
      const pathSegment = href.split("/").pop()!;
      const decoded = decodeURIComponent(pathSegment);

      expect(decoded).toBe(SYNTHETIC_GID_ID);
    });

    it("does not double-encode already encoded characters", () => {
      const href = accountHref(SYNTHETIC_GID_ID);

      const percentCount = (href.match(/%/g) || []).length;
      const percentTwoFiveCount = (href.match(/%25/g) || []).length;

      expect(percentCount).toBeGreaterThan(0);
      expect(percentTwoFiveCount).toBe(0);
    });
  });

  describe("React Router param decoding", () => {
    const routes: RouteObject[] = [
      {
        id: "routes/app",
        path: "app",
        children: [
          { id: "routes/app.accounts.$id", path: "accounts/:id" },
          { id: "routes/app.$", path: "*" },
        ],
      },
    ];

    it("encoded href matches accounts/:id route, not catch-all", () => {
      const href = accountHref(SYNTHETIC_GID_ID);
      const matches = matchRoutes(routes, href);

      expect(matches).not.toBeNull();
      const leafMatch = matches![matches!.length - 1];
      expect(leafMatch.route.id).toBe("routes/app.accounts.$id");
    });

    it("matchRoutes decodes params.id to original value", () => {
      const href = accountHref(SYNTHETIC_GID_ID);
      const matches = matchRoutes(routes, href);

      expect(matches).not.toBeNull();
      const leafMatch = matches![matches!.length - 1];
      expect(leafMatch.params.id).toBe(SYNTHETIC_GID_ID);
    });

    it("unencoded href would match catch-all (the bug this encoding prevents)", () => {
      const unencoded = `/app/accounts/${SYNTHETIC_GID_ID}`;
      const matches = matchRoutes(routes, unencoded);

      expect(matches).not.toBeNull();
      const leafMatch = matches![matches!.length - 1];
      expect(leafMatch.route.id).toBe("routes/app.$");
    });
  });

  describe("Round-trip encoding verification", () => {
    it("link href → route match → params.id equals original id", () => {
      const originalId = SYNTHETIC_GID_ID;
      const href = accountHref(originalId);

      const routes: RouteObject[] = [
        {
          path: "app",
          children: [{ path: "accounts/:id" }],
        },
      ];

      const matches = matchRoutes(routes, href);
      expect(matches).not.toBeNull();

      const paramsId = matches![matches!.length - 1].params.id;
      expect(paramsId).toBe(originalId);
    });

    it("re-encoding decoded params.id produces original href", () => {
      const originalId = SYNTHETIC_GID_ID;
      const href = accountHref(originalId);

      const routes: RouteObject[] = [
        {
          path: "app",
          children: [{ path: "accounts/:id" }],
        },
      ];

      const matches = matchRoutes(routes, href);
      const paramsId = matches![matches!.length - 1].params.id!;

      const reconstructedHref = accountHref(paramsId);
      expect(reconstructedHref).toBe(href);
    });
  });

  describe("Form action URL stays single-encoded (root cause fix)", () => {
    it("explicit action from accountHref stays single-encoded (seeded GID)", () => {
      const formAction = accountHref(SYNTHETIC_GID_ID);

      expect(formAction).toContain("%2F");
      expect(formAction).not.toContain("%252F");
      expect(formAction).not.toContain("%25");
    });

    it("explicit action from accountHref stays single-encoded (B2B UUID)", () => {
      const formAction = accountHref(SYNTHETIC_B2B_UUID);

      expect(formAction).toBe(`/app/accounts/${SYNTHETIC_B2B_UUID}`);
      expect(formAction).not.toContain("%");
    });

    it("explicit action from accountHref stays single-encoded (tag-rule UUID)", () => {
      const formAction = accountHref(SYNTHETIC_TAGGED_UUID);

      expect(formAction).toBe(`/app/accounts/${SYNTHETIC_TAGGED_UUID}`);
      expect(formAction).not.toContain("%");
    });

    it("POST to explicit action URL preserves params.id correctly", () => {
      const routes: RouteObject[] = [
        { path: "app", children: [{ path: "accounts/:id" }] },
      ];

      const formAction = accountHref(SYNTHETIC_GID_ID);
      const postUrl = new URL(formAction, "https://example.com");
      const matches = matchRoutes(routes, postUrl.pathname);

      expect(matches).not.toBeNull();
      expect(matches![matches!.length - 1].params.id).toBe(SYNTHETIC_GID_ID);
    });

    it("URL object does not double-encode explicit action path", () => {
      const formAction = accountHref(SYNTHETIC_GID_ID);
      const url = new URL(formAction, "https://example.com");

      expect(url.pathname).toBe(formAction);
      expect(url.pathname).toContain("%2F");
      expect(url.pathname).not.toContain("%252F");
    });
  });

  describe("normalizeParamsId: narrowly-scoped %2F normalization", () => {
    it("replaces %2F with / (lowercase)", () => {
      const withEncodedSlash = "gid%3A%2F%2Fshopify%2FCompanyLocation%2F1001";
      const normalized = normalizeParamsId(withEncodedSlash);

      expect(normalized).toBe("gid%3A//shopify/CompanyLocation/1001");
      expect(normalized).toContain("/");
      expect(normalized).not.toContain("%2F");
    });

    it("replaces %2f with / (lowercase variant)", () => {
      const withEncodedSlash = "test%2fpath%2fhere";
      const normalized = normalizeParamsId(withEncodedSlash);

      expect(normalized).toBe("test/path/here");
    });

    it("does NOT replace %3A (colon stays encoded)", () => {
      const withEncodedColon = "gid%3A%2F%2Fshopify";
      const normalized = normalizeParamsId(withEncodedColon);

      expect(normalized).toContain("%3A");
      expect(normalized).toBe("gid%3A//shopify");
    });

    it("leaves UUID id completely untouched", () => {
      expect(normalizeParamsId(SYNTHETIC_B2B_UUID)).toBe(SYNTHETIC_B2B_UUID);
      expect(normalizeParamsId(SYNTHETIC_TAGGED_UUID)).toBe(SYNTHETIC_TAGGED_UUID);
      expect(normalizeParamsId(SYNTHETIC_UUID)).toBe(SYNTHETIC_UUID);
    });

    it("leaves already-decoded GID-style id unchanged", () => {
      expect(normalizeParamsId(SYNTHETIC_GID_ID)).toBe(SYNTHETIC_GID_ID);
    });
  });

  describe("Double-encoded URL loads with params.id normalized", () => {
    it("seeded-style id: params.id with leftover %2F → normalizeParamsId restores slashes", () => {
      const paramsIdWithEncodedSlash = "gid%3A%2F%2Fshopify%2FCompanyLocation%2F1001";

      const normalized = normalizeParamsId(paramsIdWithEncodedSlash);

      expect(normalized).toBe("gid%3A//shopify/CompanyLocation/1001");
      expect(normalized).toContain("/");
      expect(normalized).not.toContain("%2F");
      expect(normalized).toContain("%3A");
    });

    it("seeded-style id with embedded GID: normalize restores slashes only, %3A stays", () => {
      const paramsIdWithEncodedSlash = "seed-account-shop123-gid%3A%2F%2Fshopify%2FCompanyLocation%2F1001";

      const normalized = normalizeParamsId(paramsIdWithEncodedSlash);

      expect(normalized).toBe("seed-account-shop123-gid%3A//shopify/CompanyLocation/1001");
      expect(normalized).not.toContain("%2F");
      expect(normalized).toContain("%3A");
    });

    it("UUID id: normalizeParamsId leaves unchanged (no %2F present)", () => {
      const normalized = normalizeParamsId(SYNTHETIC_B2B_UUID);

      expect(normalized).toBe(SYNTHETIC_B2B_UUID);
    });

    it("tag-rule UUID: remains completely unchanged through normalization", () => {
      const normalized = normalizeParamsId(SYNTHETIC_TAGGED_UUID);

      expect(normalized).toBe(SYNTHETIC_TAGGED_UUID);
    });

    it("case-insensitive: %2f and %2F both become /", () => {
      const mixedCase = "path%2Fwith%2flower%2Fand%2FUPPER";
      const normalized = normalizeParamsId(mixedCase);

      expect(normalized).toBe("path/with/lower/and/UPPER");
      expect(normalized).not.toContain("%2");
    });
  });

  describe("Real B2B CompanyLocation account (UUID-style id)", () => {
    it("UUID id does not contain special URL characters", () => {
      expect(SYNTHETIC_B2B_UUID).not.toContain("/");
      expect(SYNTHETIC_B2B_UUID).not.toContain(":");
      expect(SYNTHETIC_B2B_UUID).not.toContain("%");
    });

    it("accountHref produces clean path for UUID id", () => {
      const href = accountHref(SYNTHETIC_B2B_UUID);
      expect(href).toBe(`/app/accounts/${SYNTHETIC_B2B_UUID}`);
      expect(href).not.toContain("%");
    });

    it("round-trip: UUID id survives href → route match → params.id", () => {
      const routes: RouteObject[] = [
        { path: "app", children: [{ path: "accounts/:id" }] },
      ];

      const href = accountHref(SYNTHETIC_B2B_UUID);
      const matches = matchRoutes(routes, href);

      expect(matches).not.toBeNull();
      expect(matches![matches!.length - 1].params.id).toBe(SYNTHETIC_B2B_UUID);
    });

    it("normalizeParamsId returns UUID id unchanged", () => {
      expect(normalizeParamsId(SYNTHETIC_B2B_UUID)).toBe(SYNTHETIC_B2B_UUID);
    });
  });

  describe("Real tag-rule/TAGGED_CUSTOMER account (UUID-style id)", () => {
    it("UUID id does not contain special URL characters", () => {
      expect(SYNTHETIC_TAGGED_UUID).not.toContain("/");
      expect(SYNTHETIC_TAGGED_UUID).not.toContain(":");
      expect(SYNTHETIC_TAGGED_UUID).not.toContain("%");
    });

    it("accountHref produces clean path for UUID id", () => {
      const href = accountHref(SYNTHETIC_TAGGED_UUID);
      expect(href).toBe(`/app/accounts/${SYNTHETIC_TAGGED_UUID}`);
      expect(href).not.toContain("%");
    });

    it("round-trip: UUID id survives href → route match → params.id", () => {
      const routes: RouteObject[] = [
        { path: "app", children: [{ path: "accounts/:id" }] },
      ];

      const href = accountHref(SYNTHETIC_TAGGED_UUID);
      const matches = matchRoutes(routes, href);

      expect(matches).not.toBeNull();
      expect(matches![matches!.length - 1].params.id).toBe(SYNTHETIC_TAGGED_UUID);
    });

    it("normalizeParamsId returns UUID id unchanged", () => {
      expect(normalizeParamsId(SYNTHETIC_TAGGED_UUID)).toBe(SYNTHETIC_TAGGED_UUID);
    });
  });
});
