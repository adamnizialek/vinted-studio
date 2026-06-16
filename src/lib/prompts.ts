import type { AiModel, AppSettings, Product } from '@/db/types'
import { CONDITION_LABELS } from './constants'

// ─────────────────────────────────────────────────────────────────────────
//  OPISY PRODUKTOW
// ─────────────────────────────────────────────────────────────────────────

export interface DescriptionStyle {
  id: string
  label: string
  emoji: string
  hint: string
  instruction: string
}

/**
 * System prompt wspolny dla wszystkich stylow — pilnuje "amatorskiego",
 * naturalnego tonu typowego sprzedawcy na Vinted (nie marketingowego, nie AI).
 */
export const DESCRIPTION_SYSTEM = [
  'Jesteś zwykłą osobą, która prywatnie sprzedaje swoje ubrania i rzeczy na Vinted w Polsce.',
  'Piszesz opisy tak, jak pisze prawdziwy, przeciętny użytkownik Vinted — naturalnie, swobodnie, po polsku.',
  'Reguły:',
  '- Pisz w pierwszej osobie ("sprzedaję", "mam", "oddam").',
  '- Brzmienie ma być amatorskie i ludzkie, NIE jak reklama, sklep czy sztuczna inteligencja. Żadnego korpo-marketingu, żadnych pustych superlatyw.',
  '- NIE wymyślaj faktów, których nie podano (marki, materiału, wymiarów). Jeśli czegoś nie ma — po prostu o tym nie pisz.',
  '- Bądź uczciwy/a co do stanu. Jeśli są wady — wspomnij naturalnie.',
  '- Nie używaj nagłówków Markdown, nie otaczaj całości cudzysłowem. Zwróć wyłącznie gotowy tekst opisu do wklejenia.',
  '- Polskie znaki diakrytyczne obowiązkowo.',
].join('\n')

export const DESCRIPTION_STYLES: DescriptionStyle[] = [
  {
    id: 'zwiezly',
    label: 'Zwięzły',
    emoji: '✂️',
    hint: 'Krótko i na temat, 2–4 zdania.',
    instruction:
      'Napisz krótki, konkretny opis (2–4 zdania). Najważniejsze: co to, stan, rozmiar. Bez lania wody.',
  },
  {
    id: 'szczegolowy',
    label: 'Szczegółowy',
    emoji: '📋',
    hint: 'Pełne info: stan, wymiary, materiał.',
    instruction:
      'Napisz dokładny opis. Uwzględnij stan, rozmiar, materiał i wymiary (jeśli podane), kolor oraz krótko dlaczego sprzedajesz. Ułóż naturalnie, ewentualnie z myślnikami przy wymiarach.',
  },
  {
    id: 'casual',
    label: 'Luźny z emoji',
    emoji: '😍',
    hint: 'Swobodny ton, trochę emoji.',
    instruction:
      'Napisz luźny, sympatyczny opis w swobodnym tonie, z kilkoma (2–5) pasującymi emoji. Ma brzmieć jak młoda osoba sprzedająca ciuch znajomym. Nie przesadzaj z emoji.',
  },
  {
    id: 'sprzedazowy',
    label: 'Sprzedażowy',
    emoji: '🔥',
    hint: 'Lekko perswazyjny, podkreśla okazję.',
    instruction:
      'Napisz opis, który delikatnie zachęca do zakupu — podkreśl atut (okazja, stan, uniwersalność), ale bez nachalności i bez brzmienia jak reklama. Maks. 1 lekkie wezwanie do działania na końcu.',
  },
  {
    id: 'minimalistyczny',
    label: 'Minimalistyczny',
    emoji: '▪️',
    hint: 'Hasłowo, myślnikami.',
    instruction:
      'Napisz opis hasłowo, w punktach z myślnikami (—). Każda linia to jeden konkret: nazwa/marka, rozmiar, stan, kolor, materiał, wymiary. Bardzo zwięźle.',
  },
  {
    id: 'storytelling',
    label: 'Z historią',
    emoji: '💭',
    hint: 'Krótka osobista historyjka.',
    instruction:
      'Napisz opis z krótką, wiarygodną osobistą nutą (np. dlaczego sprzedajesz, jak rzecz służyła). 3–5 zdań, ciepło i autentycznie, ale bez zmyślania konkretów.',
  },
  {
    id: 'hashtagi',
    label: 'Z hashtagami',
    emoji: '#️⃣',
    hint: 'Opis + hashtagi dla widoczności.',
    instruction:
      'Napisz krótki opis (2–3 zdania), a na końcu w nowej linii dodaj 5–10 trafnych hashtagów po polsku/angielsku zwiększających widoczność (marka, kategoria, styl, rozmiar). Hashtagi oddzielone spacją.',
  },
]

export function styleById(id: string): DescriptionStyle | undefined {
  return DESCRIPTION_STYLES.find((s) => s.id === id)
}

