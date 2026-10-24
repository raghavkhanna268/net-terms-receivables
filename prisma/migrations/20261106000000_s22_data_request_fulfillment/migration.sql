-- S22 Data Request Fulfillment (#44)
--
-- This migration documents the customers/data_request export format and adds
-- helpful comments. No schema changes are required as all tables already exist.
--
-- Export format now includes:
-- - taggedCustomer: tags, tagActive, email, displayName, createdAt
-- - draftOrders: id, name, total, status, createdAt
-- - buyerAccount: id, name, kind, creditLimit, defaultTermsDays, holdState
-- - invoices: id, name, total, outstanding, status, issuedAt, dueAt
-- - paymentMatches: id, invoiceId, amount, state, confirmedAt, createdAt (NEW)
--
-- PII handling:
-- - Email and displayName are Level 1 Protected Customer Data
-- - Phone and address are NEVER stored or exported
-- - Payment.payerText and Payment.narration are NOT exported (bank statement PII)
--
-- See:
-- - https://shopify.dev/docs/apps/build/privacy-law-compliance
-- - https://shopify.dev/docs/apps/launch/protected-customer-data

-- Update table comment to document the export format
COMMENT ON TABLE s22_data_requests IS 'S22 GDPR/CCPA data requests: stores customer data exports from customers/data_request webhook. Export includes taggedCustomer, draftOrders, buyerAccount, invoices, and paymentMatches. Phone/address are never stored. Bank statement PII (payerText, narration) is excluded from exports. Merchant downloads via admin route. Exports expire after 30 days per DPDP minimisation.';

-- Add comment on export_data to clarify content
COMMENT ON COLUMN s22_data_requests.export_data IS 'JSON export containing: taggedCustomer (tags, tagActive, email, displayName), draftOrders, buyerAccount (kind, creditLimit, holdState), invoices (name, total, outstanding, status, dates), paymentMatches (id, invoiceId, amount, state, dates). Excludes phone, address, and bank statement PII.';
