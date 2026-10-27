# Migrating an old-style map (per project, never a disk-wide scan)

Old style = `STRUCTURE.md` without `<!-- structure-map:begin -->`, or `docs/structure/{screens,api-routes,db-tables}.md` without the `<!-- structure-map:facts` header. Detect with `node "${CLAUDE_SKILL_DIR}/scripts/scan.mjs" --detect` (JSON `{legacy, files}`). A normal run refuses to write (exit 3) while legacy files exist.

Steps:
1. Harvest: read every legacy file and copy the human knowledge into `docs/structure/domains.md`, keyed by path: domain names and descriptions, per-file purposes, navigation flow, notes. Drop counts, tables of routes/tables (the scanner regenerates them) and timestamps.
2. Migrate: `node "${CLAUDE_SKILL_DIR}/scripts/scan.mjs" --migrate --json`. It copies each legacy file to `docs/structure/.legacy/` (verified byte-equal) before writing the new hub and fact files. Originals are never overwritten without that backup.
3. Run the normal flow (uncovered/gone) once more.
4. Ask the user whether to delete `docs/structure/.legacy/`. Default: keep.