/** Buduje blok faktow o produkcie wstrzykiwany do promptu. */
export function buildProductFacts(p: Product): string {
  const lines: string[] = []
  const add = (label: string, val?: string | number) => {
    if (val !== undefined && val !== null && String(val).trim() !== '')
      lines.push(`- ${label}: ${val}`)
  }
  add('Nazwa / co to', p.name)
  add('Marka', p.brand)
  add('Kategoria', p.category)
  add('Rozmiar', p.sizeLabel)
  add('Kolor', p.color)
  add('Materiał', p.material)
  add('Stan', CONDITION_LABELS[p.condition])
  if (p.measurements) {
    const m = p.measurements
    const parts: string[] = []
    if (m.chest) parts.push(`szerokość/klatka ${m.chest} cm`)
    if (m.length) parts.push(`długość ${m.length} cm`)
    if (m.sleeve) parts.push(`rękaw ${m.sleeve} cm`)
    if (m.waist) parts.push(`pas ${m.waist} cm`)
    if (m.hips) parts.push(`biodra ${m.hips} cm`)
    if (m.inseam) parts.push(`nogawka wewn. ${m.inseam} cm`)
    if (m.shoulders) parts.push(`ramiona ${m.shoulders} cm`)
    if (m.footLength) parts.push(`wkładka ${m.footLength} cm`)
    if (m.custom) parts.push(m.custom)
    if (parts.length) add('Wymiary', parts.join(', '))
  }
  if (p.listingPrice) add('Cena', `${p.listingPrice} ${p.currency}`)
  if (p.tags.length) add('Słowa kluczowe', p.tags.join(', '))
  if (p.notes) add('Dodatkowe uwagi (w tym wady)', p.notes)
  return lines.join('\n')
}

export function buildDescriptionPrompt(
  product: Product,
  style: DescriptionStyle,
  settings: AppSettings,
): string {
  const facts = buildProductFacts(product)
  const sig =
    settings.appendSignature && settings.signature?.trim()
      ? `\n\nNa samym końcu opisu dodaj w osobnej linii tę stopkę dosłownie: "${settings.signature.trim()}"`
      : ''
  return [
    `Styl opisu: ${style.label}. ${style.instruction}`,
    '',
    'Dane przedmiotu (używaj TYLKO tych, które podano):',
    facts || '- (brak szczegółów — opisz ogólnie na podstawie nazwy)',
    sig,
    '',
    'Zwróć wyłącznie gotowy opis do wklejenia na Vinted.',
  ].join('\n')
}

// ─────────────────────────────────────────────────────────────────────────
//  STUDIO ZDJEC (wirtualna przymierzalnia / czyszczenie tla)
// ─────────────────────────────────────────────────────────────────────────

export type PhotoMode = 'tryOn' | 'enhance'

export interface ScenePreset {
  id: string
  label: string
  emoji: string
  prompt: string
}

export const SCENE_PRESETS: ScenePreset[] = [
  {
    id: 'studio',
    label: 'Studio',
    emoji: '📸',
    prompt:
      'Clean professional studio shot on a seamless light neutral background (soft beige/grey), soft even softbox lighting, full-body framing, model standing in a relaxed natural pose.',
  },
  {
    id: 'street',
    label: 'Uliczny / lifestyle',
    emoji: '🏙️',
    prompt:
      'Lifestyle street-style photo outdoors on a city street with soft natural daylight, blurred urban background, full-body candid pose, looks like an authentic outfit photo.',
  },
  {
    id: 'mirror',
    label: 'Lustro (selfie)',
    emoji: '🤳',
    prompt:
      'Casual full-length mirror selfie in a tidy bedroom, phone partially visible, natural indoor lighting — authentic Vinted seller vibe, slightly imperfect framing.',
  },
  {
    id: 'home',
    label: 'Wnętrze / dom',
    emoji: '🛋️',
    prompt:
      'Cozy bright home interior background, warm natural window light, three-quarter body framing, relaxed natural pose.',
  },
  {
    id: 'closeup',
    label: 'Zbliżenie (detal)',
    emoji: '🔍',
    prompt:
      'Upper-body close-up emphasising the garment fabric, texture and details, soft natural light, neutral background, shallow depth of field.',
  },
]

export function sceneById(id: string): ScenePreset | undefined {
  return SCENE_PRESETS.find((s) => s.id === id)
}

interface PhotoPromptInput {
  mode: PhotoMode
  product?: Product
  model?: AiModel
  sceneId: string
  aspectHint?: string // np. "vertical 3:4 portrait"
  customNotes?: string
}

/**
 * Buduje prompt obrazowy. Tryb 'tryOn' ubiera modelke (z referencji) w produkt;
 * tryb 'enhance' czysci/poprawia samo zdjecie produktu.
 */
