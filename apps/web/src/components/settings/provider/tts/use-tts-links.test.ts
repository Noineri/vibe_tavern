import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

import {
  __setTtsLinksDepsForTests,
  computeMutedPut,
  computeVoiceTargetsPut,
  useTtsLinks,
  type TtsLinkPutRow,
  type TtsLinksDeps,
} from "./use-tts-links.js";
import type { TtsLinkRecord } from "../../../../api/tts-api.js";

const { render, act, cleanup } = await import("@testing-library/react");

function link(
  targetType: TtsLinkRecord["targetType"],
  targetId: string,
  mode?: "voice" | "disabled",
): TtsLinkRecord {
  return { ttsProfileId: "p1", targetType, targetId, ...(mode !== undefined ? { mode } : {}) };
}

// ── deps seam mocks (no mock.module — see the seam note in use-tts-links.ts) ──

let getLinksResponse: TtsLinkRecord[] = [];
const getLinksCalls: string[] = [];
const getLinks = mock(async (id: string): Promise<TtsLinkRecord[]> => {
  getLinksCalls.push(id);
  return getLinksResponse;
});
const putCalls: Array<{ id: string; rows: TtsLinkPutRow[] }> = [];
const putLinks = mock(async (id: string, rows: TtsLinkPutRow[]): Promise<void> => {
  putCalls.push({ id, rows });
});
const refreshVoiceMap = mock(async (): Promise<void> => {});

const deps: TtsLinksDeps = { getLinks, putLinks, refreshVoiceMap };

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

beforeEach(() => {
  getLinksResponse = [];
  getLinksCalls.length = 0;
  putCalls.length = 0;
  getLinks.mockClear();
  putLinks.mockClear();
  refreshVoiceMap.mockClear();
  __setTtsLinksDepsForTests(deps);
});

afterEach(async () => {
  __setTtsLinksDepsForTests(null);
  await act(async () => {});
  cleanup();
});

// ── pure merge functions ──────────────────────────────────────────────────

describe("computeVoiceTargetsPut (merge rule 1a)", () => {
  it("replaces voice rows with the selection and PRESERVES foreign disabled rows", () => {
    const current = [
      link("character", "c1", "voice"),
      link("character", "c2", "disabled"),
      link("persona", "p1", "voice"),
    ];
    // The popover always emits the FULL voice set (c1 + p1 stay bound).
    const next = computeVoiceTargetsPut(current, [
      { targetType: "character", targetId: "c1" },
      { targetType: "persona", targetId: "p1" },
    ]);
    expect(next).toEqual([
      { targetType: "character", targetId: "c2", mode: "disabled" },
      { targetType: "character", targetId: "c1", mode: "voice" },
      { targetType: "persona", targetId: "p1", mode: "voice" },
    ]);
  });

  it("binding a muted target replaces the mute (user intent)", () => {
    const current = [link("character", "c2", "disabled")];
    const next = computeVoiceTargetsPut(current, [{ targetType: "character", targetId: "c2" }]);
    expect(next).toEqual([{ targetType: "character", targetId: "c2", mode: "voice" }]);
  });

  it("legacy rows without mode are treated as voice and dropped when unselected", () => {
    const current = [link("character", "c1")];
    const next = computeVoiceTargetsPut(current, []);
    expect(next).toEqual([]);
  });
});

describe("computeMutedPut (merge rule 1b)", () => {
  it("preserves persona voice rows and non-muted character voice rows", () => {
    const current = [
      link("persona", "p1", "voice"),
      link("character", "c1", "voice"),
      link("character", "c2", "voice"),
    ];
    const next = computeMutedPut(current, ["c2"]);
    expect(next).toEqual([
      { targetType: "persona", targetId: "p1", mode: "voice" },
      { targetType: "character", targetId: "c1", mode: "voice" },
      { targetType: "character", targetId: "c2", mode: "disabled" },
    ]);
  });

  it("muting a voice-bound character DROPS its voice row (no PK conflict)", () => {
    const current = [link("character", "c2", "voice")];
    const next = computeMutedPut(current, ["c2"]);
    expect(next).toEqual([{ targetType: "character", targetId: "c2", mode: "disabled" }]);
  });

  it("old mute rows are replaced wholesale by the new ids", () => {
    const current = [link("character", "c1", "disabled"), link("character", "c2", "disabled")];
    const next = computeMutedPut(current, ["c2"]);
    expect(next).toEqual([{ targetType: "character", targetId: "c2", mode: "disabled" }]);
  });
});

