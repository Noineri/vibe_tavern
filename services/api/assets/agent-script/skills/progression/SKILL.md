---
name: progression
description: "Track progress in a roleplay with a script: stats, health, inventory, gold, quests, relationship or trust meters with thresholds that unlock new content, and systems split across several cooperating scripts. Use when the user asks for an inventory, stats, levels, quests, an affection or trust meter, unlockable backstory, or game-like progress in a chat."
---

# Progression

A prompt script keeps numbers and lists in `context.state`, changes them from what the user types, and shows the narrator a compact status line every turn. Thresholds unlock content: when trust reaches 50, the narrator is told the character may now speak about their past.

## The pattern

1. **One state object** for the whole system (stats, inventory, quests, meters), read with a default: `context.state.get("sheet", { … })`.
2. **Changes come from text the script can see.** Typed commands are the reliable path (`/give rope`, `/drop rope`, `/quest add Find the key`, `/gold +15`), each on its own line of the message, so the rest of the message is never swallowed into an item name. Keywords can nudge meters (a thank-you raises trust by 1), but cap them per turn so a long message does not count ten times. Write keywords in the roleplay's language; ask with `ask_user` when unsure.
3. **Count each turn once.** A regenerate runs the script again for the same turn and keeps its state, so store the last processed turn (`context.chat.messageCount`) and apply changes only when it changes.
4. **Thresholds unlock once**: keep a list of unlocked keys and add a note the first time a meter crosses its line.
5. **Status line every turn** as a system note, short enough to read at a glance. The user sees it in the prompt trace; offer to also add it to the scenario (`context.character.scenario`) when the user wants the model to treat it as part of the setting.
6. **Several scripts can cooperate** through `context.shared`: an earlier script writes a value, a later script in the same turn reads it. The order is the script order in the editor. Use it to keep each script small: one tracks mood, another uses the mood to choose how a scene opens.

## Example: inventory, gold, quests and a trust meter

```js prompt
// Character sheet driven by typed commands, with a trust meter that unlocks backstory.
(function () {
  var sheet = context.state.get("sheet", { hp: 20, gold: 10, items: [], quests: [], trust: 0, unlocked: [] });
  var turn = context.chat.messageCount;
  var lastMessage = context.chat.lastMessage || "";
  var text = lastMessage.toLowerCase();

  if (context.state.get("lastTurn", -1) !== turn) {
    // Each command sits on its own line: "/give rope" — the rest of the message is ignored.
    var give = /^\/give\s+(.+)$/im.exec(lastMessage);
    if (give) sheet.items.push(give[1].trim());
    var drop = /^\/drop\s+(.+)$/im.exec(lastMessage);
    if (drop) sheet.items = sheet.items.filter(function (it) { return it.toLowerCase() !== drop[1].trim().toLowerCase(); });
    var gold = /^\/gold\s+([+-]\d+)\s*$/im.exec(lastMessage);
    if (gold) sheet.gold = Math.max(0, sheet.gold + parseInt(gold[1], 10));
    var quest = /^\/quest add\s+(.+)$/im.exec(lastMessage);
    if (quest) sheet.quests.push(quest[1].trim());
    // Keyword nudge, at most +1 per turn.
    if (["thank you", "i trust you", "i'm sorry"].some(function (w) { return text.indexOf(w) !== -1; })) sheet.trust = Math.min(100, sheet.trust + 1);
    context.state.set("lastTurn", turn);
  }

  var notes = [];
  // Thresholds fire once each.
  if (sheet.trust >= 50 && sheet.unlocked.indexOf("past") === -1) {
    sheet.unlocked.push("past");
    notes.push("Trust is high enough: the character may now open up about their past if the moment fits.");
  }
  context.state.set("sheet", sheet);

  // Let later scripts in this turn read the trust level.
  context.shared.set("trust", sheet.trust);

  var status = "[Status] HP " + sheet.hp + ", gold " + sheet.gold +
    ", items: " + (sheet.items.length ? sheet.items.join(", ") : "none") +
    ", quests: " + (sheet.quests.length ? sheet.quests.join("; ") : "none") +
    ", trust " + sheet.trust + "/100.";
  context.chat.injectMessage(status + (notes.length ? " " + notes.join(" ") : "") + " Only these commands change the numbers; narrate consistently with them.", "system");
})();
```

## Example: a second script that reads the first one

```js prompt
// Runs AFTER the sheet script (script order in the editor): reads trust through context.shared.
(function () {
  var trust = context.shared.get("trust", 0);
  var tone = trust >= 50 ? "warm and open" : trust >= 20 ? "polite but guarded" : "cold and suspicious";
  context.chat.injectMessage("[Mood] The character is " + tone + " toward " + (context.persona ? context.persona.name : "the user") + ".", "system");
})();
```

## Limits to tell the user

- State belongs to this script in this chat. Another chat starts fresh; another script cannot read it except through `context.shared` during the same turn, and `context.shared` is not saved between turns.
- Numbers change only from what the script detects in text: commands and keywords. When the model writes «you lose 5 HP», nothing changes unless the script reads the assistant's previous message (`context.chat.messages`) or the user types a command. Offer that when the user wants it, with the risk that the model's wording varies.
- The command text itself reaches the model as part of the user's message; the status note tells it how to treat the numbers.
- Two scripts that cooperate depend on their order in the editor: say which one must come first.

## Testing

`run_script_test` simulates ONE user message with empty state. Test each command with its own message (`/give rope`, `/gold +15`) and read the state and the note. A threshold that needs many turns cannot be reached in one test: suggest a temporary higher starting value while testing, and multi-turn checks in the editor's test panel (one message per line) or in a chat. Cooperating scripts are tested one at a time; their order is checked in a chat.
