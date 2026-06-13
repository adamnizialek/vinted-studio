-- 0001_init.sql — sync envelope tables for Vinted Studio cross-device sync.
--
-- D1 is a sync transport, not a query engine: each entity is stored as one opaque
-- JSON envelope (`data`) plus the columns the sync protocol needs.
--   sync_stamp         server-monotonic, strictly increasing — drives the pull cursor.
--   content_updated_at client edit time (ms) — drives last-write-wins comparison.
--   deleted            tombstone (0/1) so deletions propagate across devices.
-- For `images`, `data` holds the ImageRecord WITHOUT the blob but WITH the inline thumb.
-- For `settings`, `data` is stored WITH geminiApiKey stripped (never leaves a device).

CREATE TABLE IF NOT EXISTS products (
  id                 TEXT    PRIMARY KEY,
  sync_stamp         INTEGER NOT NULL,
  content_updated_at INTEGER NOT NULL,
  deleted            INTEGER NOT NULL DEFAULT 0,
  data               TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_sync ON products(sync_stamp);

CREATE TABLE IF NOT EXISTS models (
  id                 TEXT    PRIMARY KEY,
  sync_stamp         INTEGER NOT NULL,
  content_updated_at INTEGER NOT NULL,
  deleted            INTEGER NOT NULL DEFAULT 0,
  data               TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_models_sync ON models(sync_stamp);

CREATE TABLE IF NOT EXISTS accounts (
  id                 TEXT    PRIMARY KEY,
  sync_stamp         INTEGER NOT NULL,
  content_updated_at INTEGER NOT NULL,
  deleted            INTEGER NOT NULL DEFAULT 0,
  data               TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_sync ON accounts(sync_stamp);

CREATE TABLE IF NOT EXISTS sales (
  id                 TEXT    PRIMARY KEY,
  sync_stamp         INTEGER NOT NULL,
  content_updated_at INTEGER NOT NULL,
  deleted            INTEGER NOT NULL DEFAULT 0,
  data               TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_sync ON sales(sync_stamp);

CREATE TABLE IF NOT EXISTS images (
  id                 TEXT    PRIMARY KEY,
  sync_stamp         INTEGER NOT NULL,
  content_updated_at INTEGER NOT NULL,
  deleted            INTEGER NOT NULL DEFAULT 0,
  data               TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_images_sync ON images(sync_stamp);

CREATE TABLE IF NOT EXISTS settings (
  id                 TEXT    PRIMARY KEY,
  sync_stamp         INTEGER NOT NULL,
  content_updated_at INTEGER NOT NULL,
  deleted            INTEGER NOT NULL DEFAULT 0,
  data               TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_settings_sync ON settings(sync_stamp);
