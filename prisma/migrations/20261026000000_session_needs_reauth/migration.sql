-- Add needs_reauth flag to Session table
-- Used to mark sessions where the refresh token is invalid or expired,
-- indicating the shop needs to re-authenticate via OAuth.

ALTER TABLE "Session" ADD COLUMN "needsReauth" BOOLEAN NOT NULL DEFAULT false;

-- Index for efficient lookup of sessions needing re-auth
-- Note: Cannot use CONCURRENTLY in a migration transaction, but this is a small table
CREATE INDEX IF NOT EXISTS "Session_shop_needsReauth_idx"
  ON "Session" (shop)
  WHERE "needsReauth" = true;
