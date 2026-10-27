# structure-map

A project map for AI coding assistants that stays correct without burning tokens.

- A dependency-free Node script (`skills/structure-map/scripts/scan.mjs`) scans the repo deterministically and writes **facts**: screens, API routes, socket/IPC events, DB tables, services, tests, entry points, most-imported modules, import cycles, and an **Unresolved** list for everything dynamic (with file:line).
- The LLM only writes what a script cannot: one-line purposes and feature domains in `docs/structure/domains.md`, and only for paths the script reports as **uncovered** (diff-aware).

## Why this design
Earlier versions asked the model to read the whole repo: expensive, non-deterministic, and files got missed. The script is cheap (a 3,000-file repo scans in about a second), byte-identical on every run, and never invents entries. Large outputs are **split, never cut**: a file over the threshold becomes an index plus parts.

## Does a map help?
An ETH Zurich study found that overview files placed in always-loaded context did not make agents navigate faster. So the always-loaded pointer is 3-5 lines and the map itself lives in on-demand files. Measure on one real task in your project (time and tokens with and without the map) before relying on it.

## Install
Claude Code plugin (includes the freshness hook):
```
/plugin marketplace add aykyusuf/structure-map
/plugin install structure-map@structure-map
```
Skill only (no hook): `npx skills add aykyusuf/structure-map`

Requires Node >= 18 (macOS, Linux, Windows; no bash/jq needed).

## Usage
```
/structure-map:structure-map            # scan, describe uncovered paths, offer the pointer
/structure-map:structure-map check      # freshness only, writes nothing
/structure-map:structure-map regenerate # rebuild (asks first)
/structure-map:structure-map migrate    # convert an old-style STRUCTURE.md, keeping its descriptions
```
(Installed as a plain skill, the command is `/structure-map`.) The script also runs standalone:
`node skills/structure-map/scripts/scan.mjs [--root .] [--out docs/structure] [--hub STRUCTURE.md] [--check] [--budget 3500] [--json] [--detect] [--migrate]`

## What gets written
| File | Owner |
|---|---|
| `STRUCTURE.md` | script owns only the block between `<!-- structure-map:begin -->` and `<!-- structure-map:end -->`; the rest is yours |
| `docs/structure/{screens,api-routes,db-tables,services,tests,modules,unresolved}.md` (+ `<name>/` parts when split) | script (do not edit) |
| `docs/structure/domains.md` | LLM/you; the script creates it once and never rewrites it |
| `.claude/rules/structure-map.md`, one line in an existing `AGENTS.md`, `.cursor/rules/structure-map.mdc` if `.cursor/rules/` exists | only after you confirm |

Nothing else is created; `CLAUDE.md`/`AGENTS.md` are never created.

## Git
Commit the generated files. They are one entry per line, so add (the skill offers this):
```
docs/structure/** merge=union
STRUCTURE.md merge=union
```
to `.gitattributes`, and re-run the scanner after merges.

## Freshness hook
With the plugin, `SessionStart` and `Stop` run `scan.mjs --hook`. It acts only in projects that already have a structure-map `STRUCTURE.md`: refreshes facts (writes only when something changed; `Stop` is debounced to once per 30 s), and at session start prints a single line when files are undescribed, or when an old-style map should be migrated. In projects without a map it does nothing and creates nothing.

## Privacy
Everything runs locally. The script makes no network calls; the LLM step uses your normal Claude Code session.

## Limits
Regex/rule-based extraction, not a compiler: dynamic paths, routes built in loops or helpers, and runtime registration land in `unresolved.md` instead of being guessed. Gitignored files, files over 1 MB, binaries and minified bundles are not read. Supported frameworks and details: `skills/structure-map/references/notes.md`.

## License
MIT
