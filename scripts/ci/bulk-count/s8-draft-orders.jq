# Counts-only reducer for the s8-draft-orders bulk JSONL (prod-bulk-count.yml).
# Run as: jq -n -r -f s8-draft-orders.jq < result.jsonl
# Output is exactly four "name=<int>" lines. It never emits any field value.
# purchasingEntity is a union (Customer | PurchasingCompany). The committed
# query selects only `... on PurchasingCompany { company { id } location { id } }`,
# so a Customer purchaser comes back as {} and no purchaser as null; a
# company purchaser is detected by a non-null company.id.
reduce (
  inputs
  | select(type == "object")
  | select((.id // null) | type == "string" and startswith("gid://shopify/DraftOrder/"))
) as $l (
  {draft_order_lines: 0, with_purchasing_company: 0, customer_only: 0, neither: 0};
  .draft_order_lines += 1
  | if (($l.purchasingEntity | type) == "object")
       and ((($l.purchasingEntity.company | type) == "object")
       and (($l.purchasingEntity.company.id // null) != null))
    then .with_purchasing_company += 1
    elif (($l.customer | type) == "object") and (($l.customer.id // null) != null)
    then .customer_only += 1
    else .neither += 1
    end
)
| "draft_order_lines=\(.draft_order_lines)",
  "with_purchasing_company=\(.with_purchasing_company)",
  "customer_only=\(.customer_only)",
  "neither=\(.neither)"
