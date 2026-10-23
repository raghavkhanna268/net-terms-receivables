-- S16: RejectedMatch table for persisting merchant rejections
-- Rejected payment-invoice pairs are never re-suggested by the matcher.

-- Create rejected_matches table
CREATE TABLE IF NOT EXISTS "rejected_matches" (
    id TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "shopId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "rejectedBy" TEXT NOT NULL,
    "rejectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
    CONSTRAINT "rejected_matches_pkey" PRIMARY KEY ("id")
);

-- Unique constraint: one rejection per payment-invoice pair
CREATE UNIQUE INDEX IF NOT EXISTS "rejected_matches_paymentId_invoiceId_key" 
ON "rejected_matches" ("paymentId", "invoiceId");

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS "rejected_matches_shopId_idx" ON "rejected_matches" ("shopId");
CREATE INDEX IF NOT EXISTS "rejected_matches_paymentId_idx" ON "rejected_matches" ("paymentId");
CREATE INDEX IF NOT EXISTS "rejected_matches_invoiceId_idx" ON "rejected_matches" ("invoiceId");

-- Foreign key constraints
ALTER TABLE "rejected_matches" 
ADD CONSTRAINT "rejected_matches_shopId_fkey" 
FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "rejected_matches" 
ADD CONSTRAINT "rejected_matches_paymentId_shopId_fkey" 
FOREIGN KEY ("paymentId", "shopId") REFERENCES "Payment"("id", "shopId") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "rejected_matches" 
ADD CONSTRAINT "rejected_matches_invoiceId_shopId_fkey" 
FOREIGN KEY ("invoiceId", "shopId") REFERENCES "Invoice"("id", "shopId") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Comments for documentation
COMMENT ON TABLE "rejected_matches" IS 'Persists merchant rejections so payment-invoice pairs are never re-suggested.';
COMMENT ON COLUMN "rejected_matches"."rejectedBy" IS 'User ID who rejected the match.';
COMMENT ON COLUMN "rejected_matches"."rejectedAt" IS 'When the match was rejected.';
