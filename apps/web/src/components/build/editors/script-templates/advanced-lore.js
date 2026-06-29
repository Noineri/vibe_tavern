/**
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
  });
