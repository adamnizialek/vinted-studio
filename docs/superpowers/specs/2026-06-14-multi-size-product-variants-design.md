# Połączone przedmioty w wielu rozmiarach („Model" + rozmiary) — Design

**Date:** 2026-06-14
**Status:** Approved (brainstorm) — pending spec review
**Author:** Adam + Claude

## Problem

Część asortymentu to **ten sam fason w kilku rozmiarach** (np. „Kurtka NYC" w S/M/L).
Dziś każdy rozmiar to osobny, niezależny `Product`: własne zdjęcia, opisy, marka,
kolor, materiał. Efekty:

- **Duplikacja pracy:** zdjęcia produktu i (kosztowne, płatne) zdjęcia na modelce
  AI trzeba robić/generować osobno dla każdego rozmiaru; opis pisać od nowa.
- **Bałagan w magazynie:** ten sam fason pojawia się jako wiele kart (na zrzucie
  „Kurtka NYC S" widnieje kilkukrotnie — wystawiona, w magazynie i sprzedana).
- **Rozjazd danych:** poprawka w opisie/marce jednego rozmiaru nie przenosi się
  na pozostałe.

Cel: **wspólna treść (zdjęcia, opisy, tożsamość) raz, współdzielona przez
wszystkie rozmiary**, przy zachowaniu rozmiaru jako osobnej jednostki sprzedaży
(każdy rozmiar = osobne ogłoszenie Vinted, sprzedawane niezależnie, możliwie na
innym koncie).

## Decyzje podjęte w brainstormingu

1. **Struktura: „grupa współdzieląca treść".** Nowa, w pełni synchronizowana encja
   **`Design`** (UI PL: **„Model"**) trzyma pola wspólne; każdy `Product` zyskuje
   `designId?` i pozostaje jednostką ogłoszenia/sprzedaży. Dzięki temu `Sale`,
   `SoldModal`, statusy i Dashboard działają **bez zmian**.
   *Odrzucono:* „jeden produkt z rozmiarami w środku" (status/konto/sprzedaż per
   rozmiar wewnątrz produktu — burzy założenie „Product = ogłoszenie" i rozlewa
   się po całej aplikacji oraz sync) i „luźny link + kopiuj" (brak źródła prawdy,
   dane się rozjeżdżają).
2. **Podział pól.**
   - **Wspólne (na `Design`):** `name`, `brand`, `color`, `material`, `category`,
     `tags`, `photoIds`, `generatedPhotoIds`, `descriptions`.
   - **Per rozmiar (na `Product`):** `sizeLabel`, `measurements`, `condition`,
     `listingPrice`, `purchasePrice`, `currency`, `quantity`, `status`,
     `accountId`, `listingUrl`, `listedAt`, `soldAt`. **Cena wystawienia, stan i
     cena zakupu są per rozmiar** (świadoma decyzja — pierwotnie rozważano cenę
     wspólną, odrzucono).
3. **Tworzenie grup: oba kierunki.** Oddolnie (zaznacz istniejące karty →
   „Połącz w jeden model") oraz odgórnie (w modelu „Dodaj rozmiar" tworzy nowy,
   powiązany `Product`).
4. **Magazyn: jedna karta na model.** Model zwija się do jednej karty z podsumowaniem
   rozmiarów/statusów; przedmioty pojedyncze renderują się jak dotąd.
5. **Nazewnictwo.** Encja w kodzie: `Design` / tabela `designs` (nazwa `models`
   jest zajęta przez `AiModel`). Etykieta w UI: **„Model"** (rodz. męski — odrębne
   od „Modelka"/`AiModel`).
6. **Zakres synchronizacji: pełny od razu** (wzorem `expenses`): `designs` w
   `SYNC_TABLES`, migracja D1 `0003_designs.sql`, objęte eksportem/importem JSON
   i „wyczyść wszystko".

## Model danych

`src/db/types.ts`:

```ts
/** Wspólny fason ("Model" w UI) — współdzielony przez warianty rozmiarowe.
 *  Trzyma to, co identyczne między rozmiarami: tożsamość, zdjęcia, opisy. */
export interface Design {
  id: ID
  name: string
  brand?: string
  color?: string
  material?: string
  category?: string
  tags: string[]
  /** Oryginalne zdjęcia produktu — współdzielone przez wszystkie rozmiary. */
  photoIds: ID[]
  /** Zdjęcia na modelce AI — współdzielone. */
  generatedPhotoIds: ID[]
  /** Zapisane opisy (jeden `active`) — współdzielone. */
  descriptions: SavedDescription[]
  createdAt: number
  updatedAt: number
}
```

Zmiany w istniejących typach:

```ts
export interface Product {
  // …
  /** Gdy ustawione: produkt jest rozmiarem należącym do modelu; pola wspólne
   *  czyta z `Design`, a własne `photoIds/generatedPhotoIds/descriptions` są puste. */
  designId?: ID
}

export interface ImageRecord {
  // …
  /** Backref dla porządków/kaskad, gdy obraz należy do modelu (współdzielony). */
  designId?: ID
}
```

**Niezmienność per-size:** dla produktu zgrupowanego pola wspólne na `Product`
(`name`, `brand`, `color`, `material`, `category`, `tags`, `photoIds`,
`generatedPhotoIds`, `descriptions`) są **wyczyszczone** w chwili grupowania i
nigdy nie zapisywane — jedynym źródłem prawdy jest `Design`. Eliminuje to rozjazd.

## Architektura i jednostki

```
                         ┌───────────────────────────────┐
                         │ Design (model)                │  ← źródło prawdy: wspólne pola,
                         │  photoIds, generatedPhotoIds, │     zdjęcia, opisy
                         │  descriptions, name/brand/…   │
                         └───────────────┬───────────────┘
                          designId ┌─────┼─────┐ designId
                                   ▼     ▼     ▼
                            Product  Product  Product   ← rozmiar = ogłoszenie/sprzedaż
                            (S)      (M)      (L)           per-size: size, ceny, stan,
                                                            status, konto, wymiary
                                   │
                    resolveProduct(product, designsById) → Product (zmerge'owany)
                                   │
        ┌──────────────┬──────────┴───────────┬──────────────┐
     Inventory     ProductEditor          PhotoStudio      prompts.ts
   (1 karta/model) (tryb modelu)      (zapis zdjęć do modelu) (bez zmian — dostaje resolved)
```

### `src/lib/designs.ts` (nowy) — czyste funkcje, w pełni testowalne

Bez importów Reacta/Dexie:

```ts
/** Pola, które dla zgrupowanego produktu pochodzą z Design (nie z Product). */
export const SHARED_FIELDS = [
  'name', 'brand', 'color', 'material', 'category', 'tags',
  'photoIds', 'generatedPhotoIds', 'descriptions',
] as const

/** Zwraca obiekt w kształcie Product: dla zgrupowanego nakłada pola wspólne z
 *  modelu, zachowuje pola per-size; dla samodzielnego zwraca produkt bez zmian. */
export function resolveProduct(
  product: Product,
  designsById: Map<ID, Design>,
): Product {
  if (!product.designId) return product
  const d = designsById.get(product.designId)
  if (!d) return product // model nie dotarł (sync) — bezpieczny fallback
  return {
    ...product,
    name: d.name,
    brand: d.brand,
    color: d.color,
    material: d.material,
    category: d.category,
    tags: d.tags,
    photoIds: d.photoIds,
    generatedPhotoIds: d.generatedPhotoIds,
    descriptions: d.descriptions,
  }
}
```

Konsumenci czytają zawsze obiekt **resolved**, więc istniejące buildery promptów
(`buildSeoTitle`, `buildDescriptionPrompt` w `src/lib/prompts.ts`) i kalkulator
ceny **nie wymagają zmian** — dostają Product-kształtny obiekt z poprawnymi
wartościami. Zapisy trasowane są ręcznie (patrz Editor): pole wspólne → `Design`,
pole per-size → `Product`.

### `src/db/db.ts` — encja + mutacje grupowania

- `designs!: Table<Design, string>`.
- Dexie: **`this.version(4).stores({ designs: 'id, createdAt, updatedAt' })`**;
  `SCHEMA_VERSION = 4`. Bump czysto addytywny (nowa pusta tabela, brak `upgrade`;
  `Product.designId` i `ImageRecord.designId` są opcjonalne, więc nie wymagają
  migracji rekordów).
- `EntityMap` += `designs: Design` (włącza generyczne `putEntity`/`patchEntity`/
  `deleteEntity`/`applyRemoteUpsert` dla modeli).
- `exportAll` / `importAll` / `clearAllData` obejmują `designs`. `clearImportedData`
  **bez zmian** (modele nie powstają z importu CSV).

Nowe operacje (w jednej transakcji `rw`, z kolejkowaniem `outbox` dla każdego
dotkniętego wiersza — wzorem `importStock`):

```ts
/** Łączy ≥2 SAMODZIELNE produkty w nowy model. `primaryId` zasiewa tożsamość;
 *  zdjęcia/opisy WSZYSTKICH członków są przenoszone do modelu (scalone, dedup po
 *  id, kolejność: najpierw primary), dokładnie jeden opis `active`. Każdy członek:
 *  designId = model.id; pola wspólne wyczyszczone; obrazy dostają designId. */
export async function groupProducts(productIds: ID[], primaryId: ID): Promise<Design>

/** Dodaje nowy, pusty rozmiar do modelu (odgórnie). Zwraca nowy Product
 *  (designId ustawione, pola per-size puste, status 'draft'). */
export async function addSizeToDesign(designId: ID, seed?: Partial<Product>): Promise<Product>

/** Rozłącza CAŁY model: każdy członek dostaje KOPIE pól wspólnych, KOPIE obrazów
 *  (klon bloba → nowy ImageRecord, by były samodzielne) i kopie opisów; następnie
 *  model i jego współdzielone obrazy są usuwane. Bezstratne. */
export async function dissolveDesign(designId: ID): Promise<void>

/** Kaskadowe usunięcie modelu: model + współdzielone obrazy + WSZYSCY członkowie. */
export async function deleteDesignCascade(designId: ID): Promise<void>
```

Korekta istniejącej `deleteProductCascade`:

- Produkt **zgrupowany** nie ma własnych obrazów (puste tablice), więc kasujemy
  tylko wiersz produktu; współdzielone obrazy modelu zostają nietknięte.
- Jeśli to **ostatni** członek modelu — domknij, wołając `deleteDesignCascade`
  (usuwa osierocony model i jego obrazy).
- Model 1-osobowy po usunięciu rodzeństwa pozostaje (karta „1 rozmiar"); użytkownik
  może go ręcznie „Rozłącz". (Auto-degradacja do samodzielnego wymagałaby klonowania
  obrazów — poza zakresem v1.)

Pomocnik klonowania (dla `dissolveDesign`): `cloneImage(id, { productId }): Promise<ID>`
— odczyt `ImageRecord` + blob, zapis nowego rekordu z nowym `id` i `productId`.

### Synchronizacja (pełna)

- `src/sync/core.ts`: dodaj `'designs'` do `SYNC_TABLES` (po `'products'`).
- `src/sync/serialize.ts`: **bez zmian** (przejście domyślne — `Design` nie ma pól
  lokalnych jak blob/klucz API).
- `src/sync/syncEngine.ts`, `functions/api/sync.ts`, `src/sync/protocol.ts`: **bez
  zmian** — iterują `SYNC_TABLES` generycznie, a serwer degraduje łagodnie, gdy
  tabela jeszcze nie istnieje (mechanizm już obecny dla `expenses`).
- **D1: nowa migracja `migrations/0003_designs.sql`** — koperta identyczna jak reszta:

  ```sql
  CREATE TABLE IF NOT EXISTS designs (
    id                 TEXT    PRIMARY KEY,
    sync_stamp         INTEGER NOT NULL,
    content_updated_at INTEGER NOT NULL,
    deleted            INTEGER NOT NULL DEFAULT 0,
    data               TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_designs_sync ON designs(sync_stamp);
  ```

- `src/sync/core.test.ts`: zaktualizuj oczekiwaną listę `SYNC_TABLES` o `designs`.
- `seedOutbox` — bez zmian (iteruje `SYNC_TABLES`, więc modele zasieją się same).

**Kolejność wdrożenia (krytyczna):** najpierw migracja D1 (`npm run db:migrate`),
**potem** deploy Functions/klienta (`npm run cf:deploy`). Odwrotnie → `maxStamp()`
odpyta nieistniejącą tabelę `designs` i (mimo łagodnej degradacji) lepiej tego
uniknąć. Komendy `wrangler` uruchamia właściciel.

### UI — Magazyn (`src/pages/Inventory.tsx`)

- `useLiveQuery` dodatkowo na `db.designs` → `designsById: Map`.
- **Grupowanie listy:** produkty z `designId` → grupy po `designId`; reszta jako
  pozycje samodzielne. Element renderowany = grupa **albo** produkt samodzielny.
  Sortowanie stabilne po `createdAt` (model: `design.createdAt`).
- **Filtry (dopasowanie „jeśli którykolwiek rozmiar pasuje"):**
  - status: grupa pasuje, gdy `members.some(p => p.status === status)`.
  - konto: grupa pasuje, gdy `members.some(p => p.accountId === accountId)`.
  - tekst: po `resolveProduct` modelu (name/brand/category/tags) **lub** dowolnym
    `member.sizeLabel`.
- **Karta modelu:** okładka `design.photoIds[0] ?? design.generatedPhotoIds[0]`;
  tytuł `design.name`; podtytuł `brand`; znacznik **„N rozmiarów"**; chipy statusów
  per rozmiar (np. „S wystawione · M w magazynie · L sprzedane"); cena jako zakres
  `min–max listingPrice` członków (lub „—"); badge „AI k" z
  `design.generatedPhotoIds.length`. Klik → `/magazyn/model/:designId`.
- **Tryb łączenia:** przycisk „Połącz" przełącza tryb zaznaczania → checkboxy na
  kartach **samodzielnych** produktów (v1: łączymy tylko samodzielne, nie istniejące
  modele). Po zaznaczeniu ≥2 → „Połącz w jeden model" → mały modal wyboru `primary`
  (miniatury + nazwy) → `groupProducts(ids, primaryId)` → nawigacja do modelu.
- Licznik w nagłówku („N przedmiotów") **dalej liczy fizyczne sztuki** (produkty),
  nie karty.

### UI — Edytor (`src/pages/ProductEditor.tsx`)

Dwa tryby. **Samodzielny** (`/magazyn/:id`, brak `designId`) = dzisiejszy edytor,
bez zmian. **Tryb modelu** (nowa trasa `/magazyn/model/:designId` — rejestracja w
routerze `src/App.tsx`):

- Ładuje `design` + członków (`db.products.where('designId').equals(id)`),
  posortowanych po `sizeLabel`/`createdAt`. Stan: `activeProductId`.
- **Przełącznik rozmiarów** u góry: chipy per członek (`sizeLabel` + kropka statusu)
  + **„+ Dodaj rozmiar"** (`addSizeToDesign`). Wybór ustawia aktywny rozmiar.
- Nagłówek: nazwa (wspólna → `Design`); selektor statusu / „Sprzedane" / „Usuń"
  działają na **aktywnym** produkcie; dodatkowo „Rozłącz model" (`dissolveDesign`)
  i „Usuń model" (`deleteDesignCascade`).
- **Trasowanie zapisów:** `updateShared(patch)` → `patchEntity('designs', …)`;
  `updateSize(patch)` → `patchEntity('products', activeId, …)`. (W trybie
  samodzielnym `updateShared` pisze do produktu.)
- Zakładki (reużyte):
  - **Szczegóły:** blok **„Wspólne dla wszystkich rozmiarów"** (marka, kategoria,
    kolor, materiał, tagi → `updateShared`) + blok **per rozmiar** (rozmiar, stan,
    cena wystawienia, cena zakupu, waluta, ilość, konto, wymiary, status, URL
    ogłoszenia → `updateSize`). Kalkulator ceny i tytuł SEO liczą z `resolveProduct`
    aktywnego rozmiaru.
  - **Zdjęcia:** `design.photoIds` / `generatedPhotoIds` (wspólne); dodawanie/
    usuwanie → `updateShared`, nowe obrazy dostają `designId`.
  - **Opisy:** `design.descriptions` (wspólne).
- Refaktor: wydzielić współdzielone pod-formularze (sekcja wspólna, sekcja
  per-size, sekcja zdjęć, sekcja opisów) tak, by oba tryby je reużywały i pliki
  pozostały skupione.

### UI — Studio (`src/pages/PhotoStudio.tsx`)

- Lista „Produkt" staje się listą **podmiotów**: po jednym wpisie na model
  (`design.name`) + produkty samodzielne. Wybrany podmiot dostarcza `photoIds`
  wejściowe (z `resolveProduct`) i przyjmuje wygenerowane zdjęcia.
- Zapis: gdy podmiot jest modelem (lub produktem z `designId`), nowy `ImageRecord`
  dostaje `{ designId }`, a `rec.id` trafia do `design.generatedPhotoIds`
  (`patchEntity('designs', …)`) → **wszystkie rozmiary natychmiast mają zdjęcie**.
  Dla samodzielnego — jak dziś (`product.generatedPhotoIds`).
- `canGenerate`/`removeGenerated`/podgląd liczą po obiekcie resolved.

### Sprzedaż (`src/components/SoldModal.tsx` / `productActions.ts`)

Przy tworzeniu `Sale` dla produktu zgrupowanego zdenormalizowana `productName` =
`resolved.name + " — " + sizeLabel` (np. „Kurtka NYC — M"), aby wpisy sprzedaży
były rozróżnialne. Reszta logiki sprzedaży/statusów **bez zmian** (Product wciąż
jednostką sprzedaży). `Dashboard` **bez zmian** strukturalnych — liczy produkty
indywidualnie, wartość magazynu sumuje `listingPrice` po wszystkich produktach.

## Algorytm grupowania (zasiew + scalanie)

`groupProducts(ids, primaryId)`:

1. Wczytaj produkty; `primary` = wskazany.
2. Utwórz `Design`: `name/brand/color/material/category` ← `primary`;
   `tags` = unia tagów wszystkich członków (dedup); `photoIds` = `primary.photoIds`
   ++ pozostali (dedup po id, primary pierwszy); `generatedPhotoIds` analogicznie;
   `descriptions` = `primary.descriptions` ++ pozostali (dedup po id), z dokładnie
   jednym `active` (wygrywa aktywny z primary; jeśli brak — pierwszy).
3. Każdemu obrazowi przeniesionemu do modelu ustaw `designId = model.id` (i wyczyść
   `productId`).
4. Każdy członek: `designId = model.id`; wyczyść pola wspólne (`photoIds=[]`,
   `generatedPhotoIds=[]`, `descriptions=[]`, `name=''`, `brand/color/material/
   category=undefined`, `tags=[]`). Pola per-size bez zmian.
5. Kolejkuj `outbox` dla modelu, każdego produktu i każdego przeniesionego obrazu.

## Obsługa błędów / przypadki brzegowe

- Łączenie wymaga ≥2 zaznaczonych produktów samodzielnych. Produkty już w modelu
  są w trybie łączenia niezaznaczalne (v1).
- Model bez dotarcia (sync): `resolveProduct` zwraca produkt bez nakładki (puste
  pola wspólne) — karta/edytor pokazują „—" zamiast się wywalić.
- Usunięcie ostatniego rozmiaru → `deleteDesignCascade` (brak osieroconego modelu).
- Wszystkie mutacje grupujące w jednej transakcji `rw`; błąd rolluje i toastuje.
- Idempotencja sync: model i produkty mają `updatedAt`; LWW jak reszta encji.

## Testy

- `src/lib/designs.test.ts`: `resolveProduct` (zgrupowany nakłada pola wspólne;
  samodzielny passthrough; brak modelu → fallback), zawartość `SHARED_FIELDS`.
- `src/db/writes.test.ts` (lub nowy `designs.test.ts`, fake-indexeddb):
  - `groupProducts`: zasiew+scalanie (dedup zdjęć/opisów, jeden `active`, unia
    tagów), wyczyszczenie pól wspólnych członków, `designId` na obrazach,
    kolejkowanie `outbox`.
  - `addSizeToDesign`: nowy produkt z `designId`, pola per-size puste.
  - `dissolveDesign`: każdy członek dostaje KOPIE pól/obrazów (klon bloba, nowe id)
    i opisów; model + obrazy współdzielone usunięte.
  - `deleteProductCascade` na zgrupowanym: model nietknięty; ostatni członek →
    model usunięty.
  - `deleteDesignCascade`: model + obrazy + członkowie usunięci, tombstony w outbox.
- `src/db/upgrade.test.ts`: bump do v4 (addytywny; istniejące produkty bez
  `designId` działają).
- `src/sync/core.test.ts`: `SYNC_TABLES` zawiera `designs`.
- export/import JSON roundtrip obejmuje `designs`.

## Poza zakresem (świadomie)

- **Warianty wieloatrybutowe** (rozmiar **i** kolor naraz). Inny kolor = osobny model.
- **Auto-grupowanie przy imporcie magazynu** po nazwie (importowane produkty są
  samodzielne).
- **Łączenie istniejących modeli** / przenoszenie rozmiaru między modelami.
- **Auto-degradacja modelu 1-osobowego** do samodzielnego (wymaga klonowania obrazów).
- **Sugestia ceny ze wspólnego defaultu modelu** / hurtowe wystawianie całego modelu.
- Zmiany backendu poza migracją `0003` (Functions są generyczne).
