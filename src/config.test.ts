import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Point homedir() at a per-test temp dir so the global config path is fully
// hermetic and $HOME is never touched.
let TEST_HOME = ''
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => TEST_HOME || actual.homedir() }
})

const { createConfigManager, loadConfigFile, saveConfigFile } = await import('./index.js')

let dir: string
let cwd: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cfg-'))
  TEST_HOME = dir
  cwd = process.cwd()
  process.chdir(dir)
})

afterEach(() => {
  process.chdir(cwd)
  TEST_HOME = ''
  rmSync(dir, { recursive: true, force: true })
})

interface Cfg {
  org?: string
  llm?: { provider?: string; model?: string }
}

describe('config manager — TOML', () => {
  it('round-trips a nested config as TOML', () => {
    const cm = createConfigManager<Cfg>('cio', {}, { format: 'toml' })
    cm.save({ org: 'org-demo', llm: { provider: 'gate9', model: 'gemma4:26b' } })

    expect(cm.globalPath.endsWith('.cio/config.toml')).toBe(true)
    expect(cm.load()).toEqual({ org: 'org-demo', llm: { provider: 'gate9', model: 'gemma4:26b' } })
  })

  it('patches individual values, preserving the rest', () => {
    const cm = createConfigManager<Cfg>('cio', {}, { format: 'toml' })
    cm.save({ org: 'org-demo', llm: { provider: 'gate9', model: 'gemma4:26b' } })
    cm.patch({ llm: { model: 'qwen3.6:27b' } })

    expect(cm.load()).toEqual({ org: 'org-demo', llm: { provider: 'gate9', model: 'qwen3.6:27b' } })
  })

  it('applies defaults when no file exists', () => {
    const cm = createConfigManager<Cfg>('cio', { org: 'fallback' }, { format: 'toml' })
    expect(cm.load()).toEqual({ org: 'fallback' })
  })

  it('supports explicit-path TOML round-trips', () => {
    const path = join(dir, 'x.toml')
    saveConfigFile(path, { org: 'acme', llm: { model: 'gemma4:26b' } })
    expect(loadConfigFile<Cfg>(path)).toEqual({ org: 'acme', llm: { model: 'gemma4:26b' } })
  })
})
