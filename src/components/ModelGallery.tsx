import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { Download, Images, Loader2, Sparkles } from 'lucide-react'
import { db } from '@/db/db'
import type { AiModel } from '@/db/types'
import { getImageBlob } from '@/lib/images'
import { downloadBlob } from '@/lib/csv'
import { pluralPl } from '@/lib/format'
import {
  countImages,
  extForMime,
  groupGeneratedByModel,
  slugifyForFile,
  zipGalleryImages,
  type GalleryGroup,
  type GalleryImage,
} from '@/lib/modelGallery'
import { toast } from '@/state/toast'
import { Button, EmptyState, Modal } from '@/components/ui'
import { FullImage, Thumb } from '@/components/ImageView'

const photos = (n: number) => pluralPl(n, 'zdjęcie', 'zdjęcia', 'zdjęć')

/** Ikona przycisku pobierania: spinner w trakcie, strzałka w spoczynku. */
function DlIcon({ busy }: { busy: boolean }) {
  return busy ? <Loader2 size={16} className="animate-spin-slow" /> : <Download size={16} />
}

interface GallerySectionProps {
  group: GalleryGroup
  /** Trwa jakiekolwiek pobieranie (blokuje przyciski). */
  busy: boolean
  /** Trwa pobieranie WŁAŚNIE tej grupy (pokaż spinner + postęp). */
  downloading: boolean
  progressText: string | null
  onDownload: (g: GalleryGroup) => void
  onOpen: (img: GalleryImage) => void
  onDownloadOne: (img: GalleryImage) => void
}

/**
 * Sekcja jednej modelki. `memo`, by tyknięcia postępu pobierania (stan w rodzicu)
 * nie re-renderowały kafelków pozostałych grup — przy „pobierz wszystkie" żadna
 * sekcja nie dostaje `downloading`, więc kafelki się nie przeliczają na każdym kroku.
 */
const GallerySection = memo(function GallerySection({
  group,
  busy,
  downloading,
  progressText,
  onDownload,
  onOpen,
  onDownloadOne,
}: GallerySectionProps) {
  const cover =
    group.model?.coverImageId ?? group.model?.referenceImageIds[0] ?? group.images[0]?.id
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="h-12 w-9 shrink-0 overflow-hidden rounded-lg bg-ink-100">
          <Thumb imageId={cover} className="h-full w-full object-cover" alt={group.label} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-ink-900">{group.label}</p>
          <p className="text-xs text-ink-400">
            {group.images.length} {photos(group.images.length)}
          </p>
        </div>
        {downloading && progressText && (
          <span className="text-xs tabular-nums text-ink-400">{progressText}</span>
        )}
        <Button variant="ghost" onClick={() => onDownload(group)} disabled={busy}>
          <DlIcon busy={downloading} /> Pobierz ({group.images.length})
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
        {group.images.map((img) => (
          <div
            key={img.id}
            className="group relative overflow-hidden rounded-2xl bg-ink-100 ring-1 ring-ink-100"
          >
            <button
              type="button"
              onClick={() => onOpen(img)}
              className="block w-full"
              title="Powiększ"
            >
              <Thumb imageId={img.id} className="aspect-[3/4] w-full object-cover" />
            </button>
            <button
              type="button"
              onClick={() => onDownloadOne(img)}
              className="absolute bottom-1.5 right-1.5 rounded-lg bg-surface/90 p-1.5 text-ink-700 opacity-0 transition hover:bg-surface group-hover:opacity-100"
              title="Pobierz"
            >
              <Download size={15} />
            </button>
          </div>
        ))}
      </div>
    </section>
  )
})

/**
 * Zakładka „Galeria" modelek: wszystkie zdjęcia wygenerowane NA modelce (wirtualna
 * przymierzalnia), pogrupowane wg modelki, z pobieraniem wszystkich w pełnej
 * rozdzielczości (jedno archiwum ZIP). Kafelki używają miniatur (tanie); pełny
 * blob doczytujemy tylko w podglądzie i przy pobieraniu.
 */
