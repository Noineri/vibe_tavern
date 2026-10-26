---
name: dice-checks
description: "Build dice checks for a roleplay: a d20 against a difficulty, advantage and disadvantage, 2d6 outcome bands, dice pools that count successes, Fate-style rolls, or a typed /roll command. Use when the user mentions dice, rolls, checks, saving throws, skill checks, a difficulty class, or a tabletop system."
---

# Dice checks

There are two ways to roll dice in Vibe Tavern. Pick one with the user before writing code, and say why.

## Choosing the route

| | Dice script | Prompt script with a typed `/roll` |
|---|---|---|
| Who rolls | The user, from the dice control in the chat | The script, when the user types `/roll …` in a message |
| Randomness | Server-owned; the faces are validated | The seeded helpers (`context.randomInt`), same result on regenerate |
| Result | Binding when `resolution` is `"strict"`: the RP model receives the outcome as a ruling | A system note the RP model reads; nothing enforces it |
| Can read the chat, state, character | No | Yes |
| Modifier | Fixed per check | Any — for example from stats kept in state |

Default: a dice script for checks whose result must hold (attacks, saves, skill checks); the `/roll` route for free-form rolls or modifiers that come from stats the script keeps.

The kind of a script is chosen when it is created and cannot change. If the open script is a prompt script and the user wants a dice script, tell them to create a new script of the dice kind and open the assistant there.

## Dice script rules