export function buildPhotoPrompt(input: PhotoPromptInput): string {
  const scene = sceneById(input.sceneId)?.prompt ?? ''
  const aspect = input.aspectHint ?? 'vertical 3:4 portrait orientation'
  const garment = input.product
    ? describeGarment(input.product)
    : 'the clothing item shown in the product photo'

  if (input.mode === 'enhance') {
    return [
      `Retouch and clean up this product photo of ${garment}.`,
      'Place it on a clean, seamless neutral studio background, remove clutter and distractions, fix lighting and white balance, keep the garment colour, pattern and details 100% faithful to the original.',
      `Output as a sharp, well-lit e-commerce style product photo, ${aspect}. No text, no watermark, no added logos.`,
      input.customNotes?.trim() ? `Additional: ${input.customNotes.trim()}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  // tryOn
  const identity = input.model?.appearance?.trim()
    ? ` The model looks like: ${input.model.appearance.trim()}.`
    : ''
  const modelNotes = input.model?.promptNotes?.trim()
    ? ` ${input.model.promptNotes.trim()}`
    : ''

  return [
    'Photorealistic virtual try-on.',
    'Using the provided reference image(s) of the model as the FIRST input and the clothing item as the following input(s):',
    `generate a realistic photo of THE SAME person — keep their face, identity, hair, skin tone and body proportions perfectly consistent with the reference — now wearing ${garment}.`,
    identity + modelNotes,
    'CRITICAL: preserve the garment exactly as in the product photo — same colour, print, pattern, texture, cut, length and all details. Fit it naturally on the body with realistic folds and draping.',
    scene,
    `Framing/orientation: ${aspect}. Photorealistic, sharp focus on the clothing, natural realistic lighting and skin, correct anatomy and hands.`,
    'It must look like a genuine second-hand clothing listing photo. No text, no watermark, no brand logos overlaid.',
    input.customNotes?.trim() ? `Additional instructions: ${input.customNotes.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function describeGarment(p: Product): string {
  const bits = [p.color, p.brand, p.name].filter(Boolean).join(' ')
  return bits ? `this ${bits}` : 'this clothing item'
}

// ─────────────────────────────────────────────────────────────────────────
//  GENEROWANIE MODELKI AI (od zera, tekst -> obraz)
// ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
//  TYTUL SEO (struktura: marka + nazwa + kolor + materiał + rozmiar)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Buduje uporzadkowany tytul ogloszenia lokalnie (bez API) wg konwencji
 * zwiekszajacej wyszukiwalnosc: marka → nazwa → kolor → materiał → rozmiar.
 * Przycina do ~70 znakow (limit tytulu Vinted).
 */
export function buildSeoTitle(p: Product): string {
  const brand = (p.brand ?? '').trim()
  const name = (p.name ?? '').trim()
  // Nie powtarzaj marki, jesli juz wystepuje jako OSOBNE slowo w nazwie
  // (np. marka "Zara" + nazwa "Zara sukienka" => "Zara sukienka", nie "Zara Zara …").
  const skipBrand = brand !== '' && containsWord(name, brand)
  const rawParts = [
    skipBrand ? '' : brand,
    name,
    (p.color ?? '').trim(),
    (p.material ?? '').trim(),
    p.sizeLabel ? `rozm. ${p.sizeLabel.trim()}` : '',
  ]
  // Pomijaj czesci, ktore (jako fraza, po granicy slow) sa juz w tytule.
  const parts: string[] = []
  for (const part of rawParts) {
    if (!part) continue
    if (containsWord(parts.join(' '), part)) continue
    parts.push(part)
  }
  return truncateAtWord(parts.join(' '), 70)
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/\s+/).filter(Boolean)
}

/** Czy `needle` wystepuje w `haystack` jako ciagla sekwencja CALYCH slow
 *  (granica slowa, bezpieczne dla polskich znakow — bez regexowego \b). */
function containsWord(haystack: string, needle: string): boolean {
  const h = tokenize(haystack)
  const n = tokenize(needle)
  if (n.length === 0) return false
  for (let i = 0; i + n.length <= h.length; i++) {
    if (n.every((w, j) => w === h[i + j])) return true
  }
  return false
}

/** Przycina do `max` znakow, cofajac sie do granicy slowa zamiast ciac w srodku. */
function truncateAtWord(s: string, max: number): string {
  if (s.length <= max) return s
  const budget = max - 1 // miejsce na wielokropek (1 znak: "…")
  let cut = s.slice(0, budget)
  const midWord = s.charAt(budget - 1) !== ' ' && s.charAt(budget) !== ' '
  if (midWord) {
    const lastSpace = cut.lastIndexOf(' ')
    if (lastSpace > 0) cut = cut.slice(0, lastSpace)
  }
  return cut.trimEnd() + '…'
}

export function buildModelGenerationPrompt(appearance: string, notes?: string): string {
  return [
    'Generate a photorealistic full-body portrait of a fashion model standing against a clean neutral studio background, soft even lighting, wearing plain simple neutral basics (plain t-shirt and jeans).',
    `Appearance: ${appearance.trim() || 'a friendly approachable person, natural look'}.`,
    notes?.trim() ? `Notes: ${notes.trim()}.` : '',
    'Natural realistic proportions and skin, correct anatomy and hands, neutral friendly expression, looking at camera. This image will be reused as a consistent reference model for clothing try-on, so make the face and body clearly visible. No text, no watermark.',
  ]
    .filter(Boolean)
    .join('\n')
}
