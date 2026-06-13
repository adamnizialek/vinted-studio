# Śledzenie kosztów promocji (podbicia / ekspozycja) — Design

**Date:** 2026-06-13
**Status:** Approved (brainstorm) — pending spec review
**Author:** Adam + Claude

## Problem

Importując sprzedaż z arkuszy Main/Zoos, wiersze opłat promocyjnych Vinted
(`Podbicia`, `Ekspozycja`, `Podbicia main`, `podbica`) trafiają do kubełka
„Pominięte — nie sprzedaż" i są **w całości odrzucane razem z kwotą kosztu**.
Zweryfikowano na realnych plikach użytkownika:

| Plik | Sprzedaże | Wiersze opłat | Suma opłat |
|------|-----------|---------------|------------|
| Main.xlsx | 57 | 17 | **288,48 zł** |
| Zoos.xlsx | 31 | 6 | **133,49 zł** |

Łącznie **421,97 zł** realnych kosztów reklamy znika z rachunku zysku, więc zysk
netto w aplikacji jest zawyżony. Użytkownik chce te koszty śledzić, aby marże
były prawdziwe.

Drugi, powiązany objaw: **„koszt zakupu jest pomijany"**. To NIE jest błąd —
koszt zakupu (kolumna C, `Cena zaukupu`) jest poprawnie parsowany i zapisywany
dla każdego sprzedanego wiersza (57/57 i 31/31). Wygląda na pominięty wyłącznie
dlatego, że **podgląd importu pokazuje tylko datę i cenę sprzedaży** — koszt
zakupu nie jest nigdzie widoczny przed zapisem. Rozwiązanie: pokazać go w
podglądzie (i wynikowy zysk), aby użytkownik mógł zweryfikować marżę.

## Decyzje podjęte w brainstormingu

1. **Model danych:** dedykowana, w pełni synchronizowana tabela `expenses`
   (osobna encja, wzorem `sales`/`products`) — nie domieszka do `sales`.
   *Odrzucono:* „opłata jako wiersz sprzedaży" (zaśmieca ewidencję, wymaga
   warunkowania w wielu miejscach) oraz „miesięczna kwota zbiorcza" (brak
   historii per-wiersz, brak idempotentnego re-importu).
2. **Zakres synchronizacji:** **pełny sync od razu.** `expenses` dołącza do
   `SYNC_TABLES`, dochodzi migracja D1 `0002_expenses.sql`. Koszty są też objęte
   eksportem/importem JSON i „wyczyść wszystko".
3. **Źródło opłat:** wyłącznie arkusze sprzedaży per-konto (Main/Zoos) w
   `ImportSalesModal`. Import magazynu (`finessin`) dalej wyklucza opłaty — aby
   nie liczyć ich podwójnie.
4. **Widoczność kosztu zakupu:** podgląd importu pokazuje koszt zakupu i zysk
   dla wierszy gotowych/sprzedanych (poprawka czysto UI; dane bez zmian).

## Model danych

Nowa encja w `src/db/types.ts`:

```ts
export type ExpenseKind = 'boost' | 'exposure' | 'other' // podbicie / ekspozycja / inne

export interface Expense {
  id: ID
  /** Konto, którego dotyczy koszt (z importu = wybrane konto; ręczny = opcjonalny). */
  accountId?: ID
  kind: ExpenseKind
  /** Oryginalna nazwa z arkusza ("Podbicia", "Ekspozycja", "Podbicia main"). */
  description: string
  /** Kwota kosztu w zł (z kolumny C arkusza). */
  amount: number
  currency: string
  /** Data poniesienia (ms, lokalne południe — spójnie ze sprzedażą). */
  incurredAt: number
  notes?: string
  createdAt: number
  updatedAt: number
  /** Klucz treści wiersza — do idempotentnego re-importu. */
  importKey?: string
}
```

`kind` wyprowadzany z nazwy: `/podbic/i` → `boost`, `/ekspozycj/i` → `exposure`,
inaczej `other`. Etykiety PL w `constants.ts` (`EXPENSE_KIND_LABELS`).

## Architektura i jednostki

```
XLSX/CSV ─▶ readWorkbook ─▶ parseSalesTable (bez zmian klasyfikacji)
                                   │
                ┌──────────────────┴───────────────────┐
          wiersze sprzedaży                      wiersze opłat (bucket 'excluded', reason 'fee')
                │                                       │
          DraftSale[]                          parseExpenseDrafts(rows) ─▶ DraftExpense[]
                │                                       │
        importSales(...)                        importExpenses(drafts, accountId)
                │                                       │
          Dexie `sales`                          Dexie `expenses`
                └───────────────┬───────────────────────┘
                       aggregateProfit(sales, expenses)  (format.ts)
                                 │
                     Sales page + Dashboard (Koszty/Zysk/Marża netto)
```

