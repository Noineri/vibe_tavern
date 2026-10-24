---
name: living-world
description: "Give a roleplay world its own clock and life: in-story time of day and days passing, weather and seasons, where side characters are at each hour, random ambient events that a regenerate cannot reroll, and the atmosphere of a place when its lore entry fires. Use when the user asks for time, a day/night cycle, a calendar, weather, schedules, a world that moves on its own, or random encounters."
---

# Living world

A prompt script can keep a world clock in `context.state` and tell the narrator, every turn, what time it is, what the weather is and who is where. The narrator then writes scenes that fit, and the world keeps moving even when the user does not mention it.

## The pattern

1. **A clock in state**: day number and minutes since midnight. Each turn it advances by a fixed step (for example 20 minutes); phrases in the user's latest message make it jump: «next morning» to day + 1 at 08:00, «hours later» by three hours, «that evening» to 19:00. Write the phrases in the roleplay's language; ask the user with `ask_user` which language and which jumps they want.
2. **Advance once per turn.** A regenerate runs the script again for the same turn and keeps its state changes, so store the last processed turn (`context.chat.messageCount`) and only advance when it changes.
3. **Weather per day**: pick it when the day changes and store it, so it stays the same all day. `context.weightedPick` makes some weather more likely; since the pick is stored, a regenerate cannot change it.
4. **Schedules**: a table of side characters and where they are in each part of the day.
5. **Ambient events**: a small chance each turn with `context.random()`. It is seeded by the turn, so a regenerate produces the same event instead of a new roll.
6. **Places**: when a location's lore entry fires this turn (`context.lore.activeEntries`), add its atmosphere for the current time and weather.
7. **One short system note per turn** with all of it. Keep it compact: the narrator reads it on every turn.

## Example

```js prompt
// World clock, weather, schedules and ambient events, told to the narrator every turn.
(function () {
  var STEP_MINUTES = 20;
  // Phrase -> how the clock jumps. Use the roleplay's language.
  var JUMPS = [
    { words: ["next morning", "the next day"], apply: function (c) { c.day += 1; c.minutes = 8 * 60; } },
    { words: ["hours later", "a few hours"], apply: function (c) { c.minutes += 180; } },
    { words: ["that evening", "by evening"], apply: function (c) { if (c.minutes < 19 * 60) c.minutes = 19 * 60; } },
  ];
  var WEATHER = [
    { value: "clear skies", weight: 4 },
    { value: "light rain", weight: 2 },
    { value: "fog rolling in from the river", weight: 1 },
    { value: "a cold wind", weight: 2 },
  ];
  var SCHEDULE = {
    "Mara the smith": { morning: "at the forge", afternoon: "at the forge", evening: "at the tavern", night: "asleep at home" },
    "Old Ivo": { morning: "feeding the pigeons on the square", afternoon: "at the tavern", evening: "at the tavern", night: "at the tavern, half asleep" },
  };
  var EVENTS = ["a cart loses a wheel on the main road", "a stray dog follows the nearest stranger", "bells ring for a wedding nobody mentioned"];
  var PLACES = { "the tavern": "smoke, spilled ale and low voices", "the market": "shouting traders and the smell of bread" };

  var clock = context.state.get("clock", { day: 1, minutes: 9 * 60, weather: null });
  var turn = context.chat.messageCount;
  var lastMessage = context.chat.lastMessage || "";
  var text = lastMessage.toLowerCase();

  if (context.state.get("lastTurn", -1) !== turn) {
    var startDay = clock.day;
    var jumped = false;
    JUMPS.forEach(function (jump) {
      if (!jumped && jump.words.some(function (w) { return text.indexOf(w) !== -1; })) {
        jump.apply(clock);
        jumped = true;
      }
    });
    if (!jumped) clock.minutes += STEP_MINUTES;
    while (clock.minutes >= 24 * 60) { clock.minutes -= 24 * 60; clock.day += 1; }
    if (clock.weather === null || clock.day !== startDay) clock.weather = context.weightedPick(WEATHER).value;
    context.state.set("lastTurn", turn);
  }
  context.state.set("clock", clock);

  var hour = Math.floor(clock.minutes / 60);
  var part = hour < 6 ? "night" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : hour < 23 ? "evening" : "night";
  var hhmm = (hour < 10 ? "0" : "") + hour + ":" + (clock.minutes % 60 < 10 ? "0" : "") + (clock.minutes % 60);

  var people = Object.keys(SCHEDULE).map(function (name) { return name + " is " + SCHEDULE[name][part]; });
  var note = "[World] Day " + clock.day + ", " + part + " (" + hhmm + "). Weather: " + clock.weather + ". " + people.join("; ") + ".";

  // Seeded by the turn: a regenerate gets the same event, not a fresh roll.
  if (context.random() < 0.1) note += " In the background: " + context.pick(EVENTS) + ".";

  var fired = context.lore.activeEntries;
  fired.forEach(function (entry) {
    var key = entry.title.toLowerCase();
    if (PLACES[key]) note += " " + entry.title + " right now: " + PLACES[key] + ", in the " + part + " " + clock.weather + ".";
  });

  context.chat.injectMessage(note + " Keep the scene consistent with this.", "system");
})();
```

## Limits to tell the user

- Time is counted in turns and phrases, not in real story time: a long conversation in one room still moves the clock 20 minutes per message. Offer a bigger or smaller step, or a `/time 18:00` command to set it by hand.
- Phrase detection is word matching in the user's message. The model's own «the sun sets» does not move the clock unless the script also reads the previous assistant message (`context.chat.messages`), which the user can ask for.
- The script informs the narrator; it does not write scenes. A model can still ignore a detail; the note repeats every turn.
- Each chat has its own clock: the state belongs to the chat and to this script.

## Testing

`run_script_test` simulates one user message with empty state: the clock starts from its defaults and advances once. Test a jump with a message such as «We sleep. The next morning we leave» and read the note and the state. Multi-turn behavior (the clock advancing over several messages) is checked by the user in the editor's test panel with one message per line, or in a chat.
