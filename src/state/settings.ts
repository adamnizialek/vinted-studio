import { create } from 'zustand'
import { getSettings, saveSettings } from '@/db/db'
import type { AppSettings } from '@/db/types'

interface SettingsState {
  settings: AppSettings | null
  loaded: boolean
  load: () => Promise<void>
  update: (patch: Partial<AppSettings>) => Promise<void>
  bumpImageCount: (n?: number) => Promise<void>
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: null,
  loaded: false,
  load: async () => {
    const settings = await getSettings()
    set({ settings, loaded: true })
  },
  update: async (patch) => {
    const settings = await saveSettings(patch)
    set({ settings })
  },
  bumpImageCount: async (n = 1) => {
    const current = get().settings ?? (await getSettings())
    await get().update({ imagesGenerated: (current.imagesGenerated ?? 0) + n })
  },
}))
