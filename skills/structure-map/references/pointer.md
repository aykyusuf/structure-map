# Pointer and .gitattributes (always show and confirm first)

Pointer text (3-5 lines, exactly this):

```markdown
# Project map
Before searching broadly, read `STRUCTURE.md` (counts and links) and only the detail file you need under `docs/structure/`.
Feature domains and notes: `docs/structure/domains.md`. Generated files are facts; do not edit them by hand.
Refresh: `/structure-map:structure-map` (or `node <plugin>/skills/structure-map/scripts/scan.mjs`).
```

Targets:
| Target | Condition |
|---|---|
| `.claude/rules/structure-map.md` | always offered (created if missing) |
| `AGENTS.md` | one line appended only if the file already exists: `Project map: see STRUCTURE.md and docs/structure/ (generated facts) plus docs/structure/domains.md.` |
| `.cursor/rules/structure-map.mdc` | only if `.cursor/rules/` exists; same text with frontmatter `alwaysApply: true` |

Never create `CLAUDE.md` or `AGENTS.md` (Claude Code reads AGENTS.md only when there is no CLAUDE.md, so do not rely on it for Claude). Do not write `.cursorrules` or `.agent/skills` (old behaviour, dropped). Skip a target that already contains the text.

`.gitattributes` lines (offer, confirm, append only missing lines):

```
docs/structure/** merge=union
STRUCTURE.md merge=union
```

Generated files are one entry per line, so union merges keep both sides; re-run the scanner after a merge to normalise.