- Register checks with `context.dice.register({ id, label, notation, actors, resolution, help, resolve })`. Registration runs every time the script is loaded; one script may register many checks.
- `notation` is `NdS`, `NdS+M` or `NdS-M`. S is one of 4, 6, 8, 10, 12, 20 or `%` (d100 is an alias of d%). N is 1–32; the modifier is at most ±1000. There is no dF, no d3, no keep-highest syntax: advantage, pools and Fate dice are built inside `resolve` from ordinary rolls.
- `actors`: `["persona"]`, `["character"]` or both. The user can reassign who rolls in each chat.
- `resolution`: `"strict"` must return `final.outcome` (the ruling); `"narrative"` returns the numbers only and must NOT return an outcome.
- `resolve` takes no arguments. Inside it, roll with `context.dice.roll(notation)`; `context.actor` says who is rolling and `context.priorAttempts` lists earlier attempts of this roll.
- Return exactly this shape: `faces` (every die you rolled, each within the die size of the check's declared `notation`, at most 32), `modifier`, `subtotal` (the sum of `faces`), `total` (`subtotal + modifier`) and, for strict checks, `final: { total, outcome, degree, constraint }`. The server re-checks the arithmetic and rejects a mismatch. `final.total` is the number that matters (for example the kept die plus a bonus) and may differ from `total`. `constraint` is one sentence the RP model must honour; `degree` is a short label such as `"+1"`.
- Roll only dice of the declared size inside `resolve`: a check declared as d20 may roll `2d20`, never `1d6`.

### d20 against a difficulty, with advantage and disadvantage

```js dice
// d20 + 3 against DC 15. Three checks: normal, advantage, disadvantage.
var BONUS = 3;
var DC = 15;

function ruling(natural, finalTotal) {
  if (natural === 20) return { outcome: "Critical success", constraint: "The action succeeds beyond what was attempted." };
  if (natural === 1) return { outcome: "Critical failure", constraint: "The action fails and makes things worse." };
  if (finalTotal >= DC) return { outcome: "Success", constraint: "The action succeeds as intended." };
  return { outcome: "Failure", constraint: "The action does not succeed." };
}

function registerCheck(id, label, mode) {
  var notation = mode === "normal" ? "1d20" : "2d20";
  context.dice.register({
    id: id,
    label: label,
    notation: notation,
    actors: ["persona"],
    resolution: "strict",
    help: "d20 + " + BONUS + " vs DC " + DC + (mode === "normal" ? "" : ", " + mode),
    resolve: function () {
      var r = context.dice.roll(notation);
      // Advantage keeps the higher die, disadvantage the lower one.
      var natural = r.faces[0];
      if (mode === "advantage") natural = Math.max(r.faces[0], r.faces[1]);
      if (mode === "disadvantage") natural = Math.min(r.faces[0], r.faces[1]);
      var finalTotal = natural + BONUS;
      var rule = ruling(natural, finalTotal);
      return {
        faces: r.faces,
        modifier: r.modifier,
        subtotal: r.subtotal,
        total: r.total,
        final: { total: finalTotal, outcome: rule.outcome, degree: finalTotal >= DC ? "+1" : "-1", constraint: rule.constraint },
      };
    },
  });
}

registerCheck("check_dc15", "Check (DC 15)", "normal");
registerCheck("check_dc15_adv", "Check (DC 15, advantage)", "advantage");
registerCheck("check_dc15_dis", "Check (DC 15, disadvantage)", "disadvantage");
```

### 2d6 bands (Powered by the Apocalypse style)

```js dice
// 2d6 + 1: 10+ strong hit, 7-9 weak hit, 6- miss.
context.dice.register({
  id: "move_plus1",
  label: "Move (+1)",
  notation: "2d6+1",
  actors: ["persona"],
  resolution: "strict",
  help: "2d6+1: 10+ full success, 7-9 success at a cost, 6- the situation turns against you.",
  resolve: function () {
    var r = context.dice.roll("2d6+1");
    var outcome = "Miss";
    var constraint = "Things go wrong; the narrator makes a hard move.";
    if (r.total >= 10) {
      outcome = "Strong hit";
      constraint = "The character gets what they wanted.";
    } else if (r.total >= 7) {
      outcome = "Weak hit";
      constraint = "The character gets it, but at a cost or with a complication.";
    }
    return { faces: r.faces, modifier: r.modifier, subtotal: r.subtotal, total: r.total, final: { total: r.total, outcome: outcome, constraint: constraint } };
  },
});
```

### Dice pools that count successes

A check's notation is fixed, and a dice script cannot read how many dice the character has. Register one check per pool size instead; the user picks the right one in the dice control.

```js dice
// d10 pools of 1-8 dice; every 8+ is a success.
for (var size = 1; size <= 8; size++) {
  (function (n) {
    context.dice.register({
      id: "pool_" + n,
      label: "Pool of " + n,
      notation: n + "d10",
      actors: ["persona", "character"],
      resolution: "strict",
      help: n + "d10, each 8+ is a success.",
      resolve: function () {
        var r = context.dice.roll(n + "d10");
        var successes = 0;
        for (var i = 0; i < r.faces.length; i++) if (r.faces[i] >= 8) successes++;
        var outcome = successes === 0 ? "No successes" : successes + (successes === 1 ? " success" : " successes");
        return { faces: r.faces, modifier: r.modifier, subtotal: r.subtotal, total: r.total, final: { total: successes, outcome: outcome } };
      },
    });
  })(size);
}
```

### Fate-style rolls without Fate dice

There is no dF die. Roll 4d6 and read each face as 1–2 = −1, 3–4 = 0, 5–6 = +1.

```js dice
// Four Fate dice from 4d6, plus a fixed skill of +2, read on the Fate ladder.
var SKILL = 2;
var LADDER = ["Terrible", "Poor", "Mediocre", "Average", "Fair", "Good", "Great", "Superb", "Fantastic", "Epic", "Legendary"];
context.dice.register({
  id: "fate_skill2",
  label: "Fate roll (+2)",
  notation: "4d6",
  actors: ["persona"],
  resolution: "strict",
  help: "Four Fate dice + 2.",
  resolve: function () {
    var r = context.dice.roll("4d6");
    var shift = 0;
    for (var i = 0; i < r.faces.length; i++) shift += r.faces[i] <= 2 ? -1 : r.faces[i] <= 4 ? 0 : 1;
    var result = shift + SKILL;
    var step = Math.max(0, Math.min(LADDER.length - 1, result + 2));
    return { faces: r.faces, modifier: r.modifier, subtotal: r.subtotal, total: r.total, final: { total: result, outcome: LADDER[step] + " (" + (result >= 0 ? "+" : "") + result + ")" } };
  },
});
```

## The typed /roll route (prompt script)

The editor ships a «Dice Roller» template for this route; offer it as a starting point. The script reads the user's latest message, rolls with the seeded helpers (a regenerate gets the same numbers, no cache needed) and injects the result as a system note.

```js prompt
// "/roll 2d20+3 adv" in the user's message -> a binding note for the narrator.
(function () {
  var text = context.chat.lastMessage || "";
  var m = /\/roll\s+(\d*)d(\d+|%)\s*([+-]\d+)?\s*(adv|dis)?/i.exec(text);
  if (!m) return;
  var count = m[1] ? parseInt(m[1], 10) : 1;
  var sides = m[2] === "%" ? 100 : parseInt(m[2], 10);
  var mod = m[3] ? parseInt(m[3], 10) : 0;
  if (count < 1 || count > 20 || sides < 2 || sides > 100) return;
  var faces = [];
  for (var i = 0; i < count; i++) faces.push(context.randomInt(1, sides));
  var kept = faces.reduce(function (a, b) { return a + b; }, 0);
  if (m[4] && count === 2) kept = m[4].toLowerCase() === "adv" ? Math.max(faces[0], faces[1]) : Math.min(faces[0], faces[1]);
  var total = kept + mod;
  context.chat.injectMessage("[Dice] " + m[0].trim() + " -> rolled " + faces.join(", ") + ", total " + total + ". This result is final; narrate its consequences.", "system");
})();
```

To add a stat bonus, keep the stats in `context.state` (see the «progression» skill) and add them to `mod`.

## Limits to tell the user

- A dice script cannot read the chat, the character card, stats or state. A bonus that changes over the story needs one check per bonus, or the `/roll` route.
- The roll itself happens in the chat's dice control; the model cannot press it.
- The `/roll` route's result is text the model reads. A strict dice check is the stronger guarantee.
- Only the die sizes above exist. Offer the closest built from them (Fate from d6, a d3 as d6 halved) rather than promising a missing die.

## Testing

Run `run_script_test` after every change. For a dice script it discovers every check and makes one deterministic sample roll each: that proves registration and the return shape are valid, not the odds. For the `/roll` route, pass a message such as `/roll 2d20+3 adv` as the test input and read the injected note.
