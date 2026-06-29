/**
 * Dice Roller
 * Responds to /roll commands in the latest user message.
 *
 * Supported syntax:
 *   /roll d20              — single die
 *   /roll 3d6              — multiple dice
 *   /roll 1d20+5           — with +/- modifier
 *   /roll 2d20 adv         — D&D advantage (keep highest)
 *   /roll 2d20 dis         — D&D disadvantage (keep lowest)
 *
 * Results are cached per message — regen returns the same numbers.
 * Output is injected as a system message visible to LLM in trace.
 */
(() => {
  const text = context.chat.lastMessage || '';
  const cmd = /\/roll\s+(\d+)?\s*d\s*(\d+|%)\s*([+-]\d+)?\s*(adv|dis|advantage|disadvantage)?/gi;
  const matches = [...text.matchAll(cmd)];
  if (matches.length === 0) return;

  // Stable per-message cache — same input message ⇒ same rolls on regen
  const cacheKey = 'roll_' + text.length + '_' + text.slice(-32);
  let results = context.state.get(cacheKey);

  if (!Array.isArray(results)) {
    results = [];
    for (const m of matches) {
      const count = parseInt(m[1] || '1', 10);
      const sidesRaw = m[2];
      const sides = sidesRaw === '%' ? 100 : parseInt(sidesRaw, 10);
      const mod  = m[3] ? parseInt(m[3], 10) : 0;
      const mode = (m[4] || '').toLowerCase();

      if (sides < 2 || count > 100 || count < 1) continue;

      const rolls = [];
      for (let i = 0; i < count; i++) rolls.push(context.randomInt(1, sides));

      let kept = rolls.slice();
      let note = '';
      const isAdv = mode === 'adv' || mode === 'advantage';
      const isDis = mode === 'dis' || mode === 'disadvantage';

      if ((isAdv || isDis) && rolls.length >= 2) {
        // Pick highest (adv) or lowest (dis); drop the rest
        const picked = isAdv ? Math.max(...rolls) : Math.min(...rolls);
        const pickedIdx = rolls.indexOf(picked);
        kept = [picked];
        const dropped = rolls.filter((_, i) => i !== pickedIdx);
        note = ' (' + (isAdv ? 'advantage' : 'disadvantage') + ', dropped ' + dropped.join(', ') + ')';
      }

      const sum = kept.reduce((a, b) => a + b, 0) + mod;
      const modStr = mod > 0 ? '+' + mod : (mod < 0 ? String(mod) : '');
      const formula = count + 'd' + sidesRaw + modStr;
      const keptStr = kept.join(kept.length > 1 ? ' + ' : '');

      results.push({ formula, keptStr, sum, note });
    }
    context.state.set(cacheKey, results);
  }

  if (results.length > 0) {
    const line = results
      .map(r => '🎲 ' + r.formula + ' → ' + r.sum + '   [' + r.keptStr + ']' + r.note)
      .join('  ·  ');
    context.chat.injectMessage('[Dice] ' + line, 'system');
  }
})();
