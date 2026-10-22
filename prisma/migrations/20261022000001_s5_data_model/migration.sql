-- S5: Full v1 data model for Net Terms Receivables
-- Adds all models for buyer accounts, invoices, payments, matching, reminders, and audit
--
-- onDelete design:
--   Shop -> *: CASCADE (enables S22 shop/redact and uninstall cleanup)
--   Financial parent -> child (BuyerAccount->Invoice, BankImport->Payment, etc.): NO ACTION
--     (prevents silent deletion of financial history; parent delete is rejected if children exist)
--   PayerAlias: CASCADE (helper data, not financial record)
--
-- Shop cascade mechanism:
--   Invoice, Payment, Match, ReminderLog have DIRECT FKs to Shop with CASCADE.
--   This ensures they are deleted as part of the Shop cascade BEFORE their parents
--   (BuyerAccount, BankImport, ReminderRule) are deleted. The NO ACTION FKs from
--   parent to child pass because the children are already gone.
--
-- Cross-shop integrity:
--   Composite unique (id, shopId) on BuyerAccount, BankImport, Invoice, Payment, ReminderRule
--   Composite FKs ensure Invoice->BuyerAccount, Payment->BankImport, Match->Payment/Invoice,
--   ReminderLog->ReminderRule/Invoice all reference entities from the same shop

-- CreateEnum
CREATE TYPE "AccountKind" AS ENUM ('COMPANY', 'TAGGED_CUSTOMER');

-- CreateEnum
CREATE TYPE "HoldState" AS ENUM ('OK', 'NEAR_LIMIT', 'HELD', 'BYPASS');

-- CreateEnum
CREATE TYPE "DefaultTermsSource" AS ENUM ('explicit', 'tag');

-- CreateEnum
CREATE TYPE "DueSource" AS ENUM ('schedule', 'override', 'inferred', 'none');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('open', 'paid', 'cancelled');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('unmatched', 'partial', 'matched');

-- CreateEnum
CREATE TYPE "MatchState" AS ENUM ('suggested', 'confirmed', 'pushed', 'unmatched');

-- CreateEnum
CREATE TYPE "ReminderChannel" AS ENUM ('native', 'email');

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "domain" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "plan" TEXT NOT NULL DEFAULT 'free',
    "defaultTermsDays" INTEGER,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountSource" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "shopId" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "defaultTermsDays" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyerAccount" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "shopId" TEXT NOT NULL,
    "kind" "AccountKind" NOT NULL,
    "companyId" TEXT,
    "companyLocationId" TEXT,
    "customerId" TEXT,
    "name" TEXT NOT NULL,
    "creditLimit" DECIMAL(14,2),
    "defaultTermsDays" INTEGER,
    "defaultTermsSource" "DefaultTermsSource",
    "holdState" "HoldState" NOT NULL DEFAULT 'OK',
    "bypass" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuyerAccount_pkey" PRIMARY KEY ("id"),
    -- CHECK: COMPANY requires companyLocationId (and companyId); TAGGED_CUSTOMER requires customerId
    CONSTRAINT "BuyerAccount_kind_consistency" CHECK (
        (kind = 'COMPANY' AND "companyLocationId" IS NOT NULL AND "companyId" IS NOT NULL)
        OR (kind = 'TAGGED_CUSTOMER' AND "customerId" IS NOT NULL)
    )
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "shopId" TEXT NOT NULL,
    "buyerAccountId" TEXT NOT NULL,
    "orderId" TEXT,
    "draftOrderId" TEXT,
    "name" TEXT NOT NULL,
    "gstInvoiceNo" TEXT,
    "total" DECIMAL(14,2) NOT NULL,
    "outstanding" DECIMAL(14,2) NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL,
    "dueAt" TIMESTAMPTZ(3),
    "dueSource" "DueSource" NOT NULL DEFAULT 'none',
    "dueBasis" TEXT,
    "dueReason" TEXT,
    "dueOverrideAt" TIMESTAMPTZ(3),
    "status" "InvoiceStatus" NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id"),
    -- CHECK: outstanding must be between 0 and total
    CONSTRAINT "Invoice_outstanding_range" CHECK (outstanding >= 0 AND outstanding <= total),
    -- CHECK: exactly one of orderId or draftOrderId must be set
    CONSTRAINT "Invoice_order_xor_draft" CHECK (
        (("orderId" IS NOT NULL)::int + ("draftOrderId" IS NOT NULL)::int) = 1
    )
);

