/**
 * Fate Die Template
 *
 * A classic d20 check against fixed outcome bands. Either the persona or the
 * character may roll; the result is `strict` — a binding outcome plus a short
 * narrative constraint the GM should honor.
 *
 * Bands:
 *   1          — Critical Setback
 *   2–7        — Setback
 *   8–13       — Mixed / Uncertain
 *   14–19      — Favorable
 *   20         — Critical Opportunity
 *
 * Dice-script API (see the Dice API reference in the editor):
 *   - `context.dice.register({ id, label, notation, actors, resolution, help?, resolve })`
 *     is called once at discovery time; `notation` is declared on the check.
 *   - Inside `resolve()`, the frozen roll context is read from the VM globals:
 *     `context.dice.roll(notation)`, `context.actor`, `context.priorAttempts`.
 *     There is no `attempt` argument — `resolve()` takes none.
 */
context.dice.register({
  id: "fate_die",
  label: "Fate Die",
  notation: "1d20",
  actors: ["persona", "character"],
  resolution: "strict",
  help: "Fate d20: 1 critical setback, 2-7 setback, 8-13 mixed, 14-19 favorable, 20 critical opportunity.",
  resolve: function () {
    var r = context.dice.roll("1d20");
    var total = r.total;

    var outcome, constraint, degree;
    if (total === 1) {
      outcome = "Critical Setback";
      constraint = "The worst possible outcome occurs, with compounding complications.";
      degree = "-2";
    } else if (total <= 7) {
      outcome = "Setback";
      constraint = "The action fails or introduces a serious complication.";
      degree = "-1";
    } else if (total <= 13) {
      outcome = "Mixed / Uncertain";
      constraint = "The action succeeds at a cost, or the situation escalates unpredictably.";
      degree = "0";
    } else if (total <= 19) {
      outcome = "Favorable";
      constraint = "The action succeeds as intended.";
      degree = "+1";
    } else {
      outcome = "Critical Opportunity";
      constraint = "The action succeeds flawlessly, granting an unexpected advantage.";
      degree = "+2";
    }

    return {
      faces: r.faces,
      modifier: r.modifier,
      subtotal: r.subtotal,
      total: total,
      final: { total: total, outcome: outcome, degree: degree, constraint: constraint },
    };
  },
});
