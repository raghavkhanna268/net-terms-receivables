-- #261: Add lastInstalledAt to Shop for stale app/uninstalled detection
-- Tracks when the shop last completed installation/reinstallation.
-- Used to detect late/retried app/uninstalled webhooks after a quick reinstall.

ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "lastInstalledAt" TIMESTAMPTZ(3) NULL;
