# Sidechat skills root

This directory is the built-in skill root for the `sidechat-ooc` agent kind
(SIDECHAT_PLAN SC-5). The catalog is intentionally EMPTY today: SC-5 ships
the root, not content — skills land here as `<skill-id>/SKILL.md` directories
only when sidechat craft guidance is authored (a later, owner-visible
decision). An empty root scans as an empty catalog, and a skill pinned in a
sidechat thread simply does not resolve until one exists (the loader's
dangling-pin skip, never fatal).

This README doubles as the root's asset locator: the skills-root resolver
climbs from this file's resolved path to the containing `skills/` directory
(the same candidate ladder every prompt asset uses — the pattern
`agent-script/skills/README.md` established), so the root is findable from
source, the executable's adjacent assets, and `out/` without a `SKILL.md`
having to exist yet.
