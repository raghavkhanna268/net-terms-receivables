#!/usr/bin/env python3
"""Self-test for shopify_release_guards.py (no network, no secrets). Exits non-zero on failure."""
import importlib.util
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("g", os.path.join(HERE, "shopify_release_guards.py"))
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
fails = []

# 1. Real repo passes.
if g.main(ROOT) != 0:
    fails.append("real repo should pass")

# 2. PII detection.
bad_q = 'query Input { cart { buyerIdentity { customer { email metafield(namespace: "$app", key: "k") { jsonValue } } } } }'
if not any(f == "email" for f, _ in g.check_input_query(bad_q)):
    fails.append("customer.email not detected")
if not g.check_input_query("query { cart { deliveryGroups { deliveryAddress { city } } } }"):
    fails.append("address not detected")
if not g.check_input_query("query { cart { buyerIdentity { phone } } }"):
    fails.append("phone not detected")
if not g.check_input_query("query { cart { buyerIdentity { customer { displayName } } } }"):
    fails.append("customer.displayName not detected")
ok_q = 'query Input { paymentMethods { id name } cart { buyerIdentity { customer { metafield(namespace: "$app", key: "credit_status") { jsonValue } } } } }'
if g.check_input_query(ok_q):
    fails.append("paymentMethods.name / metafield wrongly flagged")


def scratch(mutate):
    d = tempfile.mkdtemp()
    shutil.copy(os.path.join(ROOT, "shopify.app.toml"), d)
    shutil.copy(os.path.join(ROOT, "wrangler.jsonc"), d)
    shutil.copytree(os.path.join(ROOT, "extensions"), os.path.join(d, "extensions"),
                    ignore=shutil.ignore_patterns("target", "node_modules"))
    mutate(d)
    rc = g.main(d)
    shutil.rmtree(d)
    return rc


def edit(path, old, new):
    s = open(path).read()
    assert old in s, old
    open(path, "w").write(s.replace(old, new, 1))


# 3. Extra scope in toml fails.
if scratch(lambda d: edit(os.path.join(d, "shopify.app.toml"), 'scopes = "read_companies,', 'scopes = "read_products,read_companies,')) == 0:
    fails.append("extra toml scope not failed")
# 4. Wrangler mismatch fails.
if scratch(lambda d: edit(os.path.join(d, "wrangler.jsonc"), ',write_validations"', '"')) == 0:
    fails.append("wrangler mismatch not failed")
# 5. Other config file fails.
if scratch(lambda d: open(os.path.join(d, "shopify.app.prod.toml"), "w").write("client_id = \"x\"\n")) == 0:
    fails.append("extra app config not failed")
# 6. PII in a real input query fails.
if scratch(lambda d: edit(os.path.join(d, "extensions/credit-check-validation/src/cart_validations_generate_run.graphql"),
                          "customer {", "customer {\n        email")) == 0:
    fails.append("PII in input query not failed")

if fails:
    print("shopify release guards self-test: FAIL")
    for f in fails:
        print(" -", f)
    sys.exit(1)
print("shopify release guards self-test: OK (10/10)")
