/**
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
  context.character.scenario += '\n[EVENT] ' + event;
}
