# @baseworks/config

A lightweight **layered config loader** for CLI tools and services. One call
gives you config that merges a **project-local** file over a **global** one,
in **TOML** (default), YAML, or JSON — the format is chosen per file by
extension, so a project can override a global YAML with a local TOML.

```
~/.myapp/config.toml   (global)   ─┐
                                    ├─ deep-merge (local wins) ─▶ typed config
./.myapp/config.toml   (local)    ─┘
```

## Quick start

```ts
import { createConfigManager } from '@baseworks/config'

interface AppConfig { db: string; tenants: string[] }

const cfg = createConfigManager<AppConfig>(
  'myapp',
  { db: 'file:./local.db', tenants: ['acme'] },   // defaults
  { format: 'toml', layered: true },
)

const { db, tenants } = cfg.load()   // defaults ← global ← local, deep-merged
cfg.patch({ db: 'libsql://…' })      // merge + persist to the active file
```

## Where files live

| | path |
|---|---|
| global | `~/.{appName}/config.{ext}` |
| project-local | `./.{appName}/config.{ext}` (cwd) |

- **layered** (`layered: true`) — both files load and deep-merge; local wins.
- **single-file** (default) — the first found (local, then global) wins.
- `save()` writes to the local file if a local dir/file exists, else the global
  one; an existing file keeps its own format regardless of `format`.

## API

`createConfigManager<T>(appName, defaults, options?)` → `ConfigManager<T>`:

| member | purpose |
|---|---|
| `load()` | read config (merged in layered mode, else first found) |
| `save(cfg)` | write to the active path |
| `patch(partial)` | deep-merge partial values and persist |
| `clearLocal()` | delete the project-local file |
| `writePath` / `globalPath` / `localPath` | resolved absolute paths |

Options: `format` (`'toml'` \| `'yaml'` \| `'json'`, default `'toml'`) ·
`layered` (default `false`).

**Explicit-path helpers** (no app-name convention):

```ts
import { loadConfigFile, writeConfigFile } from '@baseworks/config'

const c = loadConfigFile('~/.myapp/settings.yaml', { theme: 'dark' })
writeConfigFile('./out/config.toml', c)   // format inferred from the extension
```

`deepMerge(base, override)` is exported too, for merging config-shaped objects.

## Formats

TOML via [`smol-toml`](https://github.com/squirrelchat/smol-toml), YAML via
[`yaml`](https://github.com/eemeli/yaml), JSON built-in. The extension picks the
parser; `format` only decides what a *new* file is written as.

## Develop

```bash
pnpm test        # vitest
pnpm build       # tsup → dist
```
