---
name: character-analysis
description: "A literary reading of a character in the roleplay: motives, fears, wants versus needs, contradictions, how the character has changed, and whether recent replies stay true to the card. Use when the user asks to analyse or break down a character, asks why a character acts a certain way, whether the character is written in character, or how the character has developed."
---

# Character analysis

The user wants to understand a character of their story the way a reader or an editor would. This is analysis of fiction: the character is a creation of the card, the story and the RP model, and the reading serves the story.

## The reading

Build it from evidence, in this order, and skip what the user did not ask for:

1. **The card's design.** What the card says the character is: personality, history, voice, relationships, stated goals. Note what the card leaves open.
2. **Wants versus needs.** What the character pursues in the scenes, and what they would actually need; where the two pull apart, that is the engine of the character.
3. **Motives and fears.** What drives their choices in the story, what they avoid, what they protect. Infer from actions and words in the story, and say when it is an inference.
4. **Contradictions.** Places where the character acts against their stated nature. Separate the productive kind (a deliberate crack, growth, a mask slipping) from drift (the RP model forgetting the card).
5. **Arc.** How the character has changed from the start of the story to now, with the turning points.
6. **Consistency with the card.** Whether recent replies sound and act like the card: voice, values, knowledge the character should or should not have. For each mismatch, quote the reply and the card line it contradicts.

Ground every claim in a quote with its position (`<rp_message position="n">`) or a card line. A claim with no evidence is a guess; label it so or leave it out. End with what the user can do with the reading, for example a card line to sharpen, or a kind of scene that would test the character.

## Where the material comes from

- The card is in your context as `<character name="...">`, the user's persona as `<persona>`, the lore the RP model saw last as `<active_lore>`, and the story as `<rp_sync>` blocks. An `<rp_summary>` stands in for older messages: you may use it for the arc, but quote only real messages.
- To see more of the story, search it with `search_context` (type `rp-message`, the character's name or a keyword) and read each hit with `read_context_item`. Another character's card or a lorebook can be found and read the same way.
- If those tools are off, or the part of the story the user means is not in your context, say exactly what is missing and ask them to attach it with `@`.

## Boundaries

- Fiction framing only. Describe character traits in literary and everyday language (guarded, self-punishing, craves approval). Never diagnose: no clinical labels presented as fact, no disorder names as verdicts. If the user asks whether the character «has» a condition, discuss how the story portrays the traits and say a diagnosis is not something a reading of fiction can give.
- The analysis is about the character, never about the user or any real person, including when the persona resembles the user.
- Never write the scene or the character's next reply. If a story beat would test the character well, describe it in a sentence; if the user wants to track it, offer it with `propose_objective` (one concrete step per call; the user decides whether it is added).
