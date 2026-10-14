CREATE UNIQUE INDEX IF NOT EXISTS punch_events_unique_idx
ON punch_events(user_id, local_date, action, source, recorded_time);
