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
 */
import { describe, it, expect, vi } from "vitest";
import { matchRoutes, type RouteObject } from "react-router";
import { accountHref } from "~/lib/account-href";

const SYNTHETIC_GID_ID = "gid://shopify/CompanyLocation/1001";
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

  describe("Form action URL encoding (simulated)", () => {
    it("Form action from encoded URL maintains single encoding", () => {
      const encodedPath = EXPECTED_ENCODED_PATH;
      const url = new URL(`https://example.com${encodedPath}`);

      expect(url.pathname).toBe(encodedPath);
      expect(url.pathname).toContain("%2F");
      expect(url.pathname).not.toContain("%252F");
    });

    it("params.id from POST request matches original id", () => {
      const routes: RouteObject[] = [
        {
          path: "app",
          children: [{ path: "accounts/:id" }],
        },
      ];

      const postUrl = `https://example.com${EXPECTED_ENCODED_PATH}`;
      const matches = matchRoutes(routes, new URL(postUrl).pathname);

      expect(matches).not.toBeNull();
      expect(matches![matches!.length - 1].params.id).toBe(SYNTHETIC_GID_ID);
    });

    it("POST URL pathname stays single-encoded when constructed from location", () => {
      const browserLocation = EXPECTED_ENCODED_PATH;

      const postUrl = new URL(browserLocation, "https://example.com");

      expect(postUrl.pathname).toBe(EXPECTED_ENCODED_PATH);
      expect(postUrl.pathname).not.toContain("%252F");
    });
  });

  describe("Double-encoding detection", () => {
    it("detects double-encoded URL (%252F)", () => {
      const doubleEncoded = `/app/accounts/${encodeURIComponent(encodeURIComponent(SYNTHETIC_GID_ID))}`;

      expect(doubleEncoded).toContain("%252F");
      expect(doubleEncoded).not.toEqual(EXPECTED_ENCODED_PATH);
    });

    it("single decodeURIComponent on double-encoded URL produces encoded URL", () => {
      const doubleEncoded = `/app/accounts/${encodeURIComponent(encodeURIComponent(SYNTHETIC_GID_ID))}`;
      const pathSegment = doubleEncoded.split("/").pop()!;
      const onceDecoded = decodeURIComponent(pathSegment);

      expect(onceDecoded).toBe(encodeURIComponent(SYNTHETIC_GID_ID));
      expect(onceDecoded).not.toBe(SYNTHETIC_GID_ID);
    });

    it("URL path with %252F results in params.id that still contains encoded chars", () => {
      const routes: RouteObject[] = [
        {
          path: "app",
          children: [{ path: "accounts/:id" }],
        },
      ];

      const doubleEncodedPath = `/app/accounts/${encodeURIComponent(encodeURIComponent(SYNTHETIC_GID_ID))}`;
      const matches = matchRoutes(routes, doubleEncodedPath);

      expect(matches).not.toBeNull();
      const paramsId = matches![matches!.length - 1].params.id;

      expect(paramsId).not.toBe(SYNTHETIC_GID_ID);
      expect(paramsId).toContain("%3A");
    });
  });
});
