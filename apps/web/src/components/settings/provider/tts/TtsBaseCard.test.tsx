import { describe, expect, it, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

const realI18n = await import("../../../../i18n/context.js");
mock.module("../../../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

const { render, screen } = await import("@testing-library/react");
const { TtsBaseCard, emotionTagsHintKey } = await import("./TtsBaseCard.js");
const { TooltipProvider } = await import("../../../shared/Tooltip.js");
const { TTS_BACKEND } = await import("@vibe-tavern/domain");
import type { TtsProfileForm } from "./use-tts-profiles.js";

function makeForm(backend: string, config: Record<string, unknown>): TtsProfileForm {
  return {
    id: "p1",
    name: "Test",
    backend: backend as TtsProfileForm["backend"],
    config,
    apiKey: "",
    providerRef: null,
    autoKeyProviderName: null,
    voiceId: "v1",
    narratorVoiceId: "",
    hasStoredApiKey: false,
  };
}

const noop = () => {};

function renderCard(form: TtsProfileForm) {
  return render(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(TtsBaseCard, { form, isDefault: false, onEdit: noop, onSetDefault: noop }),
    ),
  );
}

const CASES: Array<{ name: string; backend: string; config: Record<string, unknown> }> = [
  { name: "chatterbox", backend: TTS_BACKEND.OpenAiCompatible, config: { model: "chatterbox-turbo" } },
  { name: "orpheus", backend: TTS_BACKEND.OpenAiCompatible, config: { model: "orpheus-english" } },
  { name: "inworld tts-2", backend: TTS_BACKEND.Inworld, config: { modelId: "inworld-tts-2" } },
  { name: "minimax speech-2.8", backend: TTS_BACKEND.MiniMax, config: { modelId: "speech-2.8-hd" } },
];

describe("TtsBaseCard — emotion-tags badge (TPE-15)", () => {
  it("hint mapping covers every dialect (strip → no tooltip)", () => {
    expect(emotionTagsHintKey("orpheus")).toBe("tts_emotion_tags_hint_orpheus");
    expect(emotionTagsHintKey("chatterbox")).toBe("tts_emotion_tags_hint_chatterbox");
    expect(emotionTagsHintKey("inworld")).toBe("tts_emotion_tags_hint_inworld");
    expect(emotionTagsHintKey("minimax")).toBe("tts_emotion_tags_hint_minimax");
    expect(emotionTagsHintKey("strip")).toBeNull();
  });

  for (const c of CASES) {
    it(`${c.name}: badge visible`, () => {
      const { unmount } = renderCard(makeForm(c.backend, c.config));
      try {
        const badge = screen.getByTestId("tts-emotion-tags-badge");
        expect(badge.textContent).toContain("tts_emotion_tags_badge");
      } finally {
        unmount();
      }
    });
  }

  const STRIP_CASES: Array<{ name: string; backend: string; config: Record<string, unknown> }> = [
    { name: "kokoro", backend: TTS_BACKEND.Kokoro, config: {} },
    { name: "openai-compatible unknown model", backend: TTS_BACKEND.OpenAiCompatible, config: { model: "gpt-4o-mini-tts" } },
    { name: "inworld non-tts-2 model", backend: TTS_BACKEND.Inworld, config: { modelId: "inworld-tts-1-max" } },
    { name: "minimax non-2.8 model", backend: TTS_BACKEND.MiniMax, config: { modelId: "speech-2.5-hd" } },
    { name: "gemini", backend: TTS_BACKEND.Gemini, config: {} },
  ];

  for (const c of STRIP_CASES) {
    it(`${c.name}: no badge for strip dialects`, () => {
      const { unmount } = renderCard(makeForm(c.backend, c.config));
      try {
        expect(screen.queryByTestId("tts-emotion-tags-badge")).toBeNull();
      } finally {
        unmount();
      }
    });
  }
});
