#!/usr/bin/env python3
"""Self-test for backfill-dry-run-filter.py (no DB, no secrets). Exits non-zero on failure."""
import os
import subprocess
import sys

FILTER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backfill-dry-run-filter.py")


def run(text):
    p = subprocess.run([sys.executable, FILTER], input=text, capture_output=True, text=True)
    return p.returncode, p.stdout


DRY = "Mode: DRY-RUN (use --apply to write)\n"
fails = []

rc, out = run(DRY + "Shop: example-shop.myshopify.com\n  Order: gid://shopify/Order/1 account: acc_1\n"
              "Shop: other.myshopify.com\nShop: example-shop.myshopify.com\nCandidates: 1\n")
if rc != 0 or "myshopify" in out or "Shop: #1\n" not in out or "Shop: #2\n" not in out or out.count("Shop: #1") != 2:
    fails.append(f"domain-shaped shop id not masked (rc={rc})")

rc, out = run(DRY + "  Order: gid://shopify/Order/1 account: shop.example.com\n")
if rc != 5 or "example.com" in out:
    fails.append(f"host-shaped value not failed (rc={rc})")

rc, out = run(DRY + "Mode: APPLY (writing holds)\n")
if rc != 3:
    fails.append(f"apply output not failed (rc={rc})")

rc, out = run("Shop: x\n")
if rc != 4:
    fails.append(f"missing DRY-RUN not failed (rc={rc})")

rc, out = run(DRY + "    ✗ error: connect ECONNREFUSED db.abc.supabase.co:5432 a@b.com\n")
if rc != 0 or "supabase" in out or "<host>" not in out:
    fails.append(f"error text not redacted (rc={rc})")

for f in fails:
    print(f"FAIL: {f}")
print(f"filter self-test: {'FAILED' if fails else 'OK'} ({5 - len(fails)}/5)")
sys.exit(1 if fails else 0)
