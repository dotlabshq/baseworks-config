/**
 * @baseworks/config
 *
 * Lightweight config loader for CLI tools and services. Supports TOML (default),
 * YAML and JSON — the format is chosen per file by extension.
 *
 * Resolution order (first found wins for single-file mode):
 *   1. {cwd}/.{appName}/config.{toml|yaml|yml|json}   — project-local
 *   2. {home}/.{appName}/config.{toml|yaml|yml|json}  — global fallback
 *
 * In layered mode both files are loaded and deep-merged (project-local wins).
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConfigFormat = 'toml' | 'yaml' | 'json'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>

export interface ConfigManagerOptions {
  /** Preferred format for new files. Existing files keep their own format. @default 'toml' */
  format?: ConfigFormat
  /** Load + deep-merge global and project-local (local wins). @default false */
  layered?: boolean
}

export interface ConfigManager<T extends AnyRecord> {
  load(): T
  save(cfg: T): void
  patch(partial: Partial<T>): void
  clearLocal(): void
  readonly writePath: string
  readonly globalPath: string
  readonly localPath: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ext(format: ConfigFormat): string {
  return format
}

function parse(raw: string, format: ConfigFormat): AnyRecord {
  if (format === 'json') return JSON.parse(raw) as AnyRecord
  if (format === 'toml') return (parseToml(raw) ?? {}) as AnyRecord
  return (parseYaml(raw) ?? {}) as AnyRecord
}

function serialize(cfg: AnyRecord, format: ConfigFormat): string {
  if (format === 'json') return JSON.stringify(cfg, null, 2) + '\n'
  if (format === 'toml') return stringifyToml(cfg) + '\n'
  return stringifyYaml(cfg)
}

function detectFormat(filePath: string): ConfigFormat {
  if (filePath.endsWith('.json')) return 'json'
  if (filePath.endsWith('.toml')) return 'toml'
  return 'yaml'
}

function readFile(filePath: string): { data: AnyRecord; format: ConfigFormat } | null {
  const candidates = [
    filePath,
    filePath.replace(/\.yaml$/, '.yml'),
    filePath.replace(/\.yml$/, '.yaml'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, 'utf8')
        return { data: parse(raw, detectFormat(p)), format: detectFormat(p) }
      } catch {
        return null
      }
    }
  }
  return null
}

function deepMerge<T extends AnyRecord>(base: T, override: Partial<T>): T {
  const result = { ...base }
  for (const key of Object.keys(override) as (keyof T)[]) {
    const ov = override[key]
    if (ov === undefined || ov === null) continue
    const bv = base[key]
    if (
      typeof ov === 'object' &&
      !Array.isArray(ov) &&
      typeof bv === 'object' &&
      !Array.isArray(bv) &&
      bv !== null
    ) {
      result[key] = deepMerge(bv as AnyRecord, ov as AnyRecord) as T[keyof T]
    } else {
      result[key] = ov as T[keyof T]
    }
  }
  return result
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createConfigManager<T extends AnyRecord>(
  appName: string,
  defaults: T = {} as T,
  options: ConfigManagerOptions = {},
): ConfigManager<T> {
  const format = options.format ?? 'toml'
  const layered = options.layered ?? false
  const e = ext(format)

  const globalDir = join(homedir(), `.${appName}`)
  const globalFile = join(globalDir, `config.${e}`)

  const getLocalFile = (): string => join(process.cwd(), `.${appName}`, `config.${e}`)

  function getWritePath(): string {
    const localFile = getLocalFile()
    const localDir = join(process.cwd(), `.${appName}`)
    return existsSync(localFile) || existsSync(localDir) ? localFile : globalFile
  }

  function load(): T {
    if (layered) {
      let cfg = { ...defaults }
      const global_ = readFile(globalFile)
      if (global_) cfg = deepMerge(cfg, global_.data as Partial<T>)
      const local_ = readFile(getLocalFile())
      if (local_) cfg = deepMerge(cfg, local_.data as Partial<T>)
      return cfg
    }
    const local_ = readFile(getLocalFile())
    if (local_) return deepMerge({ ...defaults }, local_.data as Partial<T>)
    const global_ = readFile(globalFile)
    if (global_) return deepMerge({ ...defaults }, global_.data as Partial<T>)
    return { ...defaults }
  }

  function save(cfg: T): void {
    const target = getWritePath()
    const dir = target.replace(/\/[^/]+$/, '')
    mkdirSync(dir, { recursive: true })
    const targetFormat = existsSync(target) ? detectFormat(target) : format
    writeFileSync(target, serialize(cfg as AnyRecord, targetFormat))
  }

  function patch(partial: Partial<T>): void {
    save(deepMerge(load(), partial))
  }

  function clearLocal(): void {
    const localFile = getLocalFile()
    if (existsSync(localFile)) unlinkSync(localFile)
  }

  return {
    get writePath() {
      return getWritePath()
    },
    get globalPath() {
      return globalFile
    },
    get localPath() {
      return getLocalFile()
    },
    load,
    save,
    patch,
    clearLocal,
  }
}

// ─── One-shot helpers ─────────────────────────────────────────────────────────

/** Load a single config file by explicit path. Supports .toml, .yaml, .yml, .json. */
export function loadConfigFile<T extends AnyRecord>(filePath: string, defaults: T = {} as T): T {
  const resolved = filePath.startsWith('~/') ? join(homedir(), filePath.slice(2)) : resolvePath(filePath)
  const result = readFile(resolved)
  if (!result) return { ...defaults }
  return deepMerge({ ...defaults }, result.data as Partial<T>)
}

/** Write a config object to a file. Format is inferred from the extension. */
export function saveConfigFile(filePath: string, cfg: AnyRecord): void {
  const resolved = filePath.startsWith('~/') ? join(homedir(), filePath.slice(2)) : resolvePath(filePath)
  const dir = resolved.replace(/\/[^/]+$/, '')
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolved, serialize(cfg, detectFormat(resolved)))
}

export { deepMerge }
