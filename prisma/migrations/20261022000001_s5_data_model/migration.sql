-- S5: Full v1 data model for Net Terms Receivables
-- Adds all models for buyer accounts, invoices, payments, matching, reminders, and audit

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
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "plan" TEXT NOT NULL DEFAULT 'free',
    "defaultTermsDays" INTEGER,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountSource" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "defaultTermsDays" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AccountSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyerAccount" (
    "id" TEXT NOT NULL,
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
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BuyerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
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
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankImport" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "bank" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
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
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "score" INTEGER NOT NULL,
    "reasons" JSONB NOT NULL,
    "state" "MatchState" NOT NULL DEFAULT 'suggested',
    "confirmedBy" TEXT,
    "confirmedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayerAlias" (
    "id" TEXT NOT NULL,
    "buyerAccountId" TEXT NOT NULL,
    "payerKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayerAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReminderRule" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "offsetDays" INTEGER NOT NULL,
    "channel" "ReminderChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ReminderRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReminderLog" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "sentAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReminderLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_domain_key" ON "Shop"("domain");

-- CreateIndex
CREATE INDEX "AccountSource_shopId_idx" ON "AccountSource"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountSource_shopId_tag_key" ON "AccountSource"("shopId", "tag");

-- CreateIndex
CREATE INDEX "BuyerAccount_shopId_kind_idx" ON "BuyerAccount"("shopId", "kind");

-- CreateIndex
CREATE INDEX "BuyerAccount_shopId_holdState_idx" ON "BuyerAccount"("shopId", "holdState");

-- CreateIndex
CREATE UNIQUE INDEX "BuyerAccount_shopId_companyLocationId_key" ON "BuyerAccount"("shopId", "companyLocationId");

-- CreateIndex
CREATE UNIQUE INDEX "BuyerAccount_shopId_customerId_key" ON "BuyerAccount"("shopId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_orderId_key" ON "Invoice"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_draftOrderId_key" ON "Invoice"("draftOrderId");

-- CreateIndex
CREATE INDEX "Invoice_shopId_status_dueAt_idx" ON "Invoice"("shopId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "Invoice_buyerAccountId_status_idx" ON "Invoice"("buyerAccountId", "status");

-- CreateIndex
CREATE INDEX "BankImport_shopId_createdAt_idx" ON "BankImport"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_shopId_status_idx" ON "Payment"("shopId", "status");

-- CreateIndex
CREATE INDEX "Payment_importId_idx" ON "Payment"("importId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_shopId_utr_key" ON "Payment"("shopId", "utr");

-- CreateIndex
CREATE INDEX "Match_paymentId_idx" ON "Match"("paymentId");

-- CreateIndex
CREATE INDEX "Match_invoiceId_idx" ON "Match"("invoiceId");

-- CreateIndex
CREATE INDEX "PayerAlias_payerKey_idx" ON "PayerAlias"("payerKey");

-- CreateIndex
CREATE UNIQUE INDEX "PayerAlias_buyerAccountId_payerKey_key" ON "PayerAlias"("buyerAccountId", "payerKey");

-- CreateIndex
CREATE INDEX "ReminderRule_shopId_enabled_idx" ON "ReminderRule"("shopId", "enabled");

-- CreateIndex
CREATE INDEX "ReminderLog_invoiceId_idx" ON "ReminderLog"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReminderLog_ruleId_invoiceId_key" ON "ReminderLog"("ruleId", "invoiceId");

-- CreateIndex
CREATE INDEX "AuditEvent_shopId_at_idx" ON "AuditEvent"("shopId", "at");

-- CreateIndex
CREATE INDEX "AuditEvent_shopId_type_idx" ON "AuditEvent"("shopId", "type");

-- AddForeignKey
ALTER TABLE "AccountSource" ADD CONSTRAINT "AccountSource_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerAccount" ADD CONSTRAINT "BuyerAccount_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_buyerAccountId_fkey" FOREIGN KEY ("buyerAccountId") REFERENCES "BuyerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankImport" ADD CONSTRAINT "BankImport_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_importId_fkey" FOREIGN KEY ("importId") REFERENCES "BankImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayerAlias" ADD CONSTRAINT "PayerAlias_buyerAccountId_fkey" FOREIGN KEY ("buyerAccountId") REFERENCES "BuyerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderRule" ADD CONSTRAINT "ReminderRule_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderLog" ADD CONSTRAINT "ReminderLog_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "ReminderRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderLog" ADD CONSTRAINT "ReminderLog_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