### `src/lib/salesImport.ts` — wyprowadzenie szkiców kosztów

`classifyRow` już rozpoznaje opłaty (`excluded`, `excludedReason: 'fee'`),
parsuje `purchaseCost` (= kwota opłaty) i `dateTs`. Dodajemy:

- `expenseKindOf(name: string): ExpenseKind` — czysta funkcja mapująca nazwę.
- `parseExpenseDrafts(rows: ParsedRow[]): DraftExpense[]` — z wierszy
  `bucket === 'excluded' && excludedReason === 'fee'` buduje szkice; pomija te
  bez kwoty (`purchaseCost == null`). Brak daty → `incurredAt: null` (kubełek
  „do sprawdzenia", jak przy sprzedaży).
- `DraftExpense { incurredAt: number | null; description; amount; kind }`.
- `expenseImportKey(accountId, incurredAt, kind, description, amount): string` —
  wzorem `saleImportKey` (data dzienna, znormalizowany opis).

Bez importów Reacta/Dexie. W pełni testowalne jednostkowo.

### `src/db/types.ts` / `src/db/db.ts`

- Dodaj `Expense`, `ExpenseKind`.
- Dexie: `expenses!: Table<Expense, string>`; **`this.version(3).stores({
  expenses: 'id, accountId, incurredAt, createdAt' })`**; `SCHEMA_VERSION = 3`.
  Bump jest czysto addytywny (nowa pusta tabela, brak `upgrade`).
- `EntityMap` += `expenses: Expense` (włącza `putEntity`/`patchEntity`/
  `deleteEntity`/`applyRemoteUpsert` dla kosztów — gałąź generyczna).
- `exportAll` / `importAll` / `clearAllData` obejmują `expenses`.
- Nowa `importExpenses(drafts: DraftExpense[], accountId): Promise<{ inserted,
  skippedDuplicates }>` — lustrzane wobec `importSales`: multizbiorowa
  deduplikacja po `importKey`, jedna transakcja `rw`, kolejkowanie do `outbox`.
  Pomija szkice bez `incurredAt` (UI ich nie przekazuje).

### Synchronizacja (pełna)

- `src/sync/core.ts`: dodaj `'expenses'` do `SYNC_TABLES` (po `'sales'`).
- `src/sync/serialize.ts`: bez zmian (przejście domyślne — koszty nie mają pól
  lokalnych jak blob/klucz API).
- `src/sync/syncEngine.ts`, `functions/api/sync.ts`, `protocol.ts`: bez zmian —
  iterują `SYNC_TABLES` generycznie.
- **D1: nowa migracja `migrations/0002_expenses.sql`** — koperta identyczna jak
  pozostałe tabele:

  ```sql
  CREATE TABLE IF NOT EXISTS expenses (
    id                 TEXT    PRIMARY KEY,
    sync_stamp         INTEGER NOT NULL,
    content_updated_at INTEGER NOT NULL,
    deleted            INTEGER NOT NULL DEFAULT 0,
    data               TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_expenses_sync ON expenses(sync_stamp);
  ```

- `src/sync/core.test.ts` (linia ~36): zaktualizuj listę oczekiwanych tabel o
  `expenses`.

**Kolejność wdrożenia (krytyczna):** najpierw migracja D1
(`npm run db:migrate`), **potem** deploy Functions/klienta (`npm run cf:deploy`).
Odwrotna kolejność spowoduje, że `maxStamp()` wykona `SELECT MAX(sync_stamp)
FROM expenses` na nieistniejącej tabeli i **zerwie cały sync** do czasu migracji.
Komendy `wrangler` (uwierzytelniane) uruchamia właściciel; na bieżącym hostingu
Vercel `/api/sync` nie istnieje, więc koszty pozostają lokalne (jak reszta
danych) do czasu uruchomienia backendu Cloudflare — to oczekiwane.

### Rachunek zysku — `src/lib/format.ts`

`aggregateProfit` zyskuje opcjonalny drugi argument:

```ts
export function aggregateProfit(sales: Sale[], expenses: Expense[] = []): ProfitBreakdown
```

- `revenue` — bez zmian (koszty promocji nie są przychodem).
- `costs` — koszty sprzedaży **+ suma `expenses[].amount`**.
- `profit = revenue − costs`; `margin = revenue > 0 ? profit / revenue : 0`.

Istniejące wywołania bez drugiego argumentu działają jak dotąd. Strony
przekazują koszty przefiltrowane tym samym zakresem (konto + okres) co sprzedaż.

### UI

**`src/components/ImportSalesModal.tsx`:**
- Kubełek opłat „Pominięte — nie sprzedaż" → **„Koszty promocji (N)"**,
  domyślnie zaznaczony, z checkboxami. Pokazuje datę i kwotę (`amount`).
- Po imporcie: oprócz `importSales(saleDrafts, accountId)` woła
  `importExpenses(expenseDrafts, accountId)`; toast sumuje oba wyniki
  („Zaimportowano: N sprzedaży, M kosztów").
- Wiersze opłat bez kwoty/daty → kubełek „Do sprawdzenia" (edytowalne) lub
  pominięte, jeśli bez kwoty.
- **Podgląd kosztu zakupu:** `RowLine` dla wierszy gotowych pokazuje obok ceny
  sprzedaży mały `koszt → zysk` (np. „−22,40 → 32,60"), aby zweryfikować marżę.

**`src/pages/Sales.tsx`:**
- `useLiveQuery` na `db.expenses`; `filteredExpenses` filtrowane jak `filtered`
  (konto + okres).
- Karty statystyk (Przychód/Koszty/Zysk/Marża) liczone przez
  `aggregateProfit(filtered, filteredExpenses)` — netto po promocji.
- Nowa sekcja **„Koszty promocji"** pod tabelą sprzedaży: lista kosztów w
  bieżącym widoku z kwotą, datą, rodzajem; przyciski **Dodaj koszt / edytuj /
  usuń** (mały modal wzorem `SaleModal`, pola: opis, kwota, rodzaj, konto, data,
  notatka). Eksport CSV sprzedaży bez zmian (koszty mają własny, opcjonalny
  eksport w przyszłości — poza zakresem).

**`src/pages/Dashboard.tsx`:**
- `useLiveQuery` na `db.expenses`.
- `monthAgg`, `totalAgg`, `perAccount` przekazują koszty przefiltrowane
  odpowiednio (miesiąc / wszystko / per-konto), więc „Zysk (mies.)",
  „Zysk łącznie" i „zysk" per-konto są netto. Wykres przychodu — bez zmian.

## Mapowanie pól (opłata → `Expense`)

| Pole `Expense` | Źródło |
|----------------|--------|
| `id` | `uid()` |
| `accountId` | wybrane konto importu |
| `kind` | `expenseKindOf(nazwa)` |
| `description` | nazwa wiersza (verbatim) |
| `amount` | kolumna `Cena zaukupu` (kwota opłaty) |
| `incurredAt` | parsowana data |
| `currency` | `PLN` |
| `importKey` | klucz treści |
| `createdAt` | `Date.now()` przy imporcie |

## Obsługa błędów

- Opłata bez kwoty → pomijana w imporcie (nie tworzymy kosztu „0").
- Opłata bez/niepoprawna data → kubełek „Do sprawdzenia" (edycja daty) — jak
  sprzedaż.
- `importExpenses` w jednej transakcji; błąd rolluje i toastuje.
- Ponowny import tego samego pliku → idempotentny (multizbiorowa deduplikacja).

## Testy

- `salesImport.test.ts`: `expenseKindOf` (warianty nazw), `parseExpenseDrafts`
  (z `FINESSIN`/`SAMPLE` wyłuskuje opłaty z kwotą i datą; pomija bez kwoty),
  `expenseImportKey` (stabilność).
- `format.test.ts` (lub odpowiednik): `aggregateProfit(sales, expenses)` —
  koszty wchodzą do `costs`, obniżają `profit`/`margin`; pusta lista = stare
  zachowanie.
- `importExpenses.test.ts` (fake-indexeddb): wstawia koszty, idempotentny
  re-import, separacja per-konto, kolejkowanie outboxu, `PLN`.
- `sync/core.test.ts`: lista `SYNC_TABLES` zawiera `expenses`.

## Poza zakresem (świadomie)

- Import opłat z arkusza `finessin` (uniknięcie podwójnego liczenia).
- Osobny eksport CSV kosztów (łatwy do dodania później).
- Kategorie kosztów inne niż promocja (wysyłka, opakowania) — `kind: 'other'`
  istnieje, ale UI skupia się na promocji.
- Zmiany backendu poza migracją `0002` (Functions są generyczne).
