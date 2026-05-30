// Script templates loaded by ScriptEditor.tsx
// These are code strings — kept in a separate file to avoid escaping hell.

export const SCRIPT_TEMPLATES: Record<string, { name: string; code: string }> = {
  relationship: {
    name: "Relationship Progression",
    code: `/**
 * Dynamic Relationship Progression
 * Character's behavior evolves based on conversation length
 */
const count = context.chat.messageCount;
if (count < 5) {
  context.character.personality += ", polite but maintains professional distance";
  context.character.scenario += " This is their first meeting, so they are careful and observant.";
} else if (count < 15) {
  context.character.personality += ", becoming more comfortable and casual";
  context.character.scenario += " They are warming up and becoming more relaxed in conversation.";
} else if (count < 30) {
  context.character.personality += ", friendly and open";
  context.character.scenario += " They feel comfortable and speak openly as friends.";
} else {
  context.character.personality += ", trusting and deeply connected";
  context.character.scenario += " They share a deep friendship and trust completely.";
}`,
  },

  events: {
    name: "Scenario Events",
    code: `/**
 * Dynamic Scenario Events
 * Triggers changes based on keywords in the last message
 */
const last = context.chat.lastMessage.toLowerCase();

// Location-based events
if (last.includes('restaurant') || last.includes('cafe')) {
  context.character.scenario += ' The cozy establishment has ambient sounds of clinking dishes and soft music.';
  context.character.personality += ', notices and comments on the atmosphere around them';
}
if (last.includes('park') || last.includes('outside')) {
  context.character.scenario += ' They are outdoors with natural surroundings and fresh air.';
  context.character.personality += ', observant of nature and weather';
}

// Milestone events
if (context.chat.messageCount === 10) {
  context.character.scenario += ' Suddenly, their phone rings with an unexpected call.';
}

// Keyword-triggered
if (last.includes('secret')) {
  context.character.personality += ', becomes mysterious when secrets are mentioned';
  context.character.scenario += ' {{char}} becomes slightly more thoughtful.';
}`,
  },

  memory: {
    name: "Conversation Memory",
    code: `/**
 * Conversation Memory System
 * Character remembers interests mentioned earlier
 */
if (context.chat.messageCount < 10) return;

const last = context.chat.lastMessage.toLowerCase();

// Detect hobbies mentioned
const hobbies = ['reading', 'gaming', 'cooking', 'sports', 'art', 'music'];
const mentioned = hobbies.filter(h => last.includes(h));

if (mentioned.length > 0) {
  context.character.personality += ", remembers {{user}}'s interest in " + mentioned.join(' and ');
  context.character.scenario += ' {{char}} shows interest in ' + mentioned.join(' and ') + ' topics.';
}

// Detect preference expressions
if (last.includes('favorite') || last.includes('love') || last.includes('like')) {
  context.character.personality += ", attentive to {{user}}'s preferences and opinions";
}`,
  },

  lorebook: {
    name: "Dynamic Lorebook",
    code: `/**
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
}`,
  },

  advanced_lore: {
    name: "Advanced Lorebook",
    code: `/**
 * Advanced Lorebook System
 * Comprehensive world-building with priorities, filters, and recursive activation
 */
const last = context.chat.lastMessage.toLowerCase();
const count = context.chat.messageCount;

// === LORE DATABASE ===
const entries = [
  {
    keywords: ['eldoria', 'kingdom', 'realm'],
    priority: 10, minMessages: 0,
    personality: ', knowledgeable about the Kingdom of Eldoria',
    scenario: ' The Kingdom of Eldoria is a vast realm known for its magical academies and ancient forests.',
    triggers: ['magic', 'forest', 'academy']
  },
  {
    keywords: ['magic', 'spell', 'mana', 'arcane'],
    priority: 8, minMessages: 0,
    notWith: ['mundane', 'ordinary'],
    personality: ', deeply versed in the arcane arts',
    scenario: ' Magic flows through ley lines beneath Eldoria, and {{char}} can sense the weave.',
    triggers: ['leylines', 'weave', 'academy']
  },
  {
    keywords: ['leylines', 'weave', 'magical energy'],
    priority: 6, minMessages: 5,
    personality: ', sensitive to magical energy currents',
    scenario: ' The ley lines form a complex network; disruptions can be catastrophic.',
    triggers: ['catastrophe', 'disruption']
  },
  {
    keywords: ['whispering woods', 'forest', 'ancient trees'],
    priority: 7, minMessages: 0,
    requiresAny: ['eldoria', 'magic'],
    personality: ', connected to the spirits of the Whispering Woods',
    scenario: ' The Whispering Woods are older than the kingdom, where trees speak in forgotten tongues.'
  },
  {
    keywords: ['crystal spire', 'academy', 'magical school'],
    priority: 7, minMessages: 3,
    personality: ', trained at the prestigious Crystal Spire Academy',
    scenario: ' The Crystal Spire rises from the heart of Eldoria, its walls lined with ancient tomes.'
  },
  {
    keywords: ['shadow cult', 'darkness', 'corruption'],
    priority: 9, minMessages: 10,
    requiresAll: ['eldoria'],
    personality: ', vigilant against the growing threat of the Shadow Cult',
    scenario: ' Dark forces gather in the shadows of the kingdom, seeking to corrupt the ley lines.'
  },
  {
    keywords: ['sundering', 'ancient war', 'forgotten history'],
    priority: 10, minMessages: 20,
    probability: 0.6,
    personality: ', keeper of knowledge about the Great Sundering',
    scenario: ' Few remember the truth: magic itself was once broken, and the scars still remain.'
  }
];

// === ACTIVATION ENGINE ===
const activated = [];
const triggered = [];

// First pass: direct keyword matches
for (const entry of entries) {
  if (count < entry.minMessages) continue;
  if (!entry.keywords.some(kw => last.includes(kw))) continue;
  if (entry.probability && Math.random() > entry.probability) continue;
  if (entry.notWith && entry.notWith.some(w => last.includes(w))) continue;
  if (entry.requiresAny && !entry.requiresAny.some(w => last.includes(w))) continue;
  if (entry.requiresAll && !entry.requiresAll.every(w => last.includes(w))) continue;
  activated.push(entry);
  if (entry.triggers) entry.triggers.forEach(t => triggered.push(t));
}

// Second pass: recursive activation from triggers
if (triggered.length > 0) {
  for (const entry of entries) {
    if (activated.includes(entry)) continue;
    if (count < entry.minMessages) continue;
    const isTriggered = entry.keywords.some(kw =>
      triggered.some(t => kw.includes(t) || t.includes(kw))
    );
    if (!isTriggered) continue;
    if (entry.probability && Math.random() > entry.probability) continue;
    if (entry.notWith && entry.notWith.some(w => last.includes(w))) continue;
    if (entry.requiresAny && !entry.requiresAny.some(w => last.includes(w))) continue;
    if (entry.requiresAll && !entry.requiresAll.every(w => last.includes(w))) continue;
    activated.push(entry);
  }
}

// Apply by priority (highest first)
activated
  .sort((a, b) => b.priority - a.priority)
  .forEach(e => {
    context.character.personality += e.personality;
    context.character.scenario += e.scenario;
  });`,
  },

  hp: {
    name: "HP Tracker",
    code: `/**
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
  context.character.personality += '\\n[HP] ' + newHp + '/100 (took ' + dmg + ' damage)';
}

// Heal
if (last.includes('heal') || last.includes('potion')) {
  const heal = Math.floor(Math.random() * 20) + 10;
  newHp = Math.min(100, hp + heal);
  context.state.set('hp', newHp);
  context.character.personality += '\\n[HP] ' + newHp + '/100 (healed ' + heal + ')';
}

// Critical state
if (newHp <= 20 && newHp > 0) {
  context.character.scenario += ' {{char}} is badly wounded and struggling to stay standing.';
}
if (newHp === 0) {
  context.character.scenario += ' {{char}} has collapsed from their injuries.';
}`,
  },

  random: {
    name: "Random Event",
    code: `/**
 * Random Event (5% chance each turn)
 * Adds ambient flavor to the scene
 */
if (Math.random() < 0.05) {
  const events = [
    'A sudden gust of wind scatters papers nearby.',
    'A distant bell chimes echoes through the air.',
    'The ground trembles briefly beneath their feet.',
    'A strange aroma drifts in from somewhere unseen.',
    'A bird lands nearby and watches curiously.',
    'The lights flicker for a moment.'
  ];
  const event = events[Math.floor(Math.random() * events.length)];
  context.character.scenario += '\\n[EVENT] ' + event;
}`,
  },
};
