#!/usr/bin/env python3
"""Pre-release guards for the Shopify app release workflow (no network, no secrets).

Checks (any failure exits non-zero):
  1. scopes: shopify.app.toml [access_scopes].scopes == wrangler.jsonc vars.SCOPES
     == APPROVED_SCOPES (exact set equality, no duplicates).
  2. client_id: shopify.app.toml client_id == EXPECTED_CLIENT_ID, and no other
     shopify.app.*.toml config exists (dev store / current config only).
  3. input queries: no extension input query requests customer PII fields
     (email, phone, name, address) or any address-like field anywhere.
  4. extensions: handles in extensions/*/shopify.extension.toml == the committed
     scripts/ci/expected-extensions.txt (deployed set). A deployed extension
     missing from the repo would be DELETED by `app deploy`, so this hard-fails.
  5. release workflow flags: shopify-app-release.yml must never use
     --allow-deletes / SHOPIFY_FLAG_ALLOW_DELETES / --force.

Prints only booleans, counts and scope names (scope names are public config).
Usage: shopify_release_guards.py [repo_root]
"""
import glob
import json
import os
import re
import sys

APPROVED_SCOPES = {
    # S24: Dropped read_companies, read_customers, read_orders (implied by write_* scopes).
    # See https://shopify.dev/docs/api/usage/access-scopes 'How it works':
    # "Any scope that writes a resource also grants read access to it."
    "read_draft_orders", "read_payment_terms",
    "write_companies", "write_customers",
    "write_merchant_managed_fulfillment_orders", "write_orders",
    "write_payment_customizations", "write_validations",
}
EXPECTED_CLIENT_ID = "dbfae79a0ca15489c7467598bce10965"

# Fields that must never appear anywhere in a function input query.
DENY_ANYWHERE = {
    "phone", "address", "address1", "address2", "addresses", "defaultAddress",
    "billingAddress", "shippingAddress", "deliveryAddress", "city", "zip",
    "province", "provinceCode", "country", "countryCode", "firstName", "lastName",
}
# Fields that must not be selected directly inside a customer/buyer block.
DENY_IN_CUSTOMER = {"email", "phone", "name", "displayName", "firstName", "lastName"}
CUSTOMER_BLOCKS = {"customer", "buyerIdentity", "purchasingCompany", "company", "contact"}


def parse_toml_scopes(text):
    m = re.search(r'^\s*scopes\s*=\s*"([^"]*)"', text, re.M)
    if not m:
        return None
    return [s.strip() for s in m.group(1).split(",") if s.strip()]


def parse_toml_client_id(text):
    m = re.search(r'^\s*client_id\s*=\s*"([^"]*)"', text, re.M)
    return m.group(1) if m else None


def parse_wrangler_scopes(text):
    m = re.search(r'"SCOPES"\s*:\s*"([^"]*)"', text)
    if not m:
        return None
    return [s.strip() for s in m.group(1).split(",") if s.strip()]


def strip_graphql(text):
    text = re.sub(r"#[^\n]*", "", text)
    text = re.sub(r'"(?:\\.|[^"\\])*"', '""', text)  # drop string literals (e.g. "$app")
    text = re.sub(r"\([^()]*\)", "", text)  # drop argument lists
    return text


def check_input_query(text):
    """Return a list of (field, context) violations."""
    t = strip_graphql(text)
    tokens = re.findall(r"[A-Za-z_][A-Za-z0-9_]*|[{}]", t)
    stack, violations, prev = [], [], None
    for tok in tokens:
        if tok == "{":
            stack.append(prev or "")
        elif tok == "}":
            if stack:
                stack.pop()
        else:
            if tok in ("query", "fragment", "on", "Input"):
                prev = tok
                continue
            if tok in DENY_ANYWHERE:
                violations.append((tok, "/".join(stack)))
            elif tok in DENY_IN_CUSTOMER and stack and stack[-1] in CUSTOMER_BLOCKS:
                violations.append((tok, "/".join(stack)))
            prev = tok
    return violations


def input_query_files(root):
    files = set()
    for toml in glob.glob(os.path.join(root, "extensions", "*", "shopify.extension.toml")):
        d = os.path.dirname(toml)
        for m in re.finditer(r'input_query\s*=\s*"([^"]+)"', open(toml).read()):
            files.add(os.path.normpath(os.path.join(d, m.group(1))))
    for f in glob.glob(os.path.join(root, "extensions", "**", "*.graphql"), recursive=True):
        if os.path.basename(f) != "schema.graphql" and "/node_modules/" not in f and "/target/" not in f:
            files.add(os.path.normpath(f))
    return sorted(files)


def repo_extension_handles(root):
    handles = []
    for toml in sorted(glob.glob(os.path.join(root, "extensions", "*", "shopify.extension.toml"))):
        handles += re.findall(r'^\s*handle\s*=\s*"([^"]+)"', open(toml).read(), re.M)
    return handles


def expected_extension_handles(root):
    path = os.path.join(root, "scripts", "ci", "expected-extensions.txt")
    if not os.path.exists(path):
        return None
    return [l.strip() for l in open(path) if l.strip() and not l.strip().startswith("#")]


FORBIDDEN_DEPLOY_FLAGS = ("--allow-deletes", "SHOPIFY_FLAG_ALLOW_DELETES", "--force", "SHOPIFY_FLAG_FORCE")
# The CLI must come from the lockfile (devDependency), never an ad-hoc npx download.
FORBIDDEN_CLI_SOURCES = ("npx -y", "npx --yes", "@shopify/cli@")
PINNED_CLI_VERSION = "4.9.4"


