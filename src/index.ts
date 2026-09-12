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
 *
 * Config files routinely hold credentials — an identity JWT, an API token — so
 * every write here is private by default: the directory is created `0700`, the
 * file is written `0600`, and the write goes through a temporary file that is
 * renamed into place. The rename matters: `writeFileSync`'s `mode` option only
 * applies when the file is CREATED, so writing over an existing world-readable
 * file would silently leave it world-readable.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
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
  /**
   * Where config may live.
   *
   * - `'auto'` (default) — project-local `./.{app}/` when present, else global.
   * - `'global'` — only `~/.{app}/`. Use this when the file holds credentials:
   *   a project-local config sits inside a working tree and is one careless
   *   `git add` away from being committed.
   *
   * @default 'auto'
   */
  scope?: 'auto' | 'global'
  /**
   * Permission bits for the config file. Lower it further if you must; raising
   * it above `0o600` is almost always a mistake for a file holding secrets.
   *
   * @default 0o600
   */
  fileMode?: number
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

const DIR_MODE = 0o700
const FILE_MODE = 0o600

/**
 * Write a file privately and atomically.
 *
 * The temp file is created with `wx` so a stale temp from a crashed run can
 * never be reused with its old permissions, and `rename` carries the temp
 * file's mode onto the target — which is how an existing loose-moded file gets
 * tightened rather than silently kept loose.
 *
 * An existing directory's mode is left alone: tightening a directory somebody
 * else created is a surprising side effect, and the file's own `0600` is what
 * actually protects the contents.
 */
function writePrivate(target: string, contents: string, fileMode: number = FILE_MODE): void {
  mkdirSync(dirname(target), { recursive: true, mode: DIR_MODE })
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, contents, { mode: fileMode, flag: 'wx' })
    renameSync(tmp, target)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // cleanup is best-effort; the original error is what matters
    }
    throw err
  }
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
  const globalOnly = (options.scope ?? 'auto') === 'global'
  const fileMode = options.fileMode ?? FILE_MODE
  const e = ext(format)

  const globalDir = join(homedir(), `.${appName}`)
  const globalFile = join(globalDir, `config.${e}`)

  const getLocalFile = (): string => join(process.cwd(), `.${appName}`, `config.${e}`)

  function getWritePath(): string {
    if (globalOnly) return globalFile
    const localFile = getLocalFile()
    const localDir = join(process.cwd(), `.${appName}`)
    return existsSync(localFile) || existsSync(localDir) ? localFile : globalFile
  }

  function load(): T {
    if (globalOnly) {
      const only = readFile(globalFile)
      return only ? deepMerge({ ...defaults }, only.data as Partial<T>) : { ...defaults }
    }
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
    const targetFormat = existsSync(target) ? detectFormat(target) : format
    writePrivate(target, serialize(cfg as AnyRecord, targetFormat), fileMode)
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

/**
 * Write a config object to a file. Format is inferred from the extension.
 * Private by default (`0600`); pass `mode` to widen it deliberately.
 */
export function saveConfigFile(filePath: string, cfg: AnyRecord, options: { mode?: number } = {}): void {
  const resolved = filePath.startsWith('~/') ? join(homedir(), filePath.slice(2)) : resolvePath(filePath)
  writePrivate(resolved, serialize(cfg, detectFormat(resolved)), options.mode ?? FILE_MODE)
}

export { deepMerge }
