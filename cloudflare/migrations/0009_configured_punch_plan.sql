-- Existing random times were based on Timenet rather than the user schedule.
-- Preserve them for history, but require a matching key before reusing them.
ALTER TABLE calendar_days ADD COLUMN plan_key TEXT;
