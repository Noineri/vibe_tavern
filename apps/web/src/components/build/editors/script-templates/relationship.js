/**
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
}
