import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import { migrateSettings, DEFAULT_SETTINGS } from '@/db/db'
import type { AppSettings } from '@/db/types'

describe('migrateSettings', () => {
  it('upgrades a legacy v1 row from 2.5-flash-image to 3.1-flash-image @ 2K', () => {
    const v1 = {
      ...DEFAULT_SETTINGS,
      imageModel: 'gemini-2.5-flash-image',
      schemaVersion: 1,
    } as AppSettings
    delete (v1 as Partial<AppSettings>).imageResolution

    const out = migrateSettings(v1)
    expect(out.imageModel).toBe('gemini-3.1-flash-image')
    expect(out.imageResolution).toBe('2K')
    expect(out.schemaVersion).toBe(2)
  })

  it('does NOT override a user who deliberately picked another model', () => {
    const v1 = {
      ...DEFAULT_SETTINGS,
      imageModel: 'gemini-3-pro-image',
      schemaVersion: 1,
    } as AppSettings
    const out = migrateSettings(v1)
    expect(out.imageModel).toBe('gemini-3-pro-image')
    expect(out.schemaVersion).toBe(2)
  })

  it('is a no-op for already-migrated v2 settings', () => {
    const v2 = {
      ...DEFAULT_SETTINGS,
      imageModel: 'gemini-3.1-flash-image',
      imageResolution: '4K',
      schemaVersion: 2,
    } as AppSettings
    expect(migrateSettings(v2)).toEqual(v2)
  })
})
