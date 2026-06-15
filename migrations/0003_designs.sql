-- 0003_designs.sql — koperta sync dla modeli (Design): wspoldzielony fason w wielu rozmiarach.
CREATE TABLE IF NOT EXISTS designs (
  id                 TEXT    PRIMARY KEY,
  sync_stamp         INTEGER NOT NULL,
  content_updated_at INTEGER NOT NULL,
  deleted            INTEGER NOT NULL DEFAULT 0,
  data               TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_designs_sync ON designs(sync_stamp);
