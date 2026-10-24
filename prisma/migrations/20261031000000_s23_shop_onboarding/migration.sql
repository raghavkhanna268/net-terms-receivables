-- S23: Add onboarding dismissal tracking to Shop table
-- Minimal column for tracking when merchant dismissed the onboarding checklist.
-- NULL means not dismissed (show onboarding), non-NULL means dismissed (skip onboarding).

ALTER TABLE "Shop" ADD COLUMN onboarding_dismissed_at TIMESTAMPTZ;