def main(root):
    ok = True
    app_toml = open(os.path.join(root, "shopify.app.toml")).read()
    wrangler = open(os.path.join(root, "wrangler.jsonc")).read()

    toml_scopes = parse_toml_scopes(app_toml)
    wr_scopes = parse_wrangler_scopes(wrangler)
    if toml_scopes is None or wr_scopes is None:
        print("scope_guard: FAIL (scopes not found in shopify.app.toml or wrangler.jsonc)")
        return 1
    dup = len(toml_scopes) != len(set(toml_scopes))
    t, w = set(toml_scopes), set(wr_scopes)
    print(f"scope_guard: toml_count={len(toml_scopes)} wrangler_count={len(wr_scopes)} "
          f"approved_count={len(APPROVED_SCOPES)} duplicates={str(dup).lower()}")
    for label, extra in (("toml_not_approved", t - APPROVED_SCOPES), ("approved_not_in_toml", APPROVED_SCOPES - t),
                         ("toml_vs_wrangler_diff", t ^ w)):
        if extra:
            print(f"scope_guard: {label}={','.join(sorted(extra))}")
    if dup or t != APPROVED_SCOPES or t != w:
        print("scope_guard: FAIL")
        ok = False
    else:
        print(f"scope_guard: PASS (toml == wrangler SCOPES == approved {len(APPROVED_SCOPES)})")

    cid = parse_toml_client_id(app_toml)
    others = [os.path.basename(p) for p in glob.glob(os.path.join(root, "shopify.app.*.toml"))]
    cid_ok = cid == EXPECTED_CLIENT_ID
    print(f"config_guard: client_id_matches_pinned={str(cid_ok).lower()} other_app_configs={len(others)}")
    if not cid_ok or others:
        print("config_guard: FAIL")
        ok = False
    else:
        print("config_guard: PASS")

    files = input_query_files(root)
    total = 0
    for f in files:
        v = check_input_query(open(f).read())
        total += len(v)
        for field, ctx in v:
            print(f"pii_guard: violation file={os.path.relpath(f, root)} field={field} path={ctx}")
    print(f"pii_guard: files_checked={len(files)} violations={total}")
    if not files:
        print("pii_guard: FAIL (no input queries found)")
        ok = False
    elif total:
        print("pii_guard: FAIL")
        ok = False
    else:
        print("pii_guard: PASS")
    repo_h, exp_h = repo_extension_handles(root), expected_extension_handles(root)
    if exp_h is None:
        print("extension_guard: FAIL (scripts/ci/expected-extensions.txt missing)")
        ok = False
    else:
        missing, unexpected = sorted(set(exp_h) - set(repo_h)), sorted(set(repo_h) - set(exp_h))
        dup = len(repo_h) != len(set(repo_h))
        print(f"extension_guard: repo_count={len(repo_h)} expected_count={len(exp_h)} "
              f"missing_from_repo={','.join(missing) or 'none'} not_in_expected={','.join(unexpected) or 'none'} "
              f"duplicate_handles={str(dup).lower()}")
        if missing or unexpected or dup:
            print("extension_guard: FAIL")
            ok = False
        else:
            print("extension_guard: PASS")

    wf = os.path.join(root, ".github", "workflows", "shopify-app-release.yml")
    if os.path.exists(wf):
        body = "\n".join(l for l in open(wf).read().splitlines() if not l.lstrip().startswith("#"))
        bad = [f for f in FORBIDDEN_DEPLOY_FLAGS if f in body]
        print(f"deploy_flags_guard: forbidden_flags={','.join(bad) or 'none'}")
        if bad:
            print("deploy_flags_guard: FAIL")
            ok = False
        else:
            print("deploy_flags_guard: PASS")

        # CLI 4.9.4: the preview flag and the allow-updates flag are mutually exclusive
        # (oclif exit 2), so neither may sit in the shared base args of the deploy command.
        base = re.search(r"args=\(app deploy[^)]*\)", body)
        base_bad = base is None or "--allow-updates" in base.group(0) or "--no-release" in base.group(0)
        same_line = any("--allow-updates" in l and "--no-release" in l for l in body.splitlines())
        print(f"exclusive_flags_guard: base_args_found={str(base is not None).lower()} "
              f"release_flag_in_base_args={str(base_bad).lower()} both_on_one_line={str(same_line).lower()}")
        if base_bad or same_line:
            print("exclusive_flags_guard: FAIL")
            ok = False
        else:
            print("exclusive_flags_guard: PASS")

        # Pipefail: every run step must use bash (-eo pipefail) so `| tee` cannot mask failures.
        has_bash_default = re.search(r"^    defaults:\n      run:\n        shell: bash\s*$", body, re.M) is not None
        print(f"pipefail_guard: job_default_shell_bash={str(has_bash_default).lower()}")
        if not has_bash_default:
            print("pipefail_guard: FAIL")
            ok = False
        else:
            print("pipefail_guard: PASS")

        bad_src = [f for f in FORBIDDEN_CLI_SOURCES if f in body]
        pkg_path = os.path.join(root, "package.json")
        pinned = None
        if os.path.exists(pkg_path):
            pinned = json.load(open(pkg_path)).get("devDependencies", {}).get("@shopify/cli")
        pin_ok = pinned == PINNED_CLI_VERSION
        print(f"cli_pin_guard: devdependency_exact={str(pin_ok).lower()} adhoc_npx={str(bool(bad_src)).lower()}")
        if bad_src or not pin_ok:
            print("cli_pin_guard: FAIL")
            ok = False
        else:
            print("cli_pin_guard: PASS")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "."))
