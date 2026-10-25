#!/usr/bin/env python3
"""Stub-CLI self-test for the 'Deploy app version' step of shopify-app-release.yml.

Runs the step's real bash body against a fake `shopify` that prints an info box
(Org/App names, email, shop domain, URL) plus an error box, and asserts:
  - none of the CLI text reaches stdout or $GITHUB_STEP_SUMMARY
  - deploy_error_class is computed from the raw log into the fixed enum
  - preview passes --no-release only, release passes --allow-updates only
Fake values only; nothing talks to Shopify.
"""
import os
import re
import stat
import subprocess
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
WF = os.path.join(ROOT, ".github", "workflows", "shopify-app-release.yml")
ENUM = {"none", "flag_or_args", "auth", "api_5xx", "network", "config", "unknown"}

INFO_BOX = """\
\u256d\u2500 info \u2500\u2500\u2500\u2500\u256e
\u2502  Using shopify.app.toml for default values:   \u2502
\u2502    \u2022 Org:             Jane Doe                \u2502
\u2502    \u2022 App:             Secret Project App      \u2502
\u2502    \u2022 Dev store:       jane-test-shop.myshopify.com \u2502
\u2502  Contact jane.doe@example.com https://partners.example.invalid/x \u2502
\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u256f
"""
SECRET_BITS = ["Jane", "Doe", "Secret Project", "jane-test-shop", "example.com", "example.invalid",
               "Org:", "App:", "\u256d", "\u2502", "\u2570", "SECRETERRTEXT", "following error", "args:",
               "not-a-real-token"]


def step_body():
    y = open(WF).read()
    i = y.index("- name: Deploy app version (shopify app deploy)")
    r = y.index("run: |", i)
    e = y.index("\n      - name: ", r)  # next step
    lines = y[r + len("run: |"):e].splitlines()[1:]
    return "\n".join(l[10:] if l.startswith(" " * 10) else l.strip() for l in lines) + "\n"


def run_case(release, error_lines, exit_code):
    d = tempfile.mkdtemp()
    os.makedirs(os.path.join(d, "node_modules", ".bin"))
    stub = os.path.join(d, "node_modules", ".bin", "shopify")
    err = "".join(f"\u2502  {l} \u2502\n" for l in error_lines)
    with open(stub, "w") as f:
        f.write("#!/bin/bash\n")
        f.write('echo "$*" > "$(dirname "$0")/args.txt"\n')
        f.write("cat <<'EOF'\n" + INFO_BOX + "\u256d\u2500 error \u2500\u256e\n" + err + "\u2570\u2500\u2500\u256f\nEOF\n")
        f.write(f"exit {exit_code}\n")
    os.chmod(stub, os.stat(stub).st_mode | stat.S_IEXEC)
    open(os.path.join(d, "step.sh"), "w").write(step_body())
    summary = os.path.join(d, "summary.md")
    env = dict(os.environ, RUNNER_TEMP=d, GITHUB_STEP_SUMMARY=summary,
               SHOPIFY_APP_AUTOMATION_TOKEN="not-a-real-token-value",
               RELEASE=release, HAS_MESSAGE="true", VERSION_MESSAGE="S12 test",
               SOURCE_URL="https://github.com/example/repo/commit/abc", VERSION_TAG="ci-123-1")
    p = subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", "step.sh"], cwd=d, env=env,
                       capture_output=True, text=True)
    out = p.stdout.replace("::add-mask::not-a-real-token-value", "")
    summ = open(summary).read() if os.path.exists(summary) else ""
    args = open(os.path.join(d, "node_modules", ".bin", "args.txt")).read()
    m = re.search(r"^deploy_error_class=(\S+)$", out, re.M)
    return p.returncode, out + p.stderr, summ, args, (m.group(1) if m else None)


CASES = [
    # (name, release, error lines, stub exit, expected class, expected step rc)
    ("flag", "false", ["The following error occurred:", "--allow-updates=true cannot also be provided when using --no-release SECRETERRTEXT"], 2, "flag_or_args", 2),
    ("auth", "false", ["Unauthorized: invalid token for Jane Doe SECRETERRTEXT"], 1, "auth", 1),
    ("5xx", "true", ["Request failed with status code 503 SECRETERRTEXT"], 1, "api_5xx", 1),
    ("network", "false", ["request to x failed, reason: getaddrinfo ENOTFOUND SECRETERRTEXT"], 1, "network", 1),
    ("config", "false", ["Could not find a Shopify app configuration file. SECRETERRTEXT"], 1, "config", 1),
    # 3-digit numbers starting with 5 and long ids must not be misread as api_5xx / auth.
    ("unknown", "false", ["Extension build 512 took 5123ms id 0123456789abcdef0123456789abcdef SECRETERRTEXT"], 1, "unknown", 1),
    ("success", "false", [], 0, "none", 0),
]


def main():
    fails = []
    for name, release, lines, code, want, want_rc in CASES:
        rc, out, summ, args, cls = run_case(release, lines, code)
        leaked = [b for b in SECRET_BITS if b in out or b in summ]
        if leaked:
            fails.append(f"{name}: CLI text leaked ({len(leaked)} markers)")
        if cls != want or cls not in ENUM:
            fails.append(f"{name}: class={cls} want={want}")
        if f"deploy_error_class: `{want}`" not in summ:
            fails.append(f"{name}: class missing from summary")
        if rc != want_rc or f"deploy_exit_code={want_rc}" not in out:
            fails.append(f"{name}: rc={rc} want={want_rc}")
        has_ver = "version_label=ci-123-1" in out and "version_label: `ci-123-1`" in summ
        if has_ver != (want_rc == 0):
            fails.append(f"{name}: version_label presence wrong")
        flags = args.split()
        if release == "true":
            if "--allow-updates" not in flags or "--no-release" in flags:
                fails.append(f"{name}: release args wrong")
        elif "--no-release" not in flags or "--allow-updates" in flags:
            fails.append(f"{name}: preview args wrong")
        if any(f in flags for f in ("--allow-deletes", "--force")):
            fails.append(f"{name}: forbidden flag passed")
        allowed = re.compile(r"^(token_present=true|release=(true|false)|deploy_error_class=[a-z0-9_]+|"
                             r"extension_removal_detected=(true|false)|deploy_exit_code=[0-9]+|version_label=ci-[0-9]+-[0-9]+)?$")
        bad_lines = [l for l in out.splitlines() if not allowed.match(l)]
        if bad_lines:
            fails.append(f"{name}: {len(bad_lines)} non-allowlisted stdout line(s)")
    if fails:
        print("shopify deploy step self-test: FAIL")
        for f in fails:
            print(" -", f)
        return 1
    print(f"shopify deploy step self-test: OK ({len(CASES)}/{len(CASES)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
