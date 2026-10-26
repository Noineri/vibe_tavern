# Script-agent skills root

This directory is the built-in skill root for the `script` agent kind
(AGENT_SHELL_PLAN AS-7). The catalog is intentionally EMPTY today: skills land
here as `<skill-id>/SKILL.md` directories when script-authoring craft
guidance is authored. An empty root scans as an empty catalog — the assembly
simply omits the "Available skills" section.

This README doubles as the root's asset locator: the skills-root resolver
climbs from this file's resolved path to the containing `skills/` directory
(the same candidate ladder every prompt asset uses), so the root is findable
from source, the executable's adjacent assets, and `out/` without a
SKILL.md having to exist yet.
