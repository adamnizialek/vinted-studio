# Deep Research — co powinno znaleźć się w narzędziu do sprzedaży na Vinted

Wynik automatycznego `/deep-research` (21 źródeł → 99 tez → weryfikacja 25 → 19 potwierdzonych).
Tezy weryfikowane były adwersaryjnie (głosowanie 3 agentów). Poniżej tylko **potwierdzone**.

## Gemini API (wysokie zaufanie — źródła pierwotne Google)

- **Model do try-on:** `gemini-2.5-flash-image` (marka „Nano Banana”), GA/produkcyjny. Nowsze: `gemini-3.1-flash-image` („Nano Banana 2”, domyślny od 26.02.2026), `gemini-3-pro-image` („Nano Banana Pro”). ⚠️ `2.5-flash-image` wygasa **02.10.2026** — zweryfikuj aktualne ID (bywa sufiks `-preview`).
- **Mechanizm try-on:** prompt-based editing (dodaj/usuń/zmień element) + fuzja wielu obrazów + spójność postaci → dokładnie to, co potrzebne do ubierania produktu na spójnej modelce. Spójność postaci jest dobra, ale **niedoskonała**.
- **Koszt:** ~**$0,039 / obraz** (1024px = 1290 tokenów × $30/1M). Batch ~2× taniej. Wejście $0,30/1M.
- **Brak darmowego tieru dla obrazów w API** — płatne od pierwszego żądania (darmowy limit dotyczy tylko testów w AI Studio). → potrzebna kontrola kosztów (licznik, limity, batch).

## Funkcje dodatkowe (potwierdzone)

- **Inteligencja cenowa:** % ceny detalicznej wg stanu (dobry 60–70%, b.dobry 70–85%, nowy z metką 85–95%) + cena-kotwica `target × 1.1–1.15` i próg odrzucenia ofert `target − 10%`.
- **SEO + czas:** tytuł = marka + model + materiał + kolor + rozmiar; publikacja w szczycie **18:00–22:00**; w opisie wymiary + wady.
- **Zaangażowanie (robi to wiodące narzędzie Dotb):** repost/bump na górę wyników + powiadomienie obserwujących; auto-wiadomości do lajkujących; AI tytuł/opis/kategoria; natywne **multikonto**.
  → bump/oferty/relist to domena działań na żywo (wtyczka), nie back-office.

## Ograniczenie (kluczowe, źródło: Vinted)

- **Vinted nie ma publicznego API dla zwykłych kont.** Oficjalne Pro Integrations API jest za allowlistą; regulamin zabrania scrapingu/automatyzacji. → Synchronizacja/automatyzacja musi być user-driven (model wtyczki) albo offline. **Vinted Studio celowo nie dotyka Vinted.**

## Obalone tezy (NIE budować na nich funkcji)

Ranking oparty na świeżości z 7-dniowym zanikiem (0-3), „optymalna cena = mediana–60. percentyl” (0-3), analiza liczby/jasności zdjęć przez algorytm (0-3), „przecena spycha ofertę w dół” (0-3). Brak wiarygodnego, potwierdzonego opisu algorytmu rankingowego Vinted w 2026.

## Źródła (wybór)

- https://ai.google.dev/gemini-api/docs/image-generation
- https://ai.google.dev/gemini-api/docs/pricing
- https://developers.googleblog.com/en/gemini-2-5-flash-image-now-ready-for-production-with-new-aspect-ratios/
- https://pro-docs.svc.vinted.com/  (brak API dla zwykłych kont)
- https://dotb.io/features  (zakres funkcji konkurencji)
- https://vintylook.com/en/articles/set-the-right-price-on-vinted-stop-undervaluing  (ceny/czas — blog, konwencja)
