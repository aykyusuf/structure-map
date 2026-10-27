# domains.md format

`docs/structure/domains.md` is the only hand-written (LLM-written) file. The scanner creates it once from a template and never rewrites it.

Rules:
- Keep it compact. No file-tree dumps, no copies of the generated tables. Always-loaded overview text does not speed up navigation; this file is read on demand.
- Paths are repo-relative. A directory path ending in `/` covers everything below it. Paths mentioned here count as covered; the scanner reports the rest as `uncovered`, and paths mentioned here that no longer exist as `gone`.
- Put paths in backticks so the gone-check recognises them.

Template:

```markdown
# Domains and notes

## <Domain name>
<one line: what this domain does>
- `path/or/dir/` - one-line purpose
- `path/file.ext` - one-line purpose

## Navigation flow
<from the scanner's navigation edges, e.g. Login -> Home -> Detail; or "not detectable statically">

## Circular imports
<cycles the scanner reported, or "none reported">

## Unresolved
Dynamic routes/paths are listed in unresolved.md with file:line; grep there instead of guessing.
```

Choosing domains: start from top-level folders and import clusters (modules.md: most imported files, entry points). 3-12 domains is typical. A file belongs to one domain.
