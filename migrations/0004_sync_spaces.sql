-- 0004_sync_spaces.sql — wieloosobowa synchronizacja na jednym deploymencie.
--
-- Każdy token synchronizacji dostaje własną, odizolowaną PRZESTRZEŃ danych. Zapisujemy ją
-- w kolumnie `space`, a dodatkowo prefiksujemy nią `id` (patrz functions/api/_lib/space.ts):
--   * kolumna `space` daje tani, indeksowalny filtr przy odczycie,
--   * prefiks w `id` (kluczu głównym) gwarantuje, że dwie przestrzenie NIE nadpiszą sobie
--     wiersza o tym samym identyfikatorze — id pochodzą od klienta, więc mogą się powtórzyć
--     (np. po zaimportowaniu cudzej kopii zapasowej).
--
-- Przestrzeń właściciela to pusty string — czyli DOKŁADNIE to, co już leży w tabelach.
-- Dlatego DEFAULT '' i żadnego przepisywania istniejących wierszy: dane działają dalej.

ALTER TABLE products ADD COLUMN space TEXT NOT NULL DEFAULT '';
ALTER TABLE designs  ADD COLUMN space TEXT NOT NULL DEFAULT '';
ALTER TABLE models   ADD COLUMN space TEXT NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN space TEXT NOT NULL DEFAULT '';
ALTER TABLE sales    ADD COLUMN space TEXT NOT NULL DEFAULT '';
ALTER TABLE expenses ADD COLUMN space TEXT NOT NULL DEFAULT '';
ALTER TABLE images   ADD COLUMN space TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN space TEXT NOT NULL DEFAULT '';

-- Pull czyta zawsze „wiersze mojej przestrzeni nowsze niż kursor" — indeks pod ten kształt.
CREATE INDEX IF NOT EXISTS idx_products_space_sync ON products(space, sync_stamp);
CREATE INDEX IF NOT EXISTS idx_designs_space_sync  ON designs(space, sync_stamp);
CREATE INDEX IF NOT EXISTS idx_models_space_sync   ON models(space, sync_stamp);
CREATE INDEX IF NOT EXISTS idx_accounts_space_sync ON accounts(space, sync_stamp);
CREATE INDEX IF NOT EXISTS idx_sales_space_sync    ON sales(space, sync_stamp);
CREATE INDEX IF NOT EXISTS idx_expenses_space_sync ON expenses(space, sync_stamp);
CREATE INDEX IF NOT EXISTS idx_images_space_sync   ON images(space, sync_stamp);
CREATE INDEX IF NOT EXISTS idx_settings_space_sync ON settings(space, sync_stamp);
