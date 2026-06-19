import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Loader2, Plus, Sparkles, Star, Trash2, Shirt, X } from 'lucide-react'
import clsx from 'clsx'
import { db, deleteEntity, deleteModelCascade, putEntity } from '@/db/db'
import type { AiModel } from '@/db/types'
import { uid } from '@/lib/id'
import { addImageFromFile, base64ToBlob } from '@/lib/images'
import { generateImage } from '@/lib/gemini'
import { DEFAULT_IMAGE_RESOLUTION } from '@/lib/constants'
import { buildModelGenerationPrompt } from '@/lib/prompts'
import { useSettings } from '@/state/settings'
import { toast } from '@/state/toast'
import { Button, EmptyState, Field, Modal, SectionTitle, TextArea, TextInput } from '@/components/ui'
import { Thumb } from '@/components/ImageView'

export function Models() {
  const models = useLiveQuery(() => db.models.orderBy('createdAt').reverse().toArray(), [])
  const [editing, setEditing] = useState<AiModel | null>(null)
  const [open, setOpen] = useState(false)
  // Dwie NIEZALEŻNE operacje async (wgrywanie plików vs generowanie z API) muszą
  // mieć osobne flagi — wspólny boolean pozwalał szybkiemu uploadowi zgasić flagę
  // trwającej generacji (znikał „Anuluj", odblokowywał się przycisk → podwójne
  // zlecenie i osierocony AbortController). `busy` blokuje uruchomienie jednej,
  // gdy druga trwa, więc nie mogą się przeplatać.
  const [uploading, setUploading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [controller, setController] = useState<AbortController | null>(null)
  const busy = uploading || generating
  const { settings, bumpImageCount } = useSettings()

  const startNew = async () => {
    const m: AiModel = {
      id: uid(),
      name: 'Nowa modelka',
      appearance: '',
      referenceImageIds: [],
      promptNotes: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await putEntity('models', m)
    setEditing(m)
    setOpen(true)
  }

  // Edycja na zywo — zmiany zapisuja sie od razu.
  const patch = async (p: Partial<AiModel>) => {
    if (!editing) return
    const next = { ...editing, ...p, updatedAt: Date.now() }
    setEditing(next)
    await putEntity('models', next)
  }

  const addImages = async (files: File[]) => {
    if (!editing || busy) return
    setUploading(true)
    try {
      const ids: string[] = []
      for (const f of files) {
        const rec = await addImageFromFile(f, 'reference', { modelId: editing.id })
        ids.push(rec.id)
      }
      const refs = [...editing.referenceImageIds, ...ids]
      await patch({ referenceImageIds: refs, coverImageId: editing.coverImageId ?? ids[0] })
    } finally {
      setUploading(false)
    }
  }

  const generate = async () => {
    if (!editing || busy) return
    if (!settings?.geminiApiKey) return toast.error('Dodaj klucz API w Ustawieniach.')
    if (!editing.appearance?.trim())
      return toast.error('Opisz wygląd modelki (np. „kobieta, 25 lat, blond włosy…”).')
    const ac = new AbortController()
    setController(ac)
    setGenerating(true)
    try {
      const prompt = buildModelGenerationPrompt(editing.appearance, editing.promptNotes)
      const { images } = await generateImage(prompt, [], {
        apiKey: settings.geminiApiKey,
        model: settings.imageModel,
        resolution: settings.imageResolution ?? DEFAULT_IMAGE_RESOLUTION,
        aspectRatio: '3:4', // pelnopostaciowy portret referencyjny
        signal: ac.signal,
      })
      await bumpImageCount(images.length)
      const ids: string[] = []
      for (const img of images) {
        const blob = base64ToBlob(img.base64, img.mime)
        const rec = await addImageFromFile(blob, 'model', { modelId: editing.id })
        ids.push(rec.id)
      }
      const refs = [...editing.referenceImageIds, ...ids]
      await patch({ referenceImageIds: refs, coverImageId: editing.coverImageId ?? ids[0] })
      toast.success('Wygenerowano modelkę ✨')
    } catch (e) {
      // Anulowanie przez użytkownika to nie błąd — neutralny komunikat.
      if (ac.signal.aborted) toast.info('Anulowano generowanie.')
      else toast.error(e instanceof Error ? e.message : 'Błąd generowania.')
    } finally {
      setGenerating(false)
      setController(null)
    }
  }

  const removeImage = async (id: string) => {
    if (!editing) return
    await deleteEntity('images', id)
    const refs = editing.referenceImageIds.filter((x) => x !== id)
    await patch({
      referenceImageIds: refs,
      coverImageId: editing.coverImageId === id ? refs[0] : editing.coverImageId,
    })
  }

  const deleteModel = async () => {
    if (!editing) return
    if (!window.confirm('Usunąć tę modelkę i jej zdjęcia referencyjne?')) return
    await deleteModelCascade(editing.id)
    setOpen(false)
    toast.success('Usunięto modelkę.')
  }

  return (
    <div>
      <SectionTitle
        title="Modelki AI"
        subtitle="Stwórz spójną postać (z wgranych zdjęć lub wygenerowaną), na której ubierzesz produkty w Studio."
        right={
          <Button onClick={startNew}>
            <Plus size={16} /> Nowa modelka
          </Button>
        }
      />

      {models && models.length === 0 && (
        <EmptyState
          icon={<Shirt size={40} />}
          title="Brak modelek"
          description="Dodaj zdjęcia referencyjne istniejącej modelki albo wygeneruj nową z opisu. Posłuży do przymierzania ubrań."
          action={
            <Button onClick={startNew}>
              <Plus size={16} /> Stwórz modelkę
            </Button>
          }
        />
      )}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {models?.map((m) => (
          <button
            key={m.id}
            onClick={() => {
              setEditing(m)
              setOpen(true)
            }}
            className="card overflow-hidden text-left transition hover:shadow-pop"
          >
            <div className="aspect-[3/4] w-full bg-ink-100">
              <Thumb imageId={m.coverImageId ?? m.referenceImageIds[0]} className="h-full w-full object-cover" alt={m.name} />
            </div>
            <div className="p-3">
              <p className="truncate font-semibold text-ink-900">{m.name}</p>
              <p className="text-xs text-ink-400">{m.referenceImageIds.length} zdjęć referencyjnych</p>
            </div>
          </button>
        ))}
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        size="lg"
        title="Modelka AI"
        footer={
          <div className="flex justify-between">
            <Button variant="danger" onClick={deleteModel}>
              <Trash2 size={16} /> Usuń
            </Button>
            <Button onClick={() => setOpen(false)}>Gotowe</Button>
          </div>
        }
      >
        {editing && (
          <div className="space-y-4">
            <Field label="Nazwa">
              <TextInput value={editing.name} onChange={(e) => patch({ name: e.target.value })} />
            </Field>
            <Field
              label="Wygląd (opis dla AI)"
              hint="Im dokładniej, tym spójniejsza postać. Np. „kobieta ok. 25 lat, szczupła, blond włosy do ramion, jasna karnacja”."
            >
              <TextArea
                rows={2}
                value={editing.appearance ?? ''}
                onChange={(e) => patch({ appearance: e.target.value })}
                placeholder="Opisz wygląd modelki…"
              />
            </Field>
            <Field label="Dodatkowe wskazówki (poza, tło, oświetlenie) — opcjonalnie">
              <TextInput
                value={editing.promptNotes ?? ''}
                onChange={(e) => patch({ promptNotes: e.target.value })}
                placeholder="np. naturalna poza, miękkie światło"
              />
            </Field>

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="soft" onClick={generate} disabled={busy}>
                {generating ? <Loader2 size={16} className="animate-spin-slow" /> : <Sparkles size={16} />}
                Wygeneruj modelkę z opisu
              </Button>
              {/* „Anuluj" tylko gdy trwa generacja (jest co przerwać — controller≠null). */}
              {generating && (
                <Button variant="ghost" onClick={() => controller?.abort()}>
                  <X size={16} /> Anuluj
                </Button>
              )}
              <label
                className={clsx('btn-ghost', busy ? 'pointer-events-none opacity-50' : 'cursor-pointer')}
                aria-disabled={busy}
              >
                <Plus size={16} /> Wgraj zdjęcia
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  disabled={busy}
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? [])
                    if (files.length) addImages(files)
                    e.target.value = ''
                  }}
                />
              </label>
            </div>

            <div>
              <p className="label">Zdjęcia referencyjne ({editing.referenceImageIds.length})</p>
              {editing.referenceImageIds.length === 0 ? (
                <p className="rounded-xl bg-ink-50 px-4 py-6 text-center text-sm text-ink-400">
                  Brak zdjęć. Wgraj własne lub wygeneruj modelkę powyżej.
                </p>
              ) : (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {editing.referenceImageIds.map((id) => (
                    <div key={id} className="group relative overflow-hidden rounded-xl bg-ink-100">
                      <Thumb imageId={id} className="aspect-[3/4] w-full object-cover" />
                      <button
                        onClick={() => patch({ coverImageId: id })}
                        title="Ustaw jako okładkę"
                        className={clsx(
                          'absolute left-1.5 top-1.5 rounded-lg p-1 text-white',
                          editing.coverImageId === id ? 'bg-amber-500' : 'bg-black/50 opacity-0 group-hover:opacity-100',
                        )}
                      >
                        <Star size={13} fill={editing.coverImageId === id ? 'currentColor' : 'none'} />
                      </button>
                      <button
                        onClick={() => removeImage(id)}
                        className="absolute right-1.5 top-1.5 rounded-lg bg-black/50 p-1 text-white opacity-0 transition group-hover:opacity-100"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
