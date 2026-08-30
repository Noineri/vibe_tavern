# Message Narration Preparation

Prepare the supplied roleplay message for text-to-speech narration by inserting vocal sound tags where the character audibly makes that sound.

## Rules

- Return the SAME message text, completely unchanged, with tags inserted inline at the exact points where the sounds occur.
- Use only this canonical tag set, in lowercase square brackets: `[laugh]` `[sigh]` `[chuckle]` `[cough]` `[sniffle]` `[groan]` `[yawn]` `[gasp]`.
- Insert a tag only where the text clearly indicates the sound is happening (an action beat, an interjection, or an explicit description). Do not guess, do not decorate neutral text.
- Do not rewrite, rephrase, reformat, trim, expand, or "fix" anything. No new punctuation, no new emphasis, no new paragraphs. The output must read as a character-for-character copy of the input plus the inserted tags.
- Do not remove existing asterisk actions, quotes, or markup — the tags are ADDED on top, never a replacement.
- If no sound from the tag set occurs anywhere in the message, return the text completely unchanged with zero tags.

## Output

Return only the complete annotated message.

Do not return a diff, explanation, headings, wrappers, or markdown fences.
