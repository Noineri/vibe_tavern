/**
 * Conversation Memory System
 * Character remembers interests mentioned earlier
 */
(() => {
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
  }
})();
