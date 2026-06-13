// Centralne typy domenowe aplikacji Vinted Studio.
// Wszystkie obrazy (zdjecia produktow, modelki, wygenerowane) trzymamy jako
// osobne rekordy Blob w tabeli `images` i odwolujemy sie do nich po `id`,
// dzieki czemu obiekty produktow/modelek pozostaja lekkie.

export type ID = string

/** Stan przedmiotu w obiegu sprzedazowym. */
export type ProductStatus =
  | 'draft' // szkic / w opracowaniu
  | 'in_stock' // w magazynie, gotowe
  | 'listed' // wystawione na Vinted
  | 'reserved' // zarezerwowane przez kupujacego
  | 'sold' // sprzedane
  | 'archived' // wycofane / niedostepne

/** Stan zgodny ze slownikiem Vinted. */
export type Condition =
  | 'nowy_z_metka'
  | 'nowy_bez_metki'
  | 'bardzo_dobry'
  | 'dobry'
  | 'zadowalajacy'

/** Rodzaj obrazu — uzywany do filtrowania galerii. */
export type ImageKind = 'product' | 'generated' | 'model' | 'reference'

export interface ImageRecord {
  id: ID
  blob: Blob
  mime: string
  width: number
  height: number
  /** Mala miniatura (data URL) do szybkiego renderu list bez ladowania pelnego bloba. */
  thumb: string
  kind: ImageKind
  /** Powiazanie pomocnicze (opcjonalne) dla porzadkow/kaskad. */
  productId?: ID
  modelId?: ID
  /** Metadane generacji (gdy kind === 'generated'). */
  meta?: GeneratedImageMeta
  createdAt: number
}

export interface GeneratedImageMeta {
  modelId?: ID
  prompt: string
  imageModel: string
  /** id zdjec wejsciowych (produkt + ew. dodatkowe). */
  sourceImageIds: ID[]
}

/** Konto sprzedazowe (np. dwie osoby / dwa profile Vinted). */
export interface Account {
  id: ID
  name: string
  vintedUsername?: string
  /** Kolor akcentu w UI (hex). */
  color: string
  /** Domyslna prowizja/oplata platnosci kupujacego — pomocniczo w kalkulacjach. */
  notes?: string
  createdAt: number
}

/** Zapisana modelka AI — zestaw zdjec referencyjnych zapewniajacych spojnosc postaci. */
export interface AiModel {
  id: ID
  name: string
  /** Krotki opis wygladu — wstrzykiwany do promptu dla spojnosci. */
  appearance?: string
  /** id zdjec referencyjnych (kind: 'reference' lub 'model'). */
  referenceImageIds: ID[]
  /** id zdjecia okladkowego (jedno z referencyjnych). */
  coverImageId?: ID
  /** Dodatkowe wskazowki do promptu (poza, oswietlenie, tlo). */
  promptNotes?: string
  createdAt: number
  updatedAt: number
}

/** Zapisany opis produktu w danym stylu. */
export interface SavedDescription {
  id: ID
  styleId: string
  styleLabel: string
  title?: string
  text: string
  /** Czy to aktualnie wybrany / "produkcyjny" opis dla tego produktu. */
  active: boolean
  createdAt: number
}

/** Wymiary produktu (cm) — kupujacy na Vinted czesto o nie pytaja. */
export interface Measurements {
  chest?: number // szerokosc w klatce / w pasie (plasko)
  length?: number // dlugosc
  sleeve?: number // dlugosc rekawa
  waist?: number
  hips?: number
  inseam?: number // dlugosc nogawki wewn.
  shoulders?: number
  footLength?: number // dlugosc wkladki (buty)
  custom?: string // dowolny dodatkowy opis
}

export interface Product {
  id: ID
  sku?: string
  name: string
  brand?: string
  category?: string
  sizeLabel?: string
  color?: string
  material?: string
  condition: Condition
  measurements?: Measurements
  /** Cena zakupu (koszt) — do liczenia marzy. */
  purchasePrice?: number
  /** Cena wystawienia / oczekiwana. */
  listingPrice?: number
  currency: string
  quantity: number
  status: ProductStatus
  /** Konto, do ktorego przypisany jest przedmiot (opcjonalne). */
  accountId?: ID
  /** Oryginalne zdjecia produktu. */
  photoIds: ID[]
  /** Zdjecia wygenerowane na modelce AI. */
  generatedPhotoIds: ID[]
  descriptions: SavedDescription[]
  tags: string[]
  notes?: string
  /** Adres URL ogloszenia na Vinted (po wystawieniu). */
  listingUrl?: string
  createdAt: number
  updatedAt: number
  listedAt?: number
  soldAt?: number
}

export type SaleStatus = 'completed' | 'pending' | 'cancelled' | 'returned'

/** Wpis w ewidencji sprzedazy. */
export interface Sale {
  id: ID
  /** Powiazanie z produktem (opcjonalne — mozna ewidencjonowac recznie). */
  productId?: ID
  productName: string
  brand?: string
  accountId?: ID
  /** Cena sprzedazy (to, co zaplacil kupujacy za przedmiot). */
  salePrice: number
  currency: string
  /** Kwota wysylki pobrana od kupujacego (zwykle 0 — placi kupujacy bezposrednio). */
  shippingCharged?: number
  /** Koszt wysylki poniesiony przez sprzedawce (jesli doplaca). */
  shippingCost?: number
  /** Prowizja platnosci / inne oplaty po stronie sprzedawcy. */
  platformFee?: number
  /** Inne koszty (opakowanie, paliwo itp.). */
  otherCosts?: number
  /** Koszt zakupu towaru (przeniesiony z produktu lub wpisany recznie). */
  purchaseCost?: number
  quantity: number
  buyer?: string
  paymentMethod?: string
  status: SaleStatus
  notes?: string
  soldAt: number
  createdAt: number
  /** Klucz treści wiersza ze źródłowego importu CSV — do idempotentnego ponownego importu. */
  importKey?: string
}

/** Globalne ustawienia aplikacji (pojedynczy wiersz w tabeli `settings`). */
export interface AppSettings {
  id: 'app'
  geminiApiKey: string
  textModel: string
  imageModel: string
  currency: string
  defaultAccountId?: ID
  /** Domyslna sygnatura/stopka doklejana do opisow (np. info o wysylce). */
  signature?: string
  /** Czy doklejac stopke do generowanych opisow. */
  appendSignature: boolean
  /** Licznik wygenerowanych obrazow — do szacowania kosztow (brak darmowego tieru!). */
  imagesGenerated: number
  /** Liczba wariantow generowanych na raz w Studio (1–4). */
  imageVariants: number
  /** Wersja schematu — do migracji. */
  schemaVersion: number
}

/** Wynik kalkulacji zysku — uzywany w ewidencji i na dashboardzie. */
export interface ProfitBreakdown {
  revenue: number // salePrice * qty + shippingCharged
  costs: number // purchase + shipping + fee + other
  profit: number
  margin: number // profit / revenue
}
