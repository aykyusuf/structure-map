# Notes: what the scanner sees, troubleshooting, other tools

## Coverage (regex/rule based, no parsers)
Flutter (go_router incl. nesting and const paths, MaterialApp routes, Navigator/go_router/MaterialPageRoute edges, auto_route), SwiftUI (screens reached via WindowGroup/TabView/NavigationLink/navigationDestination/sheet), VB6 (.frm/.bas/.cls/.vbp, Windows-1254 tolerated), Next.js app/pages routers, SvelteKit, react-router, vue-router, Angular, plain HTML, Express/Fastify/NestJS (incl. mounts and register prefixes), socket.io and NestJS gateways, Electron IPC and windows, Flask/FastAPI (blueprint/router prefixes repo-wide), Django, Python http.server, Rails, Go net/http, gin/echo groups, chi Route/Group/With/Mount, SQL/Prisma/Drizzle/Knex/TypeORM/Mongoose/Sequelize/SQLAlchemy/Django/Peewee/Alembic/drift. Generic mode always: entry points, notebooks (title only), data/weights dirs (count and size only), import in-degree and cycles.

## Limits
- Anything computed at runtime (template paths, loops, factories, helper calls) goes to `unresolved.md` with file:line. It is never guessed.
- Gitignored files are not scanned (git ls-files). Files > 1 MB, binaries, lockfiles and minified bundles are skipped.
- Confidence: `resolved` (followed a constant/prefix), `literal` (string in the source), `unresolved`.

## Output size
Each detail file stays under the split threshold (`--budget`, default 3500 tokens). Bigger files become an index plus parts in `docs/structure/<name>/`; nothing is cut.

## Troubleshooting
- Exit 3: legacy files present, see migration.md.
- `--check` exits 1 and lists stale files; run without `--check` to refresh.
- Node >= 18 required (Mac, Linux, Windows; no shell tools).

## Instruction files of other tools
| Tool | File | Policy |
|---|---|---|
| Claude Code | `.claude/rules/structure-map.md` | offered |
| Codex / generic agents | `AGENTS.md` | one line, only if it exists |
| Cursor | `.cursor/rules/structure-map.mdc` | only if `.cursor/rules/` exists |
| Copilot, Gemini, Windsurf | not written | add the pointer manually if wanted |
