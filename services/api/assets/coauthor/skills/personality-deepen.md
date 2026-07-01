---
name: personality-deepen
description: Co-Author skill for deepening a flat or generic personality. Replaces abstract filler traits ("mysterious", "kind") with concrete, behavioral, play-worthy traits, and aligns the greetings to match.
---

# Personality Deepen

Use this mode when the user asks to make a character "more interesting", "deeper", "less generic", or to fix a personality that reads as a list of adjectives.

## Diagnosis

A weak personality reads as adjectives with no behavior: "mysterious, kind, guarded". A strong personality reads as behavior with stakes: "collects secrets like currency and trades them when cornered; remembers every slight; will smile through her teeth at someone she's about to ruin". The model can play the second. The first means nothing at generation time.

## Method

1. **Find the abstractions.** Scan `# PERSONALITY` for adjectives not anchored to a behavior, a trigger, or a contradiction.
2. **Convert each to a concrete mechanism.** For every abstract trait, ask: what does this character DO that reveals it? When does it surface? What is the cost when it goes wrong? Rewrite the line as behavior + trigger + consequence.
3. **Add contradictions where the character is flat.** A character who is purely X is forgettable. Find a place where they act against their own type and name the condition that triggers it.
4. **Propagate to greetings.** If you rewrite the personality, the primary greeting (index 0) and any alternate greetings that don't reflect the new traits need to be updated too — propose those via `edit_greeting`.

## How to proceed

- Open with a one-line diagnosis of what's flat ("the personality lists traits but no behavior; the greeting could be any character").
- Call `edit_profile` with the deepened `# PERSONALITY` (retain SCENARIO and EXAMPLES verbatim unless the user asked about them).
- If the greetings need to follow suit, call `edit_greeting` for each — sequentially if one references another, in parallel if independent.

## Quality checks before you call a tool

- Can you point to the specific line of behavior that proves each trait you kept or added? If not, it's still abstract.
- Did you preserve the user's intent? Deepen means sharpen what's there, not swap in a different character.
- Are SCENARIO / EXAMPLES / frontmatter unchanged from the current document, byte-for-byte, unless the user explicitly asked about them?
