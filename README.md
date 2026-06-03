# 🧥 Vinted Studio — Asystent Sprzedaży

Aplikacja **PWA** (instalowalna w przeglądarce, działa offline) wspomagająca sprzedaż na Vinted.
Oparta o **Gemini API**. Wszystko działa **lokalnie** — Twoje dane i klucz API nie opuszczają urządzenia.

> Zbudowane w nocy autonomicznie na podstawie briefu + automatycznego `/deep-research`. Poniżej znajdziesz **uzasadnienie kluczowych decyzji** (sekcja „Dlaczego PWA”).

---

## ✨ Co potrafi

Cztery filary z briefu + funkcje dołożone na podstawie researchu:

| Moduł | Opis |
|------|------|
| 📸 **Studio zdjęć AI** | Wirtualna przymierzalnia — ubiera produkt na **wcześniej stworzonej modelce AI** (Gemini „Nano Banana”). Tryb „na modelce” (try-on) oraz „czyść tło” (retusz zdjęcia produktu). Scenerie: studio / ulica / lustro / dom / detal. |
| 🧍 **Modelki AI** | Twórz i zapisuj spójne modelki — z wgranych zdjęć **lub** wygenerowane z opisu. Wielokrotnego użytku przy każdym produkcie. |
| 📦 **Magazyn (stan magazynowy)** | Pełna kartoteka produktów: marka, rozmiar, stan, materiał, wymiary, ceny, ilości, statusy (szkic → w magazynie → wystawione → sprzedane), tagi, zdjęcia. |
| 💸 **Ewidencja sprzedaży** | Osobno **dla każdego konta** oraz jeden widok **wspólny**. Przychód, koszty, zysk, marża, eksport CSV, ręczne wpisy i automatyczne „oznacz jako sprzedane”. |
| ✍️ **Generator opisów** | Kilka stylów (zwięzły, luźny z emoji, szczegółowy, sprzedażowy, minimalistyczny, z historią, z hashtagami) — **z zachowaniem amatorskiego tonu Vinted**. Każdy opis **zapisujesz przy produkcie**, jeden ustawiasz jako aktywny. |
| 🏷️ **Kalkulator ceny** | Sugeruje przedział wg stanu (% ceny detalicznej) + cenę „z miejscem na rabat” i próg minimalnej oferty (do negocjacji). |
| 🔎 **Tytuł SEO** | Buduje uporządkowany tytuł (marka → nazwa → kolor → materiał → rozmiar) zwiększający wyszukiwalność. |
| 💰 **Kontrola kosztów AI** | Licznik wygenerowanych obrazów + szacowany koszt (generowanie obrazów przez API jest **płatne**, brak darmowego limitu). |
| 📊 **Pulpit** | Wartość magazynu, sprzedaż/zysk miesięczny, wykres 6 miesięcy, podział na konta, „do wystawienia”. |
| 🔐 **Kopia zapasowa** | Eksport/import całej bazy do JSON (bez klucza API). |

---

## 🤔 Dlaczego PWA, a nie rozbudowa wtyczki `wtfGUZ/vinted-asystent-sprzedazy`?

Brief dawał wybór: zintegrować z istniejącą wtyczką **albo** zrobić PWA. Wybrałem **PWA** — świadomie:

1. **Inna natura zadań.** Tamta wtyczka to świetne narzędzie do **działań na żywo na vinted.com**: smart relist martwych ogłoszeń, oferty do lajkujących, anti-ban, multikonto, SEO-rewriter. Działa *w* przeglądarce, na sesji Vinted. To, czego potrzebujesz tutaj (studio zdjęć, baza magazynowa, księgowość sprzedaży, redakcja opisów), to **zaplecze / back-office**, które robi się *obok* platformy.
2. **Wymagania techniczne.** Generowanie i przechowywanie wielu zdjęć (IndexedDB/Blob), bogaty interfejs SPA, wykresy — to źle leży w architekturze MV3 (efemeryczny service worker, limity storage). Tamta wtyczka ma celowo **zero zależności NPM** i 280 testów; dokładanie Reacta, pipeline'u obrazów i AI psułoby jej spójność.
3. **To cudze repo.** Nie mam do niego prawa zapisu, a wcinanie ciężkich funkcji w czyjąś, minimalistyczną bazę byłoby złym pomysłem.
4. **Zgodność z regulaminem.** Research potwierdził: **Vinted nie ma publicznego API dla zwykłych kont, a regulamin zabrania scrapingu/automatyzacji.** Dlatego Vinted Studio **nigdy nie łączy się z Vinted** i niczego nie scrapuje — przygotowujesz treści offline, a publikujesz/„bumpujesz” ręcznie lub właśnie tamtą wtyczką. To czyste, bezpieczne rozdzielenie ról.

