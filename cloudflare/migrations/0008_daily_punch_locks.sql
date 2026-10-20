-- An unresolved click must block that day's shift, never subsequent days.
DROP INDEX punch_guard_user_active;
CREATE UNIQUE INDEX punch_guard_user_day_active ON punch_guards(user_id, local_date)
WHERE status IN ('pending', 'uncertain');

ALTER TABLE manual_punch_requests ADD COLUMN local_date TEXT;
DROP INDEX manual_punch_in_progress;
CREATE UNIQUE INDEX manual_punch_user_day_active ON manual_punch_requests(user_id, local_date)
WHERE status IN ('running', 'uncertain');
