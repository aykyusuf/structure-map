# structure-map

AI agent skill that scans your project and generates a `STRUCTURE.md` hub file + detail files (screens, API routes, DB tables) grouped by feature domain. Helps AI coding assistants navigate your codebase without scanning everything on every prompt.

## Installation

### Via npx (recommended)

```bash
npx skills add yusufayik/structure-map
```

or

```bash
npx add-skill yusufayik/structure-map
```

### Manual Installation

<details>
<summary><strong>Claude Code</strong></summary>

Copy `skills/structure-map/SKILL.md` to:
```
~/.claude/skills/structure-map/SKILL.md
```

To use as a slash command (`/structure-map`), place it in:
```
~/.claude/commands/structure-map.md
```
(Strip the YAML frontmatter when using as a command file.)

</details>

<details>
<summary><strong>Codex</strong></summary>

Copy `skills/structure-map/SKILL.md` to:
```
~/.codex/skills/structure-map/SKILL.md
```

</details>

<details>
<summary><strong>Cursor</strong></summary>

Copy `skills/structure-map/SKILL.md` to:
```
~/.cursor/commands/structure-map.md
```
(Strip the YAML frontmatter when using as a command file.)

</details>

<details>
<summary><strong>GitHub Copilot</strong></summary>

Copy `skills/structure-map/SKILL.md` to:
```
.github/copilot-instructions/structure-map.md
```

</details>

## What It Generates

When invoked in any project, the skill scans the codebase and creates:

| File | Description |
|---|---|
| `STRUCTURE.md` | Hub file with quick lookup table, feature domains, navigation flow |
| `docs/structure/screens.md` | All screens/pages with file paths and purposes |
| `docs/structure/api-routes.md` | All API routes with methods, handlers, and purposes |
| `docs/structure/db-tables.md` | All database tables/models with key columns |

It also adds a "Project Map" reference to your AI instruction files (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.cursor/rules/`) if they exist — idempotently, so running it twice won't duplicate anything.

## Supported Tech Stacks

**Frontend**: Flutter, Next.js, React, Vue, Angular, Svelte
**Backend**: Flask, Django, FastAPI, Express, Rails, Go
**Database**: PostgreSQL, MySQL, SQLite, MongoDB, Prisma, Drizzle

Works with any combination. Adapts output to what's actually in your project — no empty sections for things that don't exist.

## Usage

After installation, invoke the skill in your AI coding tool:

- **Claude Code**: `/structure-map` or `$structure-map`
- **Codex**: `$structure-map`
- **Cursor**: `/structure-map`

Say "regenerate" to delete existing structure files and recreate from scratch.

## License

MIT