export function ModelGallery({ models }: { models: AiModel[] | undefined }) {
  // Tylko lekkie pola — bez blobów w stanie React (galeria bywa duża).
  const generated = useLiveQuery(async (): Promise<GalleryImage[]> => {
    const recs = await db.images.where('kind').equals('generated').toArray()
    return recs.map((r) => ({
      id: r.id,
      kind: r.kind,
      modelId: r.modelId,
      mime: r.mime,
      createdAt: r.createdAt,
    }))
  }, [])

  const groups = useMemo(
    () => groupGeneratedByModel(generated ?? [], models ?? []),
    [generated, models],
  )
  const totalCount = useMemo(() => countImages(groups), [groups])

  const [downloadingKey, setDownloadingKey] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [lightbox, setLightbox] = useState<GalleryImage | null>(null)
  // Strażnik przed podwójnym kliknięciem — niezależny od stanu (stabilne callbacki).
  const downloadingRef = useRef(false)

  const runDownload = useCallback(
    async (key: string, target: GalleryGroup[], filename: string) => {
      if (downloadingRef.current) return
      downloadingRef.current = true
      setDownloadingKey(key)
      setProgress({ done: 0, total: countImages(target) })
      try {
        const { blob, included, skipped } = await zipGalleryImages({
          groups: target,
          fetchBlob: getImageBlob,
          onProgress: (done, total) => setProgress({ done, total }),
        })
        if (included === 0) {
          toast.error('Nie udało się pobrać żadnego zdjęcia (offline?).')
          return
        }
        downloadBlob(filename, blob)
        toast.success(
          skipped > 0
            ? `Pobrano ${included} ${photos(included)} (pominięto ${skipped} niedostępnych).`
            : `Pobrano ${included} ${photos(included)} ✨`,
        )
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Błąd pobierania.')
      } finally {
        downloadingRef.current = false
        setDownloadingKey(null)
        setProgress(null)
      }
    },
    [],
  )

  const downloadAll = useCallback(
    () => runDownload('all', groups, 'vinted-modelki-galeria.zip'),
    [runDownload, groups],
  )
  const downloadGroup = useCallback(
    (g: GalleryGroup) => runDownload(g.key, [g], `vinted-${slugifyForFile(g.label)}.zip`),
    [runDownload],
  )
  const openLightbox = useCallback((img: GalleryImage) => setLightbox(img), [])
  const downloadOne = useCallback(async (img: GalleryImage) => {
    const blob = await getImageBlob(img.id)
    if (!blob) return toast.error('Nie udało się pobrać zdjęcia.')
    downloadBlob(`vinted-${img.id.slice(0, 6)}.${extForMime(img.mime)}`, blob)
  }, [])

  if (generated === undefined || models === undefined)
    return (
      <div className="grid place-items-center py-16 text-ink-300">
        <Loader2 className="animate-spin-slow" />
      </div>
    )

  if (groups.length === 0)
    return (
      <EmptyState
        icon={<Images size={40} />}
        title="Brak zdjęć na modelkach"
        description="Wygeneruj zdjęcia w Studio (tryb „Na modelce”) — pojawią się tutaj, pogrupowane wg modelki."
        action={
          <Link to="/studio" className="btn-soft">
            <Sparkles size={16} /> Przejdź do Studia
          </Link>
        }
      />
    )

  const busy = downloadingKey !== null

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-500">
          {totalCount} {photos(totalCount)} w galerii
        </p>
        <div className="flex items-center gap-3">
          {downloadingKey === 'all' && progress && (
            <span className="text-xs tabular-nums text-ink-400">
              Pobieram {progress.done}/{progress.total}…
            </span>
          )}
          <Button onClick={downloadAll} disabled={busy}>
            <DlIcon busy={downloadingKey === 'all'} /> Pobierz wszystkie ({totalCount})
          </Button>
        </div>
      </div>

      {groups.map((g) => (
        <GallerySection
          key={g.key}
          group={g}
          busy={busy}
          downloading={downloadingKey === g.key}
          progressText={
            downloadingKey === g.key && progress ? `${progress.done}/${progress.total}…` : null
          }
          onDownload={downloadGroup}
          onOpen={openLightbox}
          onDownloadOne={downloadOne}
        />
      ))}

      <Modal
        open={lightbox !== null}
        onClose={() => setLightbox(null)}
        size="xl"
        title="Podgląd zdjęcia"
        footer={
          <div className="flex justify-end gap-2">
            {lightbox && (
              <Button variant="soft" onClick={() => downloadOne(lightbox)}>
                <Download size={16} /> Pobierz
              </Button>
            )}
            <Button variant="ghost" onClick={() => setLightbox(null)}>
              Zamknij
            </Button>
          </div>
        }
      >
        {lightbox && (
          <FullImage
            imageId={lightbox.id}
            className="mx-auto max-h-[72vh] w-auto rounded-xl object-contain"
          />
        )}
      </Modal>
    </div>
  )
}
