/**
 * HP Tracker
 * Persistent health system with damage/healing
 */
const hp = context.state.get('hp', 100);
const last = context.chat.lastMessage.toLowerCase();
let newHp = hp;

// Take damage
if (last.includes('hit') || last.includes('attack')) {
  const dmg = Math.floor(Math.random() * 15) + 5;
  newHp = Math.max(0, hp - dmg);
  context.state.set('hp', newHp);
  context.character.personality += '\n[HP] ' + newHp + '/100 (took ' + dmg + ' damage)';
}

// Heal
if (last.includes('heal') || last.includes('potion')) {
  const heal = Math.floor(Math.random() * 20) + 10;
  newHp = Math.min(100, hp + heal);
  context.state.set('hp', newHp);
  context.character.personality += '\n[HP] ' + newHp + '/100 (healed ' + heal + ')';
}

// Critical state
if (newHp <= 20 && newHp > 0) {
  context.character.scenario += ' {{char}} is badly wounded and struggling to stay standing.';
}
if (newHp === 0) {
  context.character.scenario += ' {{char}} has collapsed from their injuries.';
}
