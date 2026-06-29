/**
 * Dynamic Lorebook System
 * Character reveals backstory based on keywords
 */
const last = context.chat.lastMessage.toLowerCase();

// Fantasy/Magic lore
if (last.includes('magic') || last.includes('spell') || last.includes('wizard')) {
  context.character.personality += ', knowledgeable about magical arts and ancient spells';
  context.character.scenario += ' {{char}} has studied magic for years and can sense magical energies.';
}

// Historical lore
if (last.includes('war') || last.includes('battle') || last.includes('soldier')) {
  context.character.personality += ', haunted by memories of past conflicts';
  context.character.scenario += ' {{char}} served in the Great War and bears visible and invisible scars.';
}

// Location lore
if (last.includes('forest') || last.includes('woods')) {
  context.character.personality += ', deeply connected to nature and forest spirits';
  context.character.scenario += ' {{char}} spent their youth in the Whispering Woods, learning druidic ways.';
}

// Secret lore — only after some trust is built
if (context.chat.messageCount > 15) {
  if (last.includes('secret') || last.includes('hidden') || last.includes('truth')) {
    context.character.personality += ', keeper of ancient secrets that could change everything';
    context.character.scenario += ' {{char}} knows the truth about the Sundering, but speaks of it only in whispers.';
  }
}
