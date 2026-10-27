/**
 * Timezone rendering tests for Tag Rules page created dates.
 *
 * Verifies that tag rule created dates in TagRuleTable render using
 * the shop's timezone, not a hard-coded fallback.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement, type ReactNode } from "react";

vi.mock("react-router", async () => {
  return {
    useLoaderData: vi.fn(),
    useActionData: vi.fn(() => undefined),
    useNavigation: vi.fn(() => ({ state: "idle", formData: null })),
    data: vi.fn((d) => d),
    Form: ({ children, ...props }: { children: ReactNode; method?: string }) =>
      createElement("form", props, children),
  };
});

import { useLoaderData } from "react-router";
import TagRulesPage from "../app.tag-rules";

const mockUseLoaderData = vi.mocked(useLoaderData);

function buildLoaderData(overrides: {
  shopTimezone?: string;
  createdAt?: string;
} = {}) {
  const {
    shopTimezone = "Asia/Kolkata",
    createdAt = "2026-11-27T04:59:59.999Z",
  } = overrides;

  return {
    storeMode: "tag_based" as const,
    tagRules: [
      {
        id: "rule-1",
        tag: "net-30",
        defaultTermsDays: 30,
        createdAt,
      },
    ],
    shopId: "shop-1",
    shopTimezone,
    error: null,
    finishingSetup: false,
    notSupported: false,
    storeSetupStatus: "supported" as const,
    newAccountsPausedBanner: {
      show: false,
      heading: "",
      bodyText: "",
      upgradeUrl: null,
    },
  };
}

describe("TagRules TagRuleTable timezone rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("America/New_York: end-of-day 26 Nov EST → renders 26/11", () => {
    const loaderData = buildLoaderData({
      shopTimezone: "America/New_York",
      createdAt: "2026-11-27T04:59:59.999Z",
    });
    mockUseLoaderData.mockReturnValue(loaderData);

    const html = renderToString(createElement(TagRulesPage));

    expect(html).toContain("26/11/2026");
    expect(html).not.toContain("27/11/2026");
  });

  it("Asia/Kolkata: same instant → renders 27/11", () => {
    const loaderData = buildLoaderData({
      shopTimezone: "Asia/Kolkata",
      createdAt: "2026-11-27T04:59:59.999Z",
    });
    mockUseLoaderData.mockReturnValue(loaderData);

    const html = renderToString(createElement(TagRulesPage));

    expect(html).toContain("27/11/2026");
  });
});
