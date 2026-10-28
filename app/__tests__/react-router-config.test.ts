/**
 * Tests for react-router.config.ts settings.
 *
 * Verifies that routeDiscovery is set to "initial" mode, which ships the full
 * route manifest with the initial document response. This eliminates mid-session
 * /__manifest fetches that cause navigation failures during deploys when the
 * Worker version changes but the client still holds an older manifest version.
 */
import { describe, it, expect } from "vitest";
import config from "../../react-router.config";

describe("react-router.config.ts", () => {
  it('routeDiscovery.mode is set to "initial"', () => {
    expect(config.routeDiscovery).toBeDefined();
    expect(config.routeDiscovery?.mode).toBe("initial");
  });

  it("ssr is enabled", () => {
    expect(config.ssr).toBe(true);
  });

  it("buildDirectory is dist", () => {
    expect(config.buildDirectory).toBe("dist");
  });
});
