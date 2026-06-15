# Powrót sprzedanego przedmiotu do magazynu przy zwrocie — Design

**Date:** 2026-06-15
**Status:** Approved (brainstorm) — pending spec review
**Author:** Adam + Claude

## Problem

Gdy kupujący zwraca przedmiot (zwrot / reklamacja), sprzedaż przestaje być
finalna. Dziś można oznaczyć wpis sprzedaży statusem **„Zwrot"** — i finansowo
działa to poprawnie: `countsAsRevenue()` wyklucza `returned` z przychodu i zysku
wszędzie (ewidencja, konta, Dashboard). **Ale powiązany przedmiot zostaje
„zamrożony" w statusie `sold`** — nie wraca do magazynu, więc nie da się go
ponownie wystawić ani policzyć w stanie magazynowym. Trzeba ręcznie odszukać go
w Magazynie i przestawić status.

Cel: oznaczenie sprzedaży jako **Zwrot** ma **automatycznie cofnąć powiązany
przedmiot do magazynu** (`in_stock`), gotowy do ponownego wystawienia.

## Decyzje podjęte w brainstormingu

1. **Wyzwalacz: status w edytorze sprzedaży.** Brak nowego przycisku. W
   **Ewidencji sprzedaży** otwierasz wpis → ustawiasz **Status = „Zwrot"** →
   **Zapisz**. Zapis ma efekt uboczny: cofa powiązany przedmiot do magazynu.
   *Odrzucono:* dedykowany przycisk „Zwrot" w wierszu, sterowanie od strony
   Magazynu (zmiana `Sprzedane → W magazynie` cofająca sprzedaż).
2. **Stan docelowy: `in_stock` (W magazynie).** Po zwrocie przedmiot wraca do
   magazynu, gotowy do ponownego wystawienia. Na Vinted oryginalne ogłoszenie po
   sprzedaży i tak znika, więc i tak trzeba wystawić od nowa.
   *Odrzucono:* `listed` (Wystawione) oraz pytanie za każdym razem.
3. **Jednokierunkowo, tylko `Zwrot`.** Restock uruchamia **wyłącznie** przejście
   sprzedaży w status `returned`. **`Anulowana` (`cancelled`) nie rusza
   przedmiotu**, a cofnięcie zwrotu (`returned → completed/pending`) **nie**
   oznacza go automatycznie z powrotem jako `sold`.
   *Odrzucono:* reguła symetryczna „po przychodzie" oraz `Zwrot + Anulowana`.
4. **Tylko realne przejście.** Restock odpala się jedynie, gdy **poprzedni
   zapisany** status wpisu **nie był** `returned`, a nowy **jest** `returned`.
   Edycja ceny/notatek przy wpisie już oznaczonym jako Zwrot nie rusza przedmiotu.
5. **Ostrożny restock.** Przedmiot wraca do magazynu **tylko jeśli istnieje i ma
   aktualnie status `sold`.** Jeśli został usunięty, niepowiązany albo już
   przestawiony ręcznie (np. ponownie wystawiony / sprzedany) — zostaje
   nietknięty, a wpis i tak zapisuje się jako Zwrot.

## Zakres zmian

Trzy pliki, **bez zmian schematu i bez migracji** — statusy `returned`
(`Sale`) i `in_stock` (`Product`) oraz powiązanie `Sale.productId` już istnieją.

### 1. `src/lib/productActions.ts`

Dwie nowe, jednostkowo testowalne jednostki (styl jak `applyStatusChange` /
`assignAccount`):

```ts
/**
 * Czysta reguła decyzyjna: czy zapis wpisu sprzedaży ma cofnąć przedmiot do
 * magazynu. Prawda wyłącznie przy realnym przejściu w 'returned' z powiązanym
 * przedmiotem — by edycja innych pól zwróconego wpisu nie ruszała magazynu.
 */
export function shouldRestockOnSave(
  prevStatus: SaleStatus,
  nextStatus: SaleStatus,
  hasProduct: boolean,
): boolean {
  return hasProduct && nextStatus === 'returned' && prevStatus !== 'returned'
}

/**
 * Cofa przedmiot do magazynu po zwrocie. Przestawia status na 'in_stock'
 * WYŁĄCZNIE gdy przedmiot istnieje i jest aktualnie 'sold' (nie nadpisuje
 * przedmiotu, który użytkownik już przeniósł). Zwraca, czy faktycznie cofnięto.
 */
export async function restockOnRefund(productId: ID): Promise<boolean> {
  const product = await db.products.get(productId)
  if (!product || product.status !== 'sold') return false
  await patchEntity('products', productId, { status: 'in_stock' })
  return true
}
```

