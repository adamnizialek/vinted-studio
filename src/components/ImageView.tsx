import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { ImageOff } from 'lucide-react'
import { db } from '@/db/db'
import { useObjectUrl } from '@/lib/hooks'

/** Lekka miniatura — pobiera tylko pole `thumb` (data URL), bez ladowania bloba. */
export function Thumb({
  imageId,
  className,
  alt = '',
}: {
  imageId?: string
  className?: string
  alt?: string
}) {
  const [thumb, setThumb] = useState<string>()
  useEffect(() => {
    let alive = true
    if (!imageId) {
      setThumb(undefined)
      return
    }
    db.images.get(imageId).then((rec) => alive && setThumb(rec?.thumb))
    return () => {
      alive = false
    }
  }, [imageId])

  if (!imageId || thumb === undefined)
    return (
      <div className={clsx('flex items-center justify-center bg-ink-100 text-ink-300', className)}>
        <ImageOff size={20} />
      </div>
    )
  return <img src={thumb} alt={alt} loading="lazy" className={className} />
}

/** Pelny obraz (objectURL z bloba). */
export function FullImage({
  imageId,
  className,
  alt = '',
}: {
  imageId?: string
  className?: string
  alt?: string
}) {
  const url = useObjectUrl(imageId)
  if (!url)
    return <div className={clsx('checker animate-pulse rounded-xl bg-ink-100', className)} />
  return <img src={url} alt={alt} className={className} />
}
