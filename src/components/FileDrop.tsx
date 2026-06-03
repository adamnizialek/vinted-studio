import { useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { UploadCloud } from 'lucide-react'

/** Pole do wgrywania obrazow — klik lub przeciagnij i upusc. */
export function FileDrop({
  onFiles,
  multiple = true,
  disabled,
  children,
  className,
}: {
  onFiles: (files: File[]) => void
  multiple?: boolean
  disabled?: boolean
  children?: ReactNode
  className?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

  const handle = (list: FileList | null) => {
    if (!list) return
    const files = Array.from(list).filter((f) => f.type.startsWith('image/'))
    if (files.length) onFiles(multiple ? files : files.slice(0, 1))
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        handle(e.dataTransfer.files)
      }}
      className={clsx(
        'flex w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-4 py-8 text-center transition',
        over ? 'border-brand-400 bg-brand-50' : 'border-ink-200 bg-ink-50/60 hover:border-brand-300 hover:bg-brand-50/40',
        disabled && 'pointer-events-none opacity-50',
        className,
      )}
    >
      {children ?? (
        <>
          <UploadCloud className="text-brand-500" />
          <span className="text-sm font-semibold text-ink-700">
            Przeciągnij zdjęcia lub kliknij, aby wybrać
          </span>
          <span className="text-xs text-ink-400">JPG / PNG · wiele plików naraz</span>
        </>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple={multiple}
        hidden
        onChange={(e) => {
          handle(e.target.files)
          e.target.value = ''
        }}
      />
    </button>
  )
}
