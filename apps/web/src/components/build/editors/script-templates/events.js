/**
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
}
