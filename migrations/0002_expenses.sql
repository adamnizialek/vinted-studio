-- 0002_expenses.sql — sync envelope table for promotion/expense tracking.
-- Same shape as the other entity tables (see 0001_init.sql).

CREATE TABLE IF NOT EXISTS expenses (
  id                 TEXT    PRIMARY KEY,
  sync_stamp         INTEGER NOT NULL,
  content_updated_at INTEGER NOT NULL,
  deleted            INTEGER NOT NULL DEFAULT 0,
  data               TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expenses_sync ON expenses(sync_stamp);
