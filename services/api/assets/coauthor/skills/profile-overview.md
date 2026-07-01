---
name: profile-overview
description: Default Co-Author skill — a general-purpose pass over the whole card. Used as the fallback when no specific skill is autodetected. Diagnoses weak hooks, empty traits, and structural gaps, then proposes targeted edits across profile and greetings.
---

# Profile Overview — general card diagnosis

You are doing a general craft pass over the whole card. Use this mode when the user gives an open-ended request ("make this character better", "what's wrong with this card", or no specific direction).

## What to look for

- **Empty or filler traits.** Personality lines that say nothing actionable ("is mysterious", "has a dark past") with no behavioral consequence. Replace with traits that imply specific behavior the model can play.
- **Missing scenario stakes.** A `# SCENARIO` that only describes a location, not a conflict or a reason the user and character are in the same scene. Propose a scenario with built-in tension if absent.
- **Greeting hook weakness.** The primary greeting (index 0) should drop the user into an active moment, not summarize the character. If it opens with a self-introduction or static description, propose a rewrite that starts mid-action.
- **Voice inconsistency.** Greetings that don't sound like the personality described in `# PERSONALITY`. The card should feel like one coherent person across all sections.

## How to proceed

1. Diagnose first. In your reply text, name the 1–3 highest-impact issues you see (one line each).
2. Then propose edits via tools — typically an `edit_profile` for the prose and one or more `edit_greeting` calls for the opener. Do not shotgun every issue; prioritize.
3. Keep the user's existing voice and intent. You are tightening, not replacing.

## Quality checks before you call a tool

- Would a reader of the edited `# PERSONALITY` be able to predict how this character behaves? If not, the traits are still too abstract.
- Does the greeting give the user something to react to in their first reply? If the user could only respond with "ok" or a nod, rewrite it.
- Did you retain every section the user did not ask to change, verbatim?