// ── hook behavior ──────────────────────────────────────────────────────────

interface CapturedHook {
  links: TtsLinkRecord[];
  loading: boolean;
  error: string | null;
  setVoiceTargets: (targets: Array<{ targetType: "character" | "persona"; targetId: string }>) => Promise<void>;
  setMutedCharacters: (ids: string[]) => Promise<void>;
  reload: () => Promise<void>;
}

function renderProbe(profileId: string | null): { captured: { api?: CapturedHook } } {
  const captured: { api?: CapturedHook } = {};
  render(
    React.createElement(function HookProbe(props: { profileId: string | null }): null {
      const api = useTtsLinks(props.profileId);
      captured.api = api;
      return null;
    }, { profileId }),
  );
  return { captured };
}

describe("useTtsLinks", () => {
  it("loads links for a non-null profile id; null id stays empty and not loading", async () => {
    const serverRows = [link("character", "c1", "voice"), link("character", "c2", "disabled")];
    getLinksResponse = serverRows;

    const { captured } = renderProbe("p1");
    await flush();
    expect(captured.api?.links).toEqual(serverRows);
    expect(captured.api?.loading).toBe(false);
    expect(captured.api?.error).toBeNull();
    cleanup();

    const { captured: nullCaptured } = renderProbe(null);
    await flush();
    expect(nullCaptured.api?.links).toEqual([]);
    expect(nullCaptured.api?.loading).toBe(false);
    // Only the single "p1" load — the null probe never fetches.
    expect(getLinksCalls).toEqual(["p1"]);
  });

  it("setVoiceTargets PUTs the MERGED set, then reloads links and refreshes the voice map", async () => {
    getLinksResponse = [link("character", "c2", "disabled"), link("persona", "p1", "voice")];

    const { captured } = renderProbe("p1");
    await flush();

    // Popover emits the full selection: p1 stays bound, c1 newly bound.
    await act(async () => {
      await captured.api?.setVoiceTargets([
        { targetType: "persona", targetId: "p1" },
        { targetType: "character", targetId: "c1" },
      ]);
    });

    expect(putCalls.length).toBe(1);
    expect(putCalls[0].id).toBe("p1");
    // Payload = preserved mute + persona binding + new binding.
    expect(putCalls[0].rows).toEqual([
      { targetType: "character", targetId: "c2", mode: "disabled" },
      { targetType: "persona", targetId: "p1", mode: "voice" },
      { targetType: "character", targetId: "c1", mode: "voice" },
    ]);
    // Rule 2: links reloaded (second getLinks call) + voice-map refresh.
    expect(getLinksCalls).toEqual(["p1", "p1"]);
    expect(refreshVoiceMap).toHaveBeenCalledTimes(1);
    expect(captured.api?.error).toBeNull();
  });

  it("setMutedCharacters PUTs merged mute rows and refreshes the voice map", async () => {
    getLinksResponse = [link("persona", "p1", "voice"), link("character", "c1", "voice")];

    const { captured } = renderProbe("p1");
    await flush();

    await act(async () => {
      await captured.api?.setMutedCharacters(["c1"]);
    });

    expect(putCalls.length).toBe(1);
    expect(putCalls[0].rows).toEqual([
      { targetType: "persona", targetId: "p1", mode: "voice" },
      { targetType: "character", targetId: "c1", mode: "disabled" },
    ]);
    expect(refreshVoiceMap).toHaveBeenCalledTimes(1);
  });

  it("PUT failure → error set, links unchanged, voice map NOT refreshed", async () => {
    const initial = [link("character", "c1", "voice")];
    getLinksResponse = initial;
    putLinks.mockImplementation(async () => {
      throw new Error("network down");
    });

    const { captured } = renderProbe("p1");
    await flush();

    await act(async () => {
      await captured.api?.setMutedCharacters(["c1"]);
    });

    expect(captured.api?.error).toBe("network down");
    expect(captured.api?.links).toEqual(initial);
    expect(refreshVoiceMap).not.toHaveBeenCalled();
  });
});
