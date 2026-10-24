-- S17: Add 'pushing' state to MatchState enum
-- This represents a match that has been claimed for push but not yet finalized.
-- The state prevents double-allocation and allows stale claim recovery.

ALTER TYPE "MatchState" ADD VALUE IF NOT EXISTS 'pushing' AFTER 'confirmed';
