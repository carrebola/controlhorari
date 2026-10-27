ALTER TABLE jobs ADD COLUMN reviewed_retry_used INTEGER NOT NULL DEFAULT 0 CHECK (reviewed_retry_used IN (0, 1));
