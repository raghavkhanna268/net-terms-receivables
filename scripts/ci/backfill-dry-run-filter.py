#!/usr/bin/env python3
"""Allowlist filter for the backstop backfill dry-run log (public Actions logs).

Reads the script's stdout+stderr on stdin and prints only lines that match a
known ids/counts/enums shape. Error text is reduced to its class (text before
the first colon), redacted (emails, hosts, hex, digits) and cut to 80 chars,
matching prod-diagnostics. Every other line is dropped and only counted.
Shop ids are masked as an ordinal (`Shop: #1`, `#2`, ...) because prod shop ids
are domain-shaped. Exits 3 if any line indicates apply mode or a write, 4 if
DRY-RUN mode was never reported, 5 if any line about to be printed still matches
the HOST pattern (that line is suppressed).
"""
import re
import sys

ID = r"[A-Za-z0-9._:/-]{1,120}"
ALLOW = [
    r"=+",
    r"-+",
    r"Backstop Backfill Script \(S13\)",
    r"Mode: DRY-RUN \(use --apply to write\)",
    r"Window: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z to \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z",
    r"Finding candidates \(held accounts with missing backstop\)\.\.\.",
    r"✅ No candidates found\. All orders from held accounts have been processed\.",
    r"Found \d+ candidate\(s\):",
    r"  ⚠ No offline session, skipping \d+ orders",
    r"  Order: gid://shopify/Order/\d+ account: " + ID,
    r"    → would-hold \([a-z_]+\)",
    r"    → would-skip \([a-z_]+\)",
    r"    → skip \(invoice_not_found\)",
    r"SUMMARY",
    r"(Candidates|Would hold|Would skip|Errors): \d+",
    r"⚠ This was a dry-run\. Run with --apply to actually apply holds\.",
]
ALLOW_RE = [re.compile(rf"^{a}$") for a in ALLOW]
APPLY_RE = re.compile(r"Mode: APPLY|✓ held:|^Applied: |^Skipped: |error \((retryable|fatal)\)")
ERR_RE = re.compile(r"^\s*(✗ error: |ERROR: |Fatal error:)\s*(.*)$")
EMAIL = re.compile(r"[^\s@]+@[^\s@]+")
HOST = re.compile(r"\b[a-z0-9-]+(\.[a-z0-9-]+)+\.[a-z]{2,}\b", re.I)
HEX = re.compile(r"\b[0-9a-f]{8,}\b", re.I)
DIG = re.compile(r"\d+")
SHOP_RE = re.compile(rf"^Shop: ({ID})$")


def redact_class(text: str) -> str:
    cls = text.split(":", 1)[0]
    cls = EMAIL.sub("<email>", cls)
    cls = HOST.sub("<host>", cls)
    cls = HEX.sub("<hex>", cls)
    cls = DIG.sub("<n>", cls)
    return cls[:80]


dropped = 0
host_leak = 0
shops: dict = {}
apply_seen = False
dry_run_seen = False
for raw in sys.stdin:
    line = raw.rstrip("\n")
    if APPLY_RE.search(line):
        apply_seen = True
        dropped += 1
        continue
    if line.strip() == "":
        continue
    if line == "Mode: DRY-RUN (use --apply to write)":
        dry_run_seen = True
    out = None
    sm = SHOP_RE.match(line)
    if sm:
        out = f"Shop: #{shops.setdefault(sm.group(1), len(shops) + 1)}"
    elif any(r.match(line) for r in ALLOW_RE):
        out = line
    else:
        m = ERR_RE.match(line)
        if m:
            out = f"    ✗ error class: {redact_class(m.group(2))}"
    if out is None:
        dropped += 1
        continue
    if HOST.search(out):
        host_leak += 1
        continue
    print(out)

print(f"[filter] dropped_lines={dropped} dry_run_mode_seen={str(dry_run_seen).lower()} apply_seen={str(apply_seen).lower()} shops={len(shops)} host_leak_lines={host_leak}")
if apply_seen:
    print("::error::apply-mode output detected; failing")
    sys.exit(3)
if host_leak:
    print("::error::host-shaped value in output; failing")
    sys.exit(5)
if not dry_run_seen:
    print("::error::script did not report DRY-RUN mode; failing")
    sys.exit(4)
