-- S24: Add closed_at and closed_reason to s6_bulk_operations for reinstall reset
--
-- Issue #293: When a shop reinstalls, orphaned or completed bulk operations
-- from the previous install should not block a fresh sync. Instead of deleting
-- them (which loses audit history), we mark them closed with a reason.
--
-- closed_at: When the operation was closed (NULL if still open)
-- closed_reason: Why it was closed (currently only 'reinstall_reset')
--
-- Constraints:
-- - closed_reason must be a known value (reinstall_reset)
-- - Both columns must be NULL together or both non-NULL (pair check)

ALTER TABLE s6_bulk_operations
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS closed_reason TEXT NULL;

ALTER TABLE s6_bulk_operations
  ADD CONSTRAINT s6_bulk_operations_closed_reason_check
    CHECK (closed_reason IS NULL OR closed_reason IN ('reinstall_reset')),
  ADD CONSTRAINT s6_bulk_operations_closed_pair_check
    CHECK ((closed_at IS NULL) = (closed_reason IS NULL));

COMMENT ON COLUMN s6_bulk_operations.closed_at IS 'When the operation was closed. NULL means open.';
COMMENT ON COLUMN s6_bulk_operations.closed_reason IS 'Why the operation was closed. Currently only reinstall_reset.';
