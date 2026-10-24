-- s12-checkout-fixtures.sql (READ-ONLY)
-- Lists seed BuyerAccounts as S12 checkout fixtures: ids, enums, booleans only.
-- Never selects name, holdNote, emails, phones or addresses.
-- "overdue" uses the same predicate as scripts/backstop-backfill.ts
-- (open invoice, outstanding > 0, dueAt < NOW() - 1 day).
-- Output: one JSON object per line (psql -t -A).
-- Usage: psql -v ON_ERROR_STOP=1 -v shop_id=<Shop.id> -t -A -f scripts/readonly/s12-checkout-fixtures.sql
\set ON_ERROR_STOP 1
BEGIN TRANSACTION READ ONLY;
SELECT json_build_object(
  'buyer_account_id',      ba.id,
  'kind',                  ba.kind,
  'company_id',            CASE WHEN ba."companyId" LIKE 'gid://shopify/Company/%' THEN ba."companyId" END,
  'company_location_id',   CASE WHEN ba."companyLocationId" LIKE 'gid://shopify/CompanyLocation/%' THEN ba."companyLocationId" END,
  'customer_id',           CASE WHEN ba."customerId" LIKE 'gid://shopify/Customer/%' THEN ba."customerId" END,
  'hold_state',            ba."holdState",
  'manual_hold',           ba."manualHold",
  'bypass',                ba.bypass,
  'hold_reason_code',      CASE WHEN ba."holdReasonCode" ~ '^[A-Z0-9_]{1,40}$' THEN ba."holdReasonCode" WHEN ba."holdReasonCode" IS NULL THEN NULL ELSE '<other>' END,
  'overdue',               EXISTS (
                             SELECT 1 FROM "Invoice" i
                             WHERE i."buyerAccountId" = ba.id
                               AND i.status = 'open'
                               AND i.outstanding > 0
                               AND i."dueAt" IS NOT NULL
                               AND i."dueAt" < NOW() - INTERVAL '1 day')
)
FROM "BuyerAccount" ba
WHERE ba."shopId" = :'shop_id'
  AND ba.id LIKE 'seed-account-%'
ORDER BY ba.id
LIMIT 100;
COMMIT;
