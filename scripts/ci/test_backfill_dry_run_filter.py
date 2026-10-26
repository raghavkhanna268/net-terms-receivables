#!/usr/bin/env python3
"""Self-test for backfill-dry-run-filter.py (no DB, no secrets). Exits non-zero on failure."""
import os
import subprocess
import sys
import re

FILTER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backfill-dry-run-filter.py")

# Extract and load check_output_line function directly from the filter source.
# We read the file and extract only the definitions we need to avoid running main.
with open(FILTER) as f:
    code = f.read()
# Find where the main loop starts (after function definitions)
main_start = code.find("\ndropped = 0")
if main_start > 0:
    code = code[:main_start]
exec_globals = {"re": re, "sys": sys, "__name__": "filter_module"}
exec(code, exec_globals)
check_output_line = exec_globals["check_output_line"]


def run(text):
    p = subprocess.run([sys.executable, FILTER], input=text, capture_output=True, text=True)
    return p.returncode, p.stdout


DRY = "Mode: DRY-RUN (use --apply to write)\n"
fails = []

# 1. Test that shop domains are masked to ordinals
rc, out = run(DRY + "Shop: example-shop.myshopify.com\nShop: other.myshopify.com\n"
              "Shop: example-shop.myshopify.com\nCandidates: 1\n")
if rc != 0 or "myshopify" in out or "Shop: #1\n" not in out or "Shop: #2\n" not in out or out.count("Shop: #1") != 2:
    fails.append(f"1. domain-shaped shop id not masked (rc={rc})")

# 2. Test that lines that don't match the allowlist are dropped (not failed).
rc, out = run(DRY + "  Order: gid://shopify/Order/1 account: shop.example.com\n")
if rc != 0 or "example.com" in out:
    fails.append(f"2. dropped line with ids should not fail (rc={rc})")

# 3. Test exit 6 via stdin: id-shaped values in PRINTED lines cause exit 6.
rc, out = run(DRY + "Candidates: 1234567\n")
if rc != 6 or "id-shaped value in output" not in out or "1234567" in out:
    fails.append(f"3. id leak not detected via stdin (rc={rc})")

# 4. Test error redaction removes hosts (so they don't reach output check).
rc, out = run(DRY + "    ✗ error: connect ECONNREFUSED db.abc.supabase.co:5432 a@b.com\n")
if rc != 0 or "supabase" in out or "<host>" not in out:
    fails.append(f"4. error text not redacted (rc={rc})")

# 5. Test check_output_line directly: exit 5 for host-shaped value.
# This tests the function that checks output lines, bypassing stdin processing.
if check_output_line("some text with api.example.com in it") != 5:
    fails.append("5. check_output_line should return 5 for host")

# 6. Test check_output_line directly: exit 6 for id-shaped value.
if check_output_line("account id: 550e8400-e29b-41d4-a716-446655440000") != 6:
    fails.append("6. check_output_line should return 6 for id")

# 7. Test check_output_line: line with BOTH host and id returns 5 (host-before-id).
# This proves the host check runs before the id check.
if check_output_line("api.example.com uuid:550e8400-e29b-41d4-a716-446655440000") != 5:
    fails.append("7. check_output_line should return 5 when both host and id present")

# 8. Test check_output_line: safe line returns 0.
if check_output_line("Candidates: 5") != 0:
    fails.append("8. check_output_line should return 0 for safe line")

# 9. Test exit 3: apply-mode output
rc, out = run(DRY + "Mode: APPLY (writing holds)\n")
if rc != 3:
    fails.append(f"9. apply output not failed (rc={rc})")

# 10. Test exit 4: missing DRY-RUN mode
rc, out = run("Shop: x\n")
if rc != 4:
    fails.append(f"10. missing DRY-RUN not failed (rc={rc})")

for f in fails:
    print(f"FAIL: {f}")
print(f"filter self-test: {'FAILED' if fails else 'OK'} ({10 - len(fails)}/10)")
sys.exit(1 if fails else 0)
