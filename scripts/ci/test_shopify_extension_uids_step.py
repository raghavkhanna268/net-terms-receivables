#!/usr/bin/env python3
"""Self-test for the 'Print extension uids' step of shopify-app-release.yml.

Runs the step's real bash body in a scratch git repo whose extension tomls carry
fake names/descriptions (must never be printed) and asserts:
  - the step only runs after a successful deploy step (if: + id: deploy)
  - stdout carries ONLY `extension handle=<id> uid=<id|none|invalid> uid_committed=<bool>`
    lines and `extension_count=<n>`; nothing else from the toml
  - a uid written by the CLI after checkout (not in HEAD) reads uid_committed=false,
    a committed uid reads true, a missing uid reads none, junk values read invalid
  - the repo's committed credit-check-validation uid equals the CLI 4.9.4 name-based
    derivation from the handle (evidence the uid is deterministic per handle)
Fake values only; nothing talks to Shopify.
"""
import hashlib
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
WF = os.path.join(ROOT, ".github", "workflows", "shopify-app-release.yml")
STEP = "- name: Print extension uids (handle + uid only)"
SECRET = "SECRET_TOML_TEXT_q7"


def cli_uid(handle):
    # Shopify CLI 4.9.4 (chunk HILYTMVA `p`, used by buildUIDFromStrategy for uidStrategy "uuid"):
    # sha1(namespace 6ba7b810-9dad-11d1-80b4-00c04fd430c8 bytes + handle), hex, first 32 chars
    # grouped 8-4-4-4-12, remaining 8 hex chars appended.
    d = hashlib.sha1(bytes.fromhex("6ba7b8109dad11d180b400c04fd430c8") + handle.encode()).hexdigest()
    return re.sub(r"(.{8})(.{4})(.{4})(.{4})(.{12})", r"\1-\2-\3-\4-\5", d, count=1)


def step_block():
    y = open(WF).read()
    i = y.index(STEP)
    e = y.index("\n      - name: ", i + len(STEP))
    return y[i:e]


def step_body(block):
    r = block.index("run: |")
    lines = block[r + len("run: |"):].splitlines()[1:]
    return "\n".join(l[10:] if l.startswith(" " * 10) else l.strip() for l in lines) + "\n"


def toml(handle_line, uid_line=None):
    out = ['api_version = "2026-10"', "", "[[extensions]]", f'name = "Name {SECRET}"', handle_line]
    if uid_line:
        out.append(uid_line)
    out += ['type = "function"', f'description = "{SECRET} jane@example.com"', "",
            "  [[extensions.targeting]]", 'target = "cart.validations.generate.run"', ""]
    return "\n".join(out)


def git(d, *args):
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=d, check=True,
                   capture_output=True)


def main():
    fails = []
    y = open(WF).read()
    block = step_block()
    if "if: success() && steps.deploy.outcome == 'success'" not in block:
        fails.append("step is not gated on a successful deploy step")
    dep = y.index("- name: Deploy app version (shopify app deploy)")
    if not re.match(r"- name: Deploy app version \(shopify app deploy\)\n\s+id: deploy\n", y[dep:]):
        fails.append("deploy step has no id: deploy")
    if y.index(STEP) < dep:
        fails.append("uid step must come after the deploy step")
    if re.search(r"git (commit|push|add)\b", block):
        fails.append("uid step must not commit back")

    # Committed uid of the real repo matches the CLI derivation.
    real = open(os.path.join(ROOT, "extensions", "credit-check-validation", "shopify.extension.toml")).read()
    m = re.search(r'^\s*uid\s*=\s*"([^"]+)"', real, re.M)
    if not m or m.group(1) != cli_uid("credit-check-validation"):
        fails.append("committed credit-check-validation uid != CLI name-based derivation")

    d = tempfile.mkdtemp()
    exts = {
        "a-committed": (toml('handle = "a-committed"', f'uid = "{cli_uid("a-committed")}"'), None),
        # CLI writes the uid after checkout (working tree only), indented like transformRaw keeps it.
        "b-written": (toml('handle = "b-written"'), toml('handle = "b-written"', f'uid = "{cli_uid("b-written")}"')),
        "c-none": (toml('handle = "c-none"'), None),
        "d-junk": (toml(f'handle = "Bad Handle {SECRET}"', f'uid = "{SECRET} not-an-id"'), None),
    }
    for name, (committed, _) in exts.items():
        os.makedirs(os.path.join(d, "extensions", name))
        open(os.path.join(d, "extensions", name, "shopify.extension.toml"), "w").write(committed)
    git(d, "init", "-q")
    git(d, "add", "-A")
    git(d, "commit", "-q", "-m", "x")
    for name, (_, post) in exts.items():
        if post:
            open(os.path.join(d, "extensions", name, "shopify.extension.toml"), "w").write(post)
    open(os.path.join(d, "step.sh"), "w").write(step_body(block))
    summary = os.path.join(d, "summary.md")
    env = dict(os.environ, GITHUB_STEP_SUMMARY=summary)
    p = subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", "step.sh"], cwd=d, env=env,
                       stdin=subprocess.DEVNULL, capture_output=True, text=True)
    out, summ = p.stdout, (open(summary).read() if os.path.exists(summary) else "")
    if p.returncode != 0:
        fails.append(f"step exited {p.returncode}")
    want = [
        f"extension handle=a-committed uid={cli_uid('a-committed')} uid_committed=true",
        f"extension handle=b-written uid={cli_uid('b-written')} uid_committed=false",
        "extension handle=c-none uid=none uid_committed=false",
        "extension handle=invalid uid=invalid uid_committed=true",
        "extension_count=4",
    ]
    if out.splitlines() != want:
        fails.append(f"stdout lines differ from expected ({len(out.splitlines())} lines)")
    allowed = re.compile(r"^(extension handle=([a-z0-9][a-z0-9_-]{0,63}|invalid) "
                         r"uid=([0-9a-f][0-9a-f-]{7,63}|none|invalid) uid_committed=(true|false)|extension_count=[0-9]+)$")
    if any(not allowed.match(l) for l in out.splitlines()):
        fails.append("non-allowlisted stdout line")
    for bit in (SECRET, "example.com", "Name", "description", "target", "cart.validations", "Bad Handle"):
        if bit in out + p.stderr or bit in summ:
            fails.append(f"toml text leaked: {bit!r}")
    if f"- extension `b-written`: uid `{cli_uid('b-written')}` (uid_committed: false)" not in summ:
        fails.append("summary missing written uid")
    if "- extension_count: 4" not in summ:
        fails.append("summary missing extension_count")

    if fails:
        print("shopify extension uids step self-test: FAIL")
        for f in fails:
            print(" -", f)
        return 1
    print("shopify extension uids step self-test: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