`restockOnRefund` korzysta z `patchEntity`, więc zmiana trafia do `outbox` i
synchronizuje się między urządzeniami (jak każdy zapis użytkownika).

### 2. `src/pages/Sales.tsx` — `SaleModal`

`save()` porównuje **pierwotny** status (`sale.status` z propsa — ustawiany raz
przy otwarciu przez `setEditing`) z `form.status`:

```ts
const save = async () => {
  if (!form.productName.trim()) return toast.error('Podaj nazwę produktu.')
  if (!form.salePrice || form.salePrice <= 0) return toast.error('Podaj cenę sprzedaży.')
  await putEntity('sales', form)
  let restocked = false
  if (shouldRestockOnSave(sale!.status, form.status, !!form.productId)) {
    restocked = await restockOnRefund(form.productId!) // helper gwarantuje productId
  }
  onClose()
  toast.success(restocked ? 'Zwrot zapisany — przedmiot wrócił do magazynu 📦' : 'Zapisano sprzedaż.')
}
```

Dodatkowo, gdy w modalu wybrany jest `Zwrot` **i** wpis ma powiązany przedmiot,
pod polem statusu pokazujemy delikatną podpowiedź:
*„Po zapisaniu przedmiot wróci do magazynu."* — dla przewidywalności efektu.

(`SaleModal` dostaje `sale` jako prop; do detekcji przejścia używamy jego
oryginalnego `status`. Dla nowego wpisu `sale.status === 'completed'` i brak
`productId`, więc restock nie odpali.)

### 3. Brak zmian w `types.ts` / schemacie / D1

Wszystkie potrzebne pola i statusy już są.

## Przepływ danych

```
SaleModal.save()
  └─ putEntity('sales', form)                      // zapis wpisu (+ outbox, sync)
  └─ jeśli przejście w 'returned' i jest productId:
       restockOnRefund(productId)
         └─ jeśli product.status === 'sold':
              patchEntity('products', id, { status: 'in_stock' })  // (+ outbox, sync)
```

Dwa niezależne zapisy — dokładnie jak dziś w `SoldModal` (zapis `Sale`, potem
osobne przestawienie `Product`). Każdy synchronizuje się osobno; aplikacja jest
local-first, więc rozdzielone transakcje są spójne z istniejącym wzorcem.

## Przypadki brzegowe i obsługa błędów

- **Brak `productId`** (wpis ręczny lub z importu CSV/arkusza) → zapis jako Zwrot,
  zwykły toast, nic do cofnięcia.
- **Przedmiot usunięty / nieznaleziony** → `restockOnRefund` zwraca `false`,
  zwykły toast.
- **Przedmiot powiązany, ale nie `sold`** (już ponownie wystawiony/sprzedany) →
  pozostaje nietknięty (brak nadpisania), zwykły toast.
- **Ponowny zapis wpisu już w `Zwrot`** → to nie przejście, restock nie odpala —
  nie cofnie przedmiotu, który po zwrocie ponownie sprzedano.
- **Model wielorozmiarowy** → `Sale.productId` wskazuje konkretny rozmiar
  (`Product` z `designId`); cofa się dokładnie ten rozmiar, reguła bez zmian.

## Wpływ na resztę aplikacji

- **Dashboard / Magazyn:** cofnięty przedmiot automatycznie wraca do liczników
  „w magazynie" i wartości magazynu (znów `in_stock`) — bez dodatkowej pracy.
- **Finanse:** bez zmian — `countsAsRevenue()` już wyklucza `returned`.

## Testy (TDD)

`src/lib/productActions.test.ts`:

- `shouldRestockOnSave`: `true` tylko gdy `prev !== 'returned' && next === 'returned' && hasProduct`; `false` dla pozostałych kombinacji (m.in. `completed→cancelled`, `returned→returned`, brak przedmiotu).
- `restockOnRefund`: przestawia `sold → in_stock` i zwraca `true`; zwraca `false`
  (no-op) gdy przedmiot nie istnieje oraz gdy nie jest `sold`; po cofnięciu w
  `outbox` pojawia się wpis dla `products` (jak przy zwykłym `patchEntity`).

## Poza zakresem (YAGNI)

Zwroty częściowe / po ilości, restock od strony Magazynu, restock przy
`Anulowana`, automatyczne cofanie zwrotu, księgowanie kosztów/opłat zwrotu.
