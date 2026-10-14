PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  pin_ciphertext TEXT NOT NULL,
  pin_iv TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  margin_seconds INTEGER NOT NULL DEFAULT 60 CHECK (margin_seconds BETWEEN 0 AND 3600),
  time_zone TEXT NOT NULL DEFAULT 'Europe/Madrid',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE schedules (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  entry_time TEXT NOT NULL CHECK (entry_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  exit_time TEXT NOT NULL CHECK (exit_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  PRIMARY KEY (user_id, weekday)
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('entry', 'exit')),
  target_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'claimed', 'running', 'success', 'failed', 'uncertain', 'skipped', 'missed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,
  executed_at INTEGER,
  timenet_time TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, local_date, action)
);

CREATE INDEX jobs_due_idx ON jobs(status, target_at);
CREATE INDEX jobs_user_date_idx ON jobs(user_id, local_date DESC);

CREATE TABLE punch_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  local_date TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('entry', 'exit')),
  source TEXT NOT NULL CHECK (source IN ('automatic', 'manual', 'unknown')),
  recorded_time TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX punch_events_user_date_idx ON punch_events(user_id, local_date DESC, recorded_time);
CREATE UNIQUE INDEX punch_events_unique_idx ON punch_events(user_id, local_date, action, source, recorded_time);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('success', 'warning', 'error', 'info')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);

CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC);

CREATE TABLE scheduler_runs (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed')),
  users_scanned INTEGER NOT NULL DEFAULT 0,
  jobs_created INTEGER NOT NULL DEFAULT 0,
  jobs_processed INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  error_message TEXT
);

CREATE INDEX scheduler_runs_started_idx ON scheduler_runs(started_at DESC);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_error TEXT
);