-- CreateTable
CREATE TABLE "BankImport" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "shopId" TEXT NOT NULL,
    "bank" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "shopId" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "valueDate" TIMESTAMPTZ(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "rail" TEXT,
    "utr" TEXT,
    "payerText" TEXT,
    "narration" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'unmatched',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id"),
    -- CHECK: amount must be positive
    CONSTRAINT "Payment_amount_positive" CHECK (amount > 0)
);

-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "shopId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "score" INTEGER NOT NULL,
    "reasons" JSONB NOT NULL,
    "state" "MatchState" NOT NULL DEFAULT 'suggested',
    "confirmedBy" TEXT,
    "confirmedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id"),
    -- CHECK: amount must be positive
    CONSTRAINT "Match_amount_positive" CHECK (amount > 0),
    -- CHECK: score must be between 0 and 100
    CONSTRAINT "Match_score_range" CHECK (score >= 0 AND score <= 100)
);

-- CreateTable
CREATE TABLE "PayerAlias" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "buyerAccountId" TEXT NOT NULL,
    "payerKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayerAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReminderRule" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "shopId" TEXT NOT NULL,
    "offsetDays" INTEGER NOT NULL,
    "channel" "ReminderChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReminderRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReminderLog" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "shopId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "sentAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReminderLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "shopId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: Shop
CREATE UNIQUE INDEX "Shop_domain_key" ON "Shop"("domain");

-- CreateIndex: AccountSource
CREATE INDEX "AccountSource_shopId_idx" ON "AccountSource"("shopId");
CREATE UNIQUE INDEX "AccountSource_shopId_tag_key" ON "AccountSource"("shopId", "tag");

-- CreateIndex: BuyerAccount
CREATE INDEX "BuyerAccount_shopId_kind_idx" ON "BuyerAccount"("shopId", "kind");
CREATE INDEX "BuyerAccount_shopId_holdState_idx" ON "BuyerAccount"("shopId", "holdState");
CREATE UNIQUE INDEX "BuyerAccount_id_shopId_key" ON "BuyerAccount"("id", "shopId");
CREATE UNIQUE INDEX "BuyerAccount_shopId_companyLocationId_key" ON "BuyerAccount"("shopId", "companyLocationId");
CREATE UNIQUE INDEX "BuyerAccount_shopId_customerId_key" ON "BuyerAccount"("shopId", "customerId");

-- CreateIndex: Invoice
CREATE UNIQUE INDEX "Invoice_orderId_key" ON "Invoice"("orderId");
CREATE UNIQUE INDEX "Invoice_draftOrderId_key" ON "Invoice"("draftOrderId");
CREATE UNIQUE INDEX "Invoice_id_shopId_key" ON "Invoice"("id", "shopId");
CREATE INDEX "Invoice_shopId_status_dueAt_idx" ON "Invoice"("shopId", "status", "dueAt");
CREATE INDEX "Invoice_buyerAccountId_status_idx" ON "Invoice"("buyerAccountId", "status");

-- CreateIndex: BankImport
CREATE UNIQUE INDEX "BankImport_id_shopId_key" ON "BankImport"("id", "shopId");
CREATE INDEX "BankImport_shopId_createdAt_idx" ON "BankImport"("shopId", "createdAt");

-- CreateIndex: Payment
CREATE UNIQUE INDEX "Payment_id_shopId_key" ON "Payment"("id", "shopId");
CREATE INDEX "Payment_shopId_status_idx" ON "Payment"("shopId", "status");
CREATE INDEX "Payment_importId_idx" ON "Payment"("importId");
CREATE UNIQUE INDEX "Payment_shopId_utr_key" ON "Payment"("shopId", "utr");

-- CreateIndex: Match
CREATE INDEX "Match_paymentId_idx" ON "Match"("paymentId");
CREATE INDEX "Match_invoiceId_idx" ON "Match"("invoiceId");
CREATE INDEX "Match_shopId_idx" ON "Match"("shopId");

-- CreateIndex: PayerAlias
CREATE INDEX "PayerAlias_payerKey_idx" ON "PayerAlias"("payerKey");
CREATE UNIQUE INDEX "PayerAlias_buyerAccountId_payerKey_key" ON "PayerAlias"("buyerAccountId", "payerKey");

