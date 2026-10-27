---
name: structure-map
description: Builds and maintains a navigation map of the current project. A dependency-free Node script scans the repo deterministically (screens, API routes, socket/IPC events, DB tables, services, tests, entry points, import hubs, unresolved dynamic cases) into STRUCTURE.md and docs/structure/*.md; you then describe only the uncovered paths in docs/structure/domains.md and offer a short pointer for agent instruction files. Arguments - check (freshness only), regenerate (rebuild after confirmation), migrate (convert an old-style STRUCTURE.md, keeping its descriptions). Use when the user runs /structure-map.
argument-hint: "[regenerate|check|migrate]"
disable-model-invocation: true
context: fork
agent: general-purpose
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/scan.mjs *), Bash(node "${CLAUDE_SKILL_DIR}/scripts/scan.mjs" *), Read, Write, Edit, Grep, Glob, AskUserQuestion
---

# structure-map

You run in a forked context: you do not see the user's conversation. Everything you need is here.
Project root = the current working directory. Scanner = `node "${CLAUDE_SKILL_DIR}/scripts/scan.mjs"`.
Division of labour: the script owns all facts (never edit generated files: STRUCTURE.md between the markers, docs/structure/*.md except domains.md). You only write `docs/structure/domains.md` and, after explicit confirmation, the pointer files.

Argument: `$ARGUMENTS`

## 0. Route by argument
- `check`: run the scanner with `--check --json`, report fresh/stale files and uncovered/gone counts. Write nothing. Stop.
- `regenerate`: ask (AskUserQuestion) before deleting generated files; on yes delete STRUCTURE.md's generated block files under docs/structure/ except domains.md and `.legacy/`, then continue with step 1.
- `migrate`, or step 1 reports `legacy: true` / exit 3: follow `references/migration.md` (harvest old descriptions into domains.md first, then `--migrate --json`, then ask about deleting `.legacy/`), then continue with step 2.
- empty: step 1.

## 1. Facts
Run the scanner with `--json`. Parse: `projects[].stack`, `counts`, `written`, `unchanged`, `uncovered`, `gone`, `counts.unresolved`, `tokens`, `legacy`. Exit code 3 means legacy files exist (see step 0). Do not re-scan the repo yourself; read generated files only when you need details for a description.

## 2. domains.md (only the delta)
Format and rules: `references/domains-format.md`. Keep it compact; no file trees, no copies of the generated tables.
- For each path in `uncovered`: give a one-line purpose (open the file only if its name and the facts rows are not enough) and put it under a domain. Prefer covering a whole directory with `dir/` when all its files share a purpose.
- For each path in `gone`: remove or update its mention.
- New domains: name them from folder and import clusters (`modules.md`: most imported files, entry points). Do not rename existing domains.
- Navigation flow: summarise the navigation edges from screens.md if present; otherwise write that it cannot be detected statically.
- Circular imports from modules.md: list them under "Circular imports".
- Unresolved: one line telling the reader to grep `unresolved.md` (do not try to resolve each case).
Then re-run the scanner with `--json`; repeat until `uncovered` and `gone` are empty or only contain paths you deliberately left out (say which and why).

## 3. Pointer and .gitattributes (never silent)
Read `references/pointer.md`. Show the exact 3-5 pointer lines and the list of target files that would change (skip targets that already contain the text). Ask with AskUserQuestion: write pointer? and append the two `merge=union` lines to `.gitattributes`? Only write what was approved. Never create CLAUDE.md or AGENTS.md.
If AskUserQuestion is not available in this context, write nothing here and put the exact proposed text and targets in the final report so the user can approve it.

## 4. Report (final message)
Stack per sub-project; counts (screens, routes, events, tables, services, tests, unresolved); files written vs unchanged; split files; uncovered/gone before and after; what the user approved or declined; anything you could not describe. Keep it short.

More: `references/notes.md` (coverage, limits, troubleshooting, other tools).
