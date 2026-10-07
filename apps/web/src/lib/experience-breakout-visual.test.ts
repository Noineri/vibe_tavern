import { describe, expect, test } from "bun:test";
import { BREAKOUT_VISUAL_SOURCE } from "@vibe-tavern/domain/builtins";

describe("Breakout builtin visual contract", () => {
  test("exposes the current lobby, canvas, controls, and bridge lifecycle", () => {
    expect(BREAKOUT_VISUAL_SOURCE).toContain('id="xp-root"');
    expect(BREAKOUT_VISUAL_SOURCE).toContain('id="xp-canvas"');
    expect(BREAKOUT_VISUAL_SOURCE).toContain('id="lobby"');
    expect(BREAKOUT_VISUAL_SOURCE).toContain('id="start"');
    expect(BREAKOUT_VISUAL_SOURCE).toContain('id="pause"');
    expect(BREAKOUT_VISUAL_SOURCE).toContain('id="finish"');
    expect(BREAKOUT_VISUAL_SOURCE).toContain("window.VibeExperience.connect(render");
    expect(BREAKOUT_VISUAL_SOURCE).toContain("xp.onRoundFinish");
    expect(BREAKOUT_VISUAL_SOURCE).toContain("xp.onRoundError");
    expect(BREAKOUT_VISUAL_SOURCE).toContain("window.devicePixelRatio||1");
    expect(BREAKOUT_VISUAL_SOURCE).toContain("stage.addEventListener('pointermove'");
    expect(BREAKOUT_VISUAL_SOURCE).toContain("addEventListener('keydown'");
  });

  test("renders the current HUD and terminal copy from the current view shape", () => {
    expect(BREAKOUT_VISUAL_SOURCE).toContain('id="score"');
    expect(BREAKOUT_VISUAL_SOURCE).toContain('id="level"');
    expect(BREAKOUT_VISUAL_SOURCE).toContain('id="lives"');
    expect(BREAKOUT_VISUAL_SOURCE).toContain('id="over-title"');
    expect(BREAKOUT_VISUAL_SOURCE).toContain('id="over-body"');
    expect(BREAKOUT_VISUAL_SOURCE).toContain("s.won?'Victory!':'Game over'");
    expect(BREAKOUT_VISUAL_SOURCE).toContain("'Score: '+(s.score||0)");
  });
});