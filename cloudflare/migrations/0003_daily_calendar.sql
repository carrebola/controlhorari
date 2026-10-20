CREATE TABLE calendar_days (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL,
  label TEXT NOT NULL,
  entry_time TEXT,
  exit_time TEXT,
  random_entry_at INTEGER,
  random_exit_at INTEGER,
  margin_seconds INTEGER NOT NULL,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, local_date)
);

ALTER TABLE jobs ADD COLUMN planned_at INTEGER;
UPDATE jobs SET planned_at = target_at;