-- CreateIndex: ReminderRule
CREATE UNIQUE INDEX "ReminderRule_id_shopId_key" ON "ReminderRule"("id", "shopId");
CREATE INDEX "ReminderRule_shopId_enabled_idx" ON "ReminderRule"("shopId", "enabled");

-- CreateIndex: ReminderLog
CREATE INDEX "ReminderLog_invoiceId_idx" ON "ReminderLog"("invoiceId");
CREATE INDEX "ReminderLog_shopId_idx" ON "ReminderLog"("shopId");
CREATE UNIQUE INDEX "ReminderLog_ruleId_invoiceId_key" ON "ReminderLog"("ruleId", "invoiceId");

-- CreateIndex: AuditEvent
CREATE INDEX "AuditEvent_shopId_at_idx" ON "AuditEvent"("shopId", "at");
CREATE INDEX "AuditEvent_shopId_type_idx" ON "AuditEvent"("shopId", "type");

-- AddForeignKey: Shop children (CASCADE for S22 cleanup)
ALTER TABLE "AccountSource" ADD CONSTRAINT "AccountSource_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BuyerAccount" ADD CONSTRAINT "BuyerAccount_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BankImport" ADD CONSTRAINT "BankImport_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReminderRule" ADD CONSTRAINT "ReminderRule_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: Direct Shop FKs with CASCADE on financial records
-- These ensure Invoice, Payment, Match, ReminderLog are deleted BEFORE their parents
-- when a Shop is deleted, so the NO ACTION FKs from parent to child pass.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Match" ADD CONSTRAINT "Match_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReminderLog" ADD CONSTRAINT "ReminderLog_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: Financial parent-to-child relations (NO ACTION to preserve history)
-- Note: NO ACTION is checked at end of statement. Since Invoice/Payment/Match/ReminderLog
-- are deleted via direct Shop cascade BEFORE their parents, these checks pass.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_buyerAccountId_shopId_fkey" FOREIGN KEY ("buyerAccountId", "shopId") REFERENCES "BuyerAccount"("id", "shopId") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_importId_shopId_fkey" FOREIGN KEY ("importId", "shopId") REFERENCES "BankImport"("id", "shopId") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "Match" ADD CONSTRAINT "Match_paymentId_shopId_fkey" FOREIGN KEY ("paymentId", "shopId") REFERENCES "Payment"("id", "shopId") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "Match" ADD CONSTRAINT "Match_invoiceId_shopId_fkey" FOREIGN KEY ("invoiceId", "shopId") REFERENCES "Invoice"("id", "shopId") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ReminderLog" ADD CONSTRAINT "ReminderLog_ruleId_shopId_fkey" FOREIGN KEY ("ruleId", "shopId") REFERENCES "ReminderRule"("id", "shopId") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ReminderLog" ADD CONSTRAINT "ReminderLog_invoiceId_shopId_fkey" FOREIGN KEY ("invoiceId", "shopId") REFERENCES "Invoice"("id", "shopId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey: Helper data (CASCADE)
ALTER TABLE "PayerAlias" ADD CONSTRAINT "PayerAlias_buyerAccountId_fkey" FOREIGN KEY ("buyerAccountId") REFERENCES "BuyerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Create trigger function for updatedAt
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW."updatedAt" = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add updatedAt triggers to all tables with updatedAt column
CREATE TRIGGER "Shop_updatedAt" BEFORE UPDATE ON "Shop" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER "AccountSource_updatedAt" BEFORE UPDATE ON "AccountSource" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER "BuyerAccount_updatedAt" BEFORE UPDATE ON "BuyerAccount" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER "Invoice_updatedAt" BEFORE UPDATE ON "Invoice" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER "Payment_updatedAt" BEFORE UPDATE ON "Payment" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER "Match_updatedAt" BEFORE UPDATE ON "Match" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER "ReminderRule_updatedAt" BEFORE UPDATE ON "ReminderRule" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- DPDP/Privacy comment:
-- Payment.narration and Payment.payerText contain raw bank statement data which may include
-- payer names, account numbers, and other identifiers. The customers/redact webhook handler
-- (to be implemented in S22) must redact these fields for affected customers. See GitHub
-- issue #22 for implementation details.
