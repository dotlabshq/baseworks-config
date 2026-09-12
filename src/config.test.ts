import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

describe('file permissions', () => {
  it('writes the config file 0600 and the directory 0700', () => {
    const cfg = createConfigManager<{ token?: string }>('secretapp', {})
    cfg.save({ token: 'eyJ-identity-jwt' })

    expect(statSync(cfg.writePath).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, '.secretapp')).mode & 0o777).toBe(0o700)
  })

  it('tightens an existing world-readable file', () => {
    const cfg = createConfigManager<{ token?: string }>('loose', {})
    mkdirSync(join(dir, '.loose'), { recursive: true })
    writeFileSync(cfg.writePath, 'token = "old"\n', { mode: 0o644 })
    expect(statSync(cfg.writePath).mode & 0o777).toBe(0o644)

    cfg.save({ token: 'new' })

    expect(statSync(cfg.writePath).mode & 0o777).toBe(0o600)
    expect(cfg.load().token).toBe('new')
  })

  it('leaves no temporary file behind', () => {
    const cfg = createConfigManager<{ a?: string }>('tidy', {})
    cfg.save({ a: '1' })
    expect(readdirSync(join(dir, '.tidy')).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('honours an explicit fileMode', () => {
    const cfg = createConfigManager<{ a?: string }>('shared', {}, { fileMode: 0o640 })
    cfg.save({ a: '1' })
    expect(statSync(cfg.writePath).mode & 0o777).toBe(0o640)
  })

  it('saveConfigFile is private by default', () => {
    const target = join(dir, 'nested', 'creds.toml')
    saveConfigFile(target, { token: 'x' })
    expect(statSync(target).mode & 0o777).toBe(0o600)
  })
})

describe("scope: 'global'", () => {
  it('ignores a project-local config when reading and writing', () => {
    // The shared harness points homedir() at `dir` and chdir's into it, so a
    // project rooted at `dir` would make both paths the same file. Work from a
    // sub-directory so global and local are genuinely distinct.
    const project = join(dir, 'project')
    mkdirSync(join(project, '.creds'), { recursive: true })
    process.chdir(project)

    const local = createConfigManager<{ who?: string }>('creds', {})
    local.save({ who: 'project-local' })

    const globalOnly = createConfigManager<{ who?: string }>('creds', {}, { scope: 'global' })
    globalOnly.save({ who: 'global' })

    expect(globalOnly.writePath).toBe(globalOnly.globalPath)
    expect(globalOnly.writePath).not.toBe(local.writePath)
    expect(globalOnly.load().who).toBe('global')
    // The project-local file is untouched.
    expect(local.load().who).toBe('project-local')
  })
})
