CREATE TABLE manual_punch_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('entry', 'exit')),
  status TEXT NOT NULL,
  response TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX manual_punch_in_progress ON manual_punch_requests(user_id)
WHERE status IN ('running', 'uncertain');
