ALTER TABLE notifications ADD COLUMN push_state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE notifications ADD COLUMN push_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notifications ADD COLUMN push_updated_at INTEGER;
UPDATE notifications SET push_state = 'sent';
CREATE UNIQUE INDEX push_endpoint_unique ON push_subscriptions(endpoint);
CREATE TABLE push_deliveries (
  notice_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  PRIMARY KEY (notice_id, subscription_id)
);
