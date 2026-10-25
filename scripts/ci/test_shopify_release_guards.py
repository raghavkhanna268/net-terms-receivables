#!/usr/bin/env python3
"""Self-test for shopify_release_guards.py (no network, no secrets). Exits non-zero on failure."""
import importlib.util
import os
import shutil
import subprocess
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
    shutil.copy(os.path.join(ROOT, "package.json"), d)
    shutil.copytree(os.path.join(ROOT, "extensions"), os.path.join(d, "extensions"),
                    ignore=shutil.ignore_patterns("target", "node_modules"))
    os.makedirs(os.path.join(d, "scripts", "ci"))
    shutil.copy(os.path.join(ROOT, "scripts", "ci", "expected-extensions.txt"), os.path.join(d, "scripts", "ci"))
    os.makedirs(os.path.join(d, ".github", "workflows"))
    shutil.copy(os.path.join(ROOT, ".github", "workflows", "shopify-app-release.yml"), os.path.join(d, ".github", "workflows"))
    mutate(d)
    rc = g.main(d)
    shutil.rmtree(d)
    return rc


def edit(path, old, new):
    s = open(path).read()
    assert old in s, old
    open(path, "w").write(s.replace(old, new, 1))


# 3. Extra scope in toml fails.
if scratch(lambda d: edit(os.path.join(d, "shopify.app.toml"), 'scopes = "read_draft_orders,', 'scopes = "read_products,read_draft_orders,')) == 0:
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

# 7. Deployed extension missing from repo fails (would be deleted by deploy).
if scratch(lambda d: shutil.rmtree(os.path.join(d, "extensions", "hide-terms-payment"))) == 0:
    fails.append("missing deployed extension not failed")
# 8. New extension not in expected list fails.
def add_ext(d):
    os.makedirs(os.path.join(d, "extensions", "new-ext"))
    open(os.path.join(d, "extensions", "new-ext", "shopify.extension.toml"), "w").write('handle = "new-ext"\n')
if scratch(add_ext) == 0:
    fails.append("unexpected extension not failed")
# 9. --allow-deletes in release workflow fails.
if scratch(lambda d: edit(os.path.join(d, ".github/workflows/shopify-app-release.yml"),
                          "--allow-updates", "--allow-updates --allow-deletes")) == 0:
    fails.append("--allow-deletes not failed")
# 9b. Preview/allow-updates flags in the shared base args fail (mutually exclusive in CLI 4.9.4).
if scratch(lambda d: edit(os.path.join(d, ".github/workflows/shopify-app-release.yml"),
                          "args=(app deploy --config", "args=(app deploy --allow-updates --config")) == 0:
    fails.append("allow-updates in base deploy args not failed")
# 10. Missing pipefail default fails.
if scratch(lambda d: edit(os.path.join(d, ".github/workflows/shopify-app-release.yml"),
                          "        shell: bash", "        shell: sh")) == 0:
    fails.append("missing bash/pipefail default not failed")
# 11. Ad-hoc npx CLI fails.
if scratch(lambda d: edit(os.path.join(d, ".github/workflows/shopify-app-release.yml"),
                          "./node_modules/.bin/shopify ", "npx -y @shopify/cli@4.9.4 ")) == 0:
    fails.append("ad-hoc npx CLI not failed")
# 12. Unpinned devDependency fails.
if scratch(lambda d: edit(os.path.join(d, "package.json"), '"@shopify/cli": "4.9.4"', '"@shopify/cli": "^4.9.4"')) == 0:
    fails.append("unpinned CLI devDependency not failed")

# 13. S24: Adding read_locations (a 9th scope outside the approved 8) fails.
if scratch(lambda d: edit(os.path.join(d, "shopify.app.toml"), 'scopes = "read_draft_orders,', 'scopes = "read_locations,read_draft_orders,') or
                     edit(os.path.join(d, "wrangler.jsonc"), '"SCOPES": "read_draft_orders,', '"SCOPES": "read_locations,read_draft_orders,')) == 0:
    fails.append("read_locations (9th scope) not rejected")

# 14. Deploy step prints no CLI text and classifies errors (stub CLI, fake values only).
if subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "ci", "test_shopify_deploy_step.py")]).returncode != 0:
    fails.append("deploy step stub-CLI self-test failed")

if fails:
    print("shopify release guards self-test: FAIL")
    for f in fails:
        print(" -", f)
    sys.exit(1)
print("shopify release guards self-test: OK (19/19)")
