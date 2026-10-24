import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const PRIVACY_MD_PATH = resolve(ROOT, "docs/privacy.md");
const TOML_PATH = resolve(ROOT, "shopify.app.toml");

function extractTomlScopes(content: string): string[] {
  const match = content.match(/^scopes\s*=\s*"([^"]*)"/m);
  if (!match) {
    throw new Error("Could not parse scopes from shopify.app.toml");
  }
  return match[1].split(",").map((s) => s.trim()).filter(Boolean).sort();
}

function extractPrivacyScopes(content: string): string[] {
  const beginMarker = "<!-- PRIVACY_SCOPES_BEGIN -->";
  const endMarker = "<!-- PRIVACY_SCOPES_END -->";

  const beginIndex = content.indexOf(beginMarker);
  const endIndex = content.indexOf(endMarker);

  if (beginIndex === -1 || endIndex === -1) {
    throw new Error(
      "Could not find PRIVACY_SCOPES_BEGIN/END markers in docs/privacy.md"
    );
  }

  const scopeSection = content.slice(
    beginIndex + beginMarker.length,
    endIndex
  );

  const scopeRegex = /\| `([a-z_]+)` \|/g;
  const scopes: string[] = [];
  let match;
  while ((match = scopeRegex.exec(scopeSection)) !== null) {
    scopes.push(match[1]);
  }

  return scopes.sort();
}

function extractTbdPlaceholders(content: string): string[] {
  const regex = /\[TBD:[^\]]+\]/g;
  const matches = content.match(regex);
  return matches ?? [];
}

describe("docs/privacy.md scope sync", () => {
  const privacyContent = readFileSync(PRIVACY_MD_PATH, "utf-8");
  const tomlContent = readFileSync(TOML_PATH, "utf-8");

  it("lists all scopes from shopify.app.toml", () => {
    const tomlScopes = extractTomlScopes(tomlContent);
    const privacyScopes = extractPrivacyScopes(privacyContent);

    expect(privacyScopes).toEqual(tomlScopes);
  });

  it("has no extra scopes beyond shopify.app.toml", () => {
    const tomlScopes = new Set(extractTomlScopes(tomlContent));
    const privacyScopes = extractPrivacyScopes(privacyContent);

    const extraScopes = privacyScopes.filter((s) => !tomlScopes.has(s));
    expect(extraScopes).toEqual([]);
  });

  it("has no missing scopes from shopify.app.toml", () => {
    const tomlScopes = extractTomlScopes(tomlContent);
    const privacyScopes = new Set(extractPrivacyScopes(privacyContent));

    const missingScopes = tomlScopes.filter((s) => !privacyScopes.has(s));
    expect(missingScopes).toEqual([]);
  });

  it("has exactly 11 scopes", () => {
    const tomlScopes = extractTomlScopes(tomlContent);
    const privacyScopes = extractPrivacyScopes(privacyContent);

    expect(tomlScopes.length).toBe(11);
    expect(privacyScopes.length).toBe(11);
  });
});

describe("docs/privacy.md TBD placeholders", () => {
  const privacyContent = readFileSync(PRIVACY_MD_PATH, "utf-8");

  const expectedTbdPlaceholders = [
    "[TBD: effective date]",
    "[TBD: effective date]",
    "[TBD: legal entity]",
    "[TBD: contact email]",
    "[TBD: legal entity]",
    "[TBD: DPA]",
    "[TBD: DPA]",
    "[TBD: contact email]",
    "[TBD: legal entity]",
  ];

  it("has exactly 9 TBD placeholders", () => {
    const tbdPlaceholders = extractTbdPlaceholders(privacyContent);
    expect(tbdPlaceholders.length).toBe(9);
  });

  it("preserves all TBD placeholders unchanged", () => {
    const tbdPlaceholders = extractTbdPlaceholders(privacyContent);
    expect(tbdPlaceholders).toEqual(expectedTbdPlaceholders);
  });
});
