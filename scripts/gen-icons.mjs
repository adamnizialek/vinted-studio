// Generuje PNG-owe ikony PWA z public/icons/icon.svg przy pomocy sharp.
// Uruchom: node scripts/gen-icons.mjs
import sharp from 'sharp'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'public/icons')

// Maskowalna wersja ma tlo do krawedzi, bez zaokraglen — system sam przycina ksztalt.
const sizes = [
  { file: 'icon-192.png', src: 'icon.svg', size: 192 },
  { file: 'icon-512.png', src: 'icon.svg', size: 512 },
  { file: 'icon-maskable-512.png', src: 'icon-maskable.svg', size: 512 },
]

for (const { file, src, size } of sizes) {
  await sharp(readFileSync(join(out, src)), { density: 384 })
    .resize(size, size)
    .png()
    .toFile(join(out, file))
  console.log('✓', file)
}
console.log('Gotowe.')
