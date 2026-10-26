-- S18: Fix updated_at trigger on s18_shop_reminder_settings
--
-- The original trigger (from 20261030000000_s18_payment_reminders) used set_updated_at(),
-- which writes to NEW."updatedAt" (camelCase). The s18_shop_reminder_settings table
-- uses snake_case column names (updated_at), causing UPDATE statements to fail.
--
-- This migration replaces the trigger to use update_updated_at_column() from the S8
-- migration, which correctly writes to NEW.updated_at (snake_case).
--
-- PURELY ADDITIVE: Only drops and recreates the trigger. No schema changes,
-- no new functions, no data modifications.

DROP TRIGGER IF EXISTS s18_shop_reminder_settings_updated_at ON s18_shop_reminder_settings;

CREATE TRIGGER s18_shop_reminder_settings_updated_at
  BEFORE UPDATE ON s18_shop_reminder_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
