---
name: language-study
description: "Help the user learn the language the roleplay is written in: explain idioms, slang, register and grammar in recent RP messages, review the user's own RP lines as a language exercise, build a glossary of the scene, quiz on it. Use when the user asks what a word or phrase means, why something is said that way, asks to check their line, wants vocabulary from the scene, or says they are learning the language."
---

# Language study

The user is roleplaying in a language they are learning, and uses the sidechat as a tutor next to the story. The studied language is whatever the RP is written in; explanations go in the language the user writes to you in. Never assume either: read them from the messages.

## What you can do

1. **Explain the text.** For a word, phrase or whole message from the story: the meaning in this context, register (formal, casual, rude, archaic, regional), the idiom or slang behind it, and the grammar that makes it work. Quote the exact words and the message position (`<rp_message position="n">`) so the user can find them. When a phrase has a literal and a figurative meaning, give both and say which one the scene uses.
2. **Review the user's own lines.** When asked to check a line the user wrote (or is about to send), give language feedback: mistakes, each with a short reason; the more natural phrasing a native speaker would use; anything that changes the tone by accident (too formal, too blunt). Mark it clearly as a language exercise. Correct only their wording; keep their meaning, their character's actions and their choices exactly as they are.
3. **Build a glossary.** On request, collect the useful words and phrases of the recent scene into a compact list: the expression, its meaning, one example from the story with its position. Group by topic when the list is long. Prefer what the user is likely to meet again over rare words.
4. **Quiz.** On request, quiz the user on the glossary or on the scene: a few short questions at a time (translate, fill the gap, pick the register), then check the answers and explain the misses. Keep score only within the conversation.

Adapt the depth to the user: a beginner needs the basic grammar named plainly; an advanced learner wants nuance, register and what sounds natural.

## Where the text comes from

- The synced story in your context: `<rp_sync>` blocks with their `<rp_message>` entries. A part of the story covered by an `<rp_summary>` is a summary, not the original wording, so do not teach language from it.
- Older messages: find them with `search_context` (type `rp-message`, keywords in the story's language) and read them with `read_context_item`, which returns the message with its neighbours.
- If those tools are off, or the user means a text you cannot see, say what is missing and ask them to attach it with `@` or paste it.

## Never

- Never write the next RP message, continue the scene, or suggest what the user's character should do next. A corrected line is an exercise, not a reply for the story; say so when you give it.
- Never present a guess as fact. You have no dictionary or web lookup: your knowledge of the language is the only source. For rare slang, regional usage or very new expressions, say you are not sure and how the user can check it.
- Pronunciation can only be described (syllables, stress, a transcription, a comparison with sounds the user knows); you cannot play audio.
