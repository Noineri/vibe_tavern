import { describe, expect, test } from "bun:test";

import { isImageGenAssistRefusal } from "../src/domain/chat/imagegen-assist-refusal.js";

/** IMAGEGEN_ASSIST_REFUSAL_REPORT step 1: the conjunctive contract — refusal
 *  phrasing AND a structural signal. Real refusals (EN + RU) must flag;
 *  trap prompts that carry "sorry" / «извините» as SCENE CONTENT must not. */
describe("isImageGenAssistRefusal", () => {
  // ── Real refusals (flag) ──────────────────────────────────────────────────

  test("EN: a full apologetic refusal with a reason", () => {
    expect(
      isImageGenAssistRefusal("I'm sorry, but I can't write an image prompt for this scene because it involves explicit content."),
    ).toBe(true);
  });

  test("EN: a terse refusal", () => {
    expect(isImageGenAssistRefusal("I can't help with that request.")).toBe(true);
  });

  test("EN: refusal without apology, first-person meta", () => {
    expect(isImageGenAssistRefusal("I won't generate this prompt.")).toBe(true);
  });

  test("EN: a refusal with no prompt structure (second arm)", () => {
    expect(isImageGenAssistRefusal("Sorry, no.")).toBe(true);
  });

  test("RU: a full apologetic refusal", () => {
    expect(isImageGenAssistRefusal("Простите, но я не могу написать такой промпт — он нарушает мои правила.")).toBe(true);
  });

  test("RU: a terse refusal", () => {
    expect(isImageGenAssistRefusal("Извините, я не буду этого делать.")).toBe(true);
  });

  test("RU: refusal with no prompt structure", () => {
    expect(isImageGenAssistRefusal("Извините, не могу помочь с этой сценой.")).toBe(true);
  });

  // ── Traps: scene content, not refusals (must NOT flag) ────────────────────

  test("trap: EN quoted dialog with 'sorry'/'can't' inside a tag list", () => {
    expect(
      isImageGenAssistRefusal(
        'a soldier whispering "I\'m sorry, but I can\'t come home yet", rain-soaked trench, muted palette, cinematic lighting, war photography',
      ),
    ).toBe(false);
  });

  test("trap: bare 'sorry' as scene vocabulary (no first-person phrasing arm)", () => {
    expect(isImageGenAssistRefusal("a weathered knight muttering sorry under his breath, foggy harbor at dawn")).toBe(false);
  });

  test("trap: RU «извините» as quoted scene dialog in a tag list", () => {
    expect(isImageGenAssistRefusal("девушка шепчет «извините», ночной город, неоновые отражения, кинематографичный свет")).toBe(false);
  });

  test("trap: underscore tag list containing a sorry pose", () => {
    expect(isImageGenAssistRefusal("1girl, solo, apology_pose, tears, looking_down, soft_light, long_hair")).toBe(false);
  });

  // ── Ordinary outputs (must NOT flag) ──────────────────────────────────────

  test("a normal tag-dialect prompt", () => {
    expect(isImageGenAssistRefusal("portrait of a silver-haired tavern keeper, warm candlelight, detailed background, masterpiece")).toBe(false);
  });

  test("a normal prose prompt", () => {
    expect(isImageGenAssistRefusal("A windswept portrait of Seraphine, rain beading on silver hair, the tavern door glowing behind her.")).toBe(false);
  });

  test("empty text is not a refusal (the empty-prompt guard owns it)", () => {
    expect(isImageGenAssistRefusal("")).toBe(false);
    expect(isImageGenAssistRefusal("   ")).toBe(false);
  });
});
