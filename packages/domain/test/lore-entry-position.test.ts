import { expect, test } from "bun:test";
import { LORE_ENTRY_POSITION } from "../src/platform-constants.js";

test("exposes lore entry positions including persona anchors", () => {
  expect(LORE_ENTRY_POSITION).toEqual({
    beforeChar: "before_char",
    afterChar: "after_char",
    beforePersona: "before_persona",
    afterPersona: "after_persona",
    beforeExamples: "before_examples",
    afterExamples: "after_examples",
    topAn: "top_an",
    bottomAn: "bottom_an",
    atDepth: "at_depth",
    outlet: "outlet",
    beforePrompt: "before_prompt",
    inPrompt: "in_prompt",
    inChat: "in_chat",
    hiddenSystem: "hidden_system",
  });
});
