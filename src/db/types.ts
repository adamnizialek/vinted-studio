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

/**
 * Rozdzielczosc wyjsciowa generowanego obrazu. Obslugiwana natywnie tylko przez
 * rodzine Gemini 3 image (imageConfig.imageSize); litery "K" muszą być wielkie.
 * 1K ≈ 1024px (~1MP), 2K ≈ 2048px (~4MP), 4K ≈ 4096px (~16MP).
 */
export type ImageResolution = '1K' | '2K' | '4K'

export interface ImageRecord {
  id: ID
  /**
   * Pelny obraz. Opcjonalny: rekord moze istniec lokalnie bez bloba, gdy metadane
   * przyszly z synchronizacji z innego urzadzenia — blob doczytujemy leniwie z R2.
   */
  blob?: Blob
  mime: string
  width: number
  height: number
  /** Mala miniatura (data URL) do szybkiego renderu list bez ladowania pelnego bloba. */
  thumb: string
  kind: ImageKind
  /** Powiazanie pomocnicze (opcjonalne) dla porzadkow/kaskad. */
  productId?: ID
  modelId?: ID
  /** Backref dla porzadkow/kaskad, gdy obraz nalezy do modelu (wspoldzielony). */
  designId?: ID
  /** Metadane generacji (gdy kind === 'generated'). */
  meta?: GeneratedImageMeta
  createdAt: number
  /** Czas ostatniej zmiany (ms) — klucz porownania last-write-wins przy synchronizacji. */
  updatedAt: number
}

export interface GeneratedImageMeta {
  modelId?: ID
  prompt: string
  imageModel: string
  /** id zdjec wejsciowych (produkt + ew. dodatkowe). */
  sourceImageIds: ID[]
  /** id zdjecia-zrodla edycji (gdy ten obraz powstal przez "Edytuj z AI"). */
  editedFromId?: ID
  /** Instrukcja edycji wpisana przez uzytkownika (prowenancja/audyt). */
  editInstruction?: string
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
  updatedAt: number
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

/** Wygenerowana, jeszcze niezapisana propozycja opisu (jedna na styl). */
export interface DescriptionCandidate {
  styleId: string
  styleLabel: string
  text: string
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
  /** Cena detaliczna (nowa, sklepowa) — baza kalkulatora wyceny; trwala, by przetrwac
   *  nawigacje i zasilic w przyszlosci podpowiedzi cenowe / SEO / opisy. */
  retailPrice?: number
  /** Cena wystawienia / oczekiwana. */
  listingPrice?: number
  currency: string
  quantity: number
  status: ProductStatus
  /** Konto, do ktorego przypisany jest przedmiot (opcjonalne). */
  accountId?: ID
  /** Gdy ustawione: produkt jest rozmiarem nalezacym do modelu; pola wspolne
   *  (nazwa, marka, zdjecia, opisy) czyta z Design, a wlasne sa wyczyszczone. */
  designId?: ID
  /** Oryginalne zdjecia produktu. */
  photoIds: ID[]
  /** Zdjecia wygenerowane na modelce AI. */
  generatedPhotoIds: ID[]
  descriptions: SavedDescription[]
  /** Niezapisane propozycje opisow (per styl) — trwale, by nie ginely przy zmianie
   *  zakladki / nawigacji. Zapisanie przenosi je do `descriptions`. */
  descriptionCandidates?: DescriptionCandidate[]
  tags: string[]
  notes?: string
  /** Zdjecie-okladka (id z photoIds/generatedPhotoIds). Brak => pierwsze zdjecie. */
  coverImageId?: ID
  /** Adres URL ogloszenia na Vinted (po wystawieniu). */
  listingUrl?: string
  createdAt: number
  updatedAt: number
  /** Znacznik wystawienia (ms). Pisany przy przejsciu w 'listed'; dla starych
   *  ofert backfillowany z updatedAt (przyblizony). Zrodlo metryk cyklu zycia. */
  listedAt?: number
  /** True gdy listedAt pochodzi z backfillu (przyblizony) — UI to sygnalizuje. */
  listedAtApprox?: boolean
  soldAt?: number
  /** Klucz treści wiersza ze źródłowego importu CSV — do idempotentnego ponownego importu. */
  importKey?: string
}

/** Wspolny fason ("Model" w UI) — wspoldzielony przez warianty rozmiarowe.
 *  Trzyma to, co identyczne miedzy rozmiarami: tozsamosc, zdjecia, opisy. */
export interface Design {
  id: ID
  name: string
  brand?: string
  color?: string
  material?: string
  category?: string
  tags: string[]
  /** Oryginalne zdjecia produktu — wspoldzielone przez wszystkie rozmiary. */
  photoIds: ID[]
  /** Zdjecia na modelce AI — wspoldzielone. */
  generatedPhotoIds: ID[]
  /** Zapisane opisy (jeden active) — wspoldzielone. */
  descriptions: SavedDescription[]
  createdAt: number
  updatedAt: number
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
  updatedAt: number
  /** Klucz treści wiersza ze źródłowego importu CSV — do idempotentnego ponownego importu. */
  importKey?: string
}

export type ExpenseKind = 'boost' | 'exposure' | 'other' // podbicie / ekspozycja / inne

/** Skąd pochodzi wpis kosztu: ręczny / import arkusza / odczyt ze zrzutu ekranu. */
export type ExpenseSource = 'manual' | 'import' | 'screenshot'

/** Koszt promocji (podbicie/ekspozycja) lub inny koszt nie-towarowy. */
export interface Expense {
  id: ID
  /** Konto, którego dotyczy koszt (z importu = wybrane konto; ręczny = opcjonalny). */
  accountId?: ID
  kind: ExpenseKind
  /** Oryginalna nazwa z arkusza ("Podbicia", "Ekspozycja", "Podbicia main"). */
  description: string
  /** Kwota kosztu (zł). */
  amount: number
  currency: string
  /** Data poniesienia (ms, lokalne południe — spójnie ze sprzedażą). */
  incurredAt: number
  notes?: string
  createdAt: number
  updatedAt: number
  /** Klucz treści wiersza — do idempotentnego re-importu. */
  importKey?: string
  /** Czas trwania promocji w dniach (Vinted: 3 lub 7). Tylko podbicie/ekspozycja. */
  durationDays?: number
  /** Pochodzenie wpisu — odróżnia odczyt AI od ręcznego (pola opcjonalne, bez migracji). */
  source?: ExpenseSource
  /** ID obrazu (tabela images, kind:'reference') ze zrzutem ekranu — dowód/audyt. */
  screenshotImageId?: ID
  /** Pewność odczytu AI 0–1 (gdy source==='screenshot') — tylko do audytu, nie do logiki. */
  ocrConfidence?: number
}

/** Globalne ustawienia aplikacji (pojedynczy wiersz w tabeli `settings`). */
export interface AppSettings {
  id: 'app'
  geminiApiKey: string
  textModel: string
  imageModel: string
  /** Rozdzielczosc generowanych zdjec (dotyczy modeli Gemini 3 image). */
  imageResolution: ImageResolution
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
  /** Czas ostatniej zmiany (ms) — klucz porownania last-write-wins przy synchronizacji. */
  updatedAt: number
}

/** Wynik kalkulacji zysku — uzywany w ewidencji i na dashboardzie. */
export interface ProfitBreakdown {
  revenue: number // salePrice * qty + shippingCharged
  costs: number // purchase + shipping + fee + other (+ magazyn w agregacie)
  profit: number
  margin: number // profit / revenue
  /** Koszt niesprzedanego magazynu zawarty w `costs` (tylko w agregacie). */
  inventoryCost?: number
}
