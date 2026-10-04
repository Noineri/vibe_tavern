/** Roll a dice formula and return its total, or null when the formula is invalid. */
export function rollDice(formula: string): { total: number } | null {
  const match = formula.match(/^(\d+)?d(\d+)([+-]\d+)?$/i);
  if (!match) return null;
  const count = Math.max(1, parseInt(match[1] || "1", 10));
  const sides = parseInt(match[2], 10);
  const modifier = parseInt(match[3] || "0", 10);
  if (sides < 2 || count > 100) return null;

  let total = modifier;
  for (let i = 0; i < count; i++) {
    total += Math.floor(Math.random() * sides) + 1;
  }
  return { total };
}
