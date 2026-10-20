CREATE TABLE punch_guards (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('entry', 'exit')),
  token TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, local_date, action)
);
CREATE UNIQUE INDEX punch_guard_user_active ON punch_guards(user_id)
WHERE status IN ('pending', 'uncertain');
