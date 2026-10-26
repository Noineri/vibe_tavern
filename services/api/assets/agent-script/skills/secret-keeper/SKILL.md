---
name: secret-keeper
description: "Build a mystery or hidden truth the roleplay model cannot rewrite: a culprit, a motive, a treasure location, a character's secret, chosen once by the script and revealed step by step as clues are found. Use when the user wants a detective story, a whodunit, hidden facts, clues, a secret that must stay consistent, or says the model keeps changing who did it."
---

# Secret keeper

A roleplay model invents facts as it goes, so in a long mystery it forgets or changes who did it. A prompt script fixes the truth instead: it decides the hidden facts once, keeps them in `context.state`, and every turn tells the narrator what is true and which clues are already in play.

## The pattern

1. **Decide once.** On the first run there is no case in state yet: choose the facts and store them. Use `Math.random()` for this one-time choice and store it immediately. The seeded helpers (`context.pick`, `context.randomInt`) depend only on the message count, so two chats that start the mystery at the same point would get the same culprit. Once stored, a regenerate reads the stored truth and cannot change it.
2. **Clues unlock on what the script can see.** Words in the user's latest message (`context.chat.lastMessage`), the titles of lore entries that fired this turn (`context.lore.activeEntries`), the turn number (`context.chat.messageCount`), and counters the script keeps. Give each clue several trigger words, in the language the roleplay is written in: ask the user with `ask_user` if unsure.
3. **Count each turn once.** A regenerate runs the script again for the same turn, and its state changes are kept. Store the last processed turn number and skip detection when it has not changed.
4. **Tell the narrator every turn.** Inject a short system note: the hidden truth with an instruction to keep it hidden until it is revealed, plus the clues already found, so the scene can use them. Re-stating it every turn is what keeps a long story consistent.
5. **Give the user a way to accuse or force a reveal**, for example a typed `/accuse Name`, which the script checks against the stored truth.

Ask the user before building: the cast of suspects (or let the script read them from the story setup), the possible motives, the clues and what reveals them, and whether the narrator may know the truth. Recommend «yes»: a narrator that knows the truth and keeps it hidden plays fair; a narrator that does not know it may invent contradicting evidence.

## Example

```js prompt
// A whodunit: the culprit and motive are fixed on the first run and never change.
(function () {
  var SUSPECTS = ["the butler", "the gardener", "the niece"];
  var MOTIVES = ["an unpaid debt", "a hidden will", "an old betrayal"];
  // Each clue: trigger words (in the roleplay's language) and the fact it puts in play.
  var CLUES = [
    { id: "mud", words: ["boots", "mud", "garden"], fact: function (c) { return "Fresh mud on the study carpet matches the path " + c.culprit + " takes every evening."; } },
    { id: "letter", words: ["letter", "desk", "drawer"], fact: function (c) { return "A torn letter in the desk mentions " + c.motive + "."; } },
    { id: "alibi", words: ["alibi", "where were you", "last night"], fact: function (c) { return "Everyone's alibi holds except the one given by " + c.culprit + "."; } },
  ];

  var caseFile = context.state.get("caseFile", null);
  if (caseFile === null) {
    // One-time choice: not seeded, stored immediately, so it never changes afterwards.
    caseFile = {
      culprit: SUSPECTS[Math.floor(Math.random() * SUSPECTS.length)],
      motive: MOTIVES[Math.floor(Math.random() * MOTIVES.length)],
      found: [],
    };
  }

  var turn = context.chat.messageCount;
  var lastMessage = context.chat.lastMessage || "";
  var text = lastMessage.toLowerCase();
  var fired = context.lore.activeEntries;
  var loreTitles = fired.map(function (entry) { return entry.title.toLowerCase(); }).join(" | ");

  // Detect clues once per turn; a regenerate of the same turn skips this block.
  if (context.state.get("lastTurn", -1) !== turn) {
    CLUES.forEach(function (clue) {
      if (caseFile.found.indexOf(clue.id) !== -1) return;
      var hit = clue.words.some(function (w) { return text.indexOf(w) !== -1 || loreTitles.indexOf(w) !== -1; });
      if (hit) caseFile.found.push(clue.id);
    });
    // "/accuse the butler" settles the case.
    var accuse = /\/accuse\s+(.+)/i.exec(lastMessage);
    if (accuse) caseFile.accused = accuse[1].trim().toLowerCase();
    context.state.set("lastTurn", turn);
  }
  context.state.set("caseFile", caseFile);

  var facts = CLUES.filter(function (clue) { return caseFile.found.indexOf(clue.id) !== -1; })
    .map(function (clue) { return "- " + clue.fact(caseFile); });

  var note = "[Hidden truth, for the narrator only] The culprit is " + caseFile.culprit + ", driven by " + caseFile.motive + ". Never change this. Do not state it outright; let the evidence point to it.";
  if (facts.length > 0) note += "\nEvidence already found:\n" + facts.join("\n");
  if (caseFile.accused) {
    var correct = caseFile.accused.indexOf(caseFile.culprit.replace(/^the /, "")) !== -1;
    note += "\nThe player accused " + caseFile.accused + ". " + (correct ? "That is correct: let the culprit be exposed." : "That is wrong: the accused is innocent; the real culprit is still free.");
  }
  context.chat.injectMessage(note, "system");
})();
```

Adapt it: read suspects from the story (the card's scenario through `context.character.scenario`, or ask the user), add clues that unlock after N turns (`turn > 20`), or reveal a clue when a counter crosses a value.

## Limits to tell the user

- The script detects words, not meaning: «the boots» triggers the mud clue, a paraphrase may not. That is why each clue has several words and why the `/accuse` command exists; offer a manual reveal command too if the user wants one.
- The narrator still writes the scene. The note re-asserts the truth every turn, which keeps it consistent in practice, but a model can still slip; the stored truth itself never changes.
- The truth is visible to anyone who looks: in the script's state and in the prompt trace. Tell the user not to open them if they want to be surprised.
- Previews and sidechat reads run the script without saving its state, so a preview before the first real message may show a different culprit; the first real message fixes it.

## Testing

`run_script_test` simulates ONE user message with empty state: the first-run path. Run it with a message that contains a clue word (for example «I check the muddy boots») and read the injected note and the state. Tell the user to check multi-turn behavior in the editor's test panel with several lines (one message per line) or in a chat.
