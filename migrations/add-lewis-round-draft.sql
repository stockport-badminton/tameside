-- Add lewis_round to the draft fixture table.
-- 1 = prelim (R1), 2 = round 1 (R2), 3 = quarter-final (QF), NULL = regular fixture.

ALTER TABLE tameside_draft_fixture
  ADD COLUMN IF NOT EXISTS lewis_round SMALLINT;