> **Wniosek:** Vinted Studio i tamta wtyczka są **komplementarne**. Studio = przygotowanie (zdjęcia, opisy, ceny, magazyn, księgowość). Wtyczka = działania na żywo (relist, oferty, bump). Opisy/ceny z Studio kopiujesz do Vinted jednym kliknięciem.

---

## 🚀 Uruchomienie

Wymagania: **Node 18+** (testowane na Node 24).

```bash
npm install
npm run dev      # tryb developerski (http://localhost:5173)
npm run build    # produkcja → katalog dist/
npm run preview  # podgląd builda produkcyjnego
```

### Instalacja jako aplikacja (PWA)
Otwórz zbudowaną aplikację w Chrome/Edge → ikona „Zainstaluj” w pasku adresu. Działa offline (poza wywołaniami AI, które wymagają internetu).

### Hosting
`dist/` to statyczne pliki — wrzuć na dowolny hosting (Netlify, Vercel, GitHub Pages, własny serwer). `base` jest ustawione na `./`, więc działa też z podkatalogu.

---

## 🔑 Klucz API Gemini

1. Wejdź na **[Google AI Studio → API keys](https://aistudio.google.com/apikey)** i wygeneruj klucz (darmowy).
2. W aplikacji: **Ustawienia → wklej klucz → Testuj**.
3. Klucz jest zapisywany **tylko lokalnie** (IndexedDB) i wysyłany wyłącznie do Google.

### Modele (konfigurowalne w Ustawieniach)
- **Tekst (opisy):** domyślnie `gemini-2.5-flash` (hojny darmowy limit).
- **Obrazy (zdjęcia):** domyślnie `gemini-2.5-flash-image` („Nano Banana”).

> ⚠️ **Koszty obrazów.** Generowanie obrazów przez API jest **płatne od pierwszego użycia** (brak darmowego limitu), ok. **$0,039 / obraz** (1024px). Aplikacja liczy zużycie i szacuje koszt w Ustawieniach.
>
> ⏳ **Uwaga na wersje.** `gemini-2.5-flash-image` ma być wygaszony **02.10.2026**. Nowsze warianty to `gemini-3.1-flash-image` („Nano Banana 2”) i `gemini-3-pro-image` („Nano Banana Pro”) — możesz je wybrać/wpisać w Ustawieniach. Jeśli model zwróci błąd 404, po prostu zmień ID modelu.

---

## 🧠 Wskazówki sprzedażowe (z researchu)

- **Ceny wg stanu:** dobry ~60–70% ceny detalicznej, bardzo dobry ~70–85%, nowy z metką ~85–95%. Wystawiaj z lekkim zapasem na rabat, miej w głowie próg minimalnej oferty (kalkulator robi to za Ciebie).
- **Czas:** najwięcej kupujących wieczorem — **18:00–22:00**.
- **Tytuł:** marka + model + kolor + materiał + rozmiar (generator tytułu SEO).
- **Opis:** podaj wymiary i uczciwie wady — buduje zaufanie.
- To **konwencje rynkowe**, nie potwierdzony algorytm Vinted (każda twarda teza o rankingu Vinted upadła w weryfikacji). Traktuj jako dobre praktyki, nie pewniki.

---

## 🗂️ Architektura (skrót)

```
src/
  db/        Dexie (IndexedDB): products, models, accounts, sales, images, settings
  lib/       gemini (REST), prompts (style opisów + try-on), pricing, images, format, csv
  state/     zustand: settings, toasts
  components/ Layout, UI kit, ImageView, FileDrop, Toasts
  pages/     Dashboard, Inventory, ProductEditor, PhotoStudio, Models, Sales, Accounts, Settings
public/      manifest.webmanifest, sw.js, ikony
```

- **Stack:** Vite + React + TypeScript + Tailwind. Bez backendu — 100% client-side.
- **Obrazy:** przechowywane jako Blob w IndexedDB, miniatury jako data URL (szybkie listy).
- **PWA:** ręczny service worker (cache powłoki) — bez dodatkowych wtyczek.

---

## 🔒 Prywatność

Brak serwera, brak konta, brak telemetrii. Wszystko (produkty, zdjęcia, sprzedaże, klucz API) zostaje w Twojej przeglądarce. Rób kopie zapasowe (**Ustawienia → Eksportuj**), bo wyczyszczenie danych przeglądarki je usunie.

---

## 🛣️ Pomysły na przyszłość

- Eksport gotowego „pakietu ogłoszenia” (zdjęcia + tytuł + opis + cena) jednym kliknięciem.
- Most do wtyczki `vinted-asystent-sprzedazy` (przekazywanie opisów/cen).
- Crosslisting do innych platform (Depop/eBay) — treści są już uniwersalne.
- Planer wystawiania z przypomnieniami na godziny szczytu.

---

*Made autonomously with Claude Code. Zobacz `RESEARCH.md` po pełne, zweryfikowane źródła.*
