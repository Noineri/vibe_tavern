import { describe, expect, it, mock, afterEach } from "bun:test";

import type { GenerateImageGenInput, ImageGenGenerateResponseValue } from "@vibe-tavern/api-contracts";

// Real-module seam (the ImageGenPane.test family): api + chat-actions + sonner
// mocked with the `...real` spread — only what the run-orchestration path
// touches is overridden.
const realImageGenApi = await import("../api/image-gen-api.js");
const realChatActions = await import("./api-actions/chat-actions.js");
const realSonner = await import("sonner");

type GenerateCall = [string, GenerateImageGenInput, AbortSignal | undefined];

const generateCalls: GenerateCall[] = [];
const refreshCalls: string[] = [];
const toastErrors: string[] = [];

/** Parked generate double (the fetch-abort twin): resolves/rejects on demand
 *  and rejects with a DOMException AbortError when the caller aborts —
 *  exactly what a real aborted fetch does. */
function parkedGenerate(signal?: AbortSignal): {
  promise: Promise<ImageGenGenerateResponseValue>;
  resolve: () => void;
  reject(error: unknown): void;
} {
  let settle!: { resolve: () => void; reject(error: unknown): void };
  const promise = new Promise<ImageGenGenerateResponseValue>((res, rej) => {
    settle = {
      resolve: () => res(makeResponse()),
      reject: rej,
    };
  });
  if (signal !== undefined) {
    signal.addEventListener("abort", () => {
      settle.reject(new DOMException("The operation was aborted.", "AbortError"));
    });
  }
  return { promise, ...settle };
}

function makeResponse(): ImageGenGenerateResponseValue {
  return {
    messageId: "slot-1",
    mode: "portrait",
    profileId: "p1",
    attachments: [],
  };
}

mock.module("../api/image-gen-api.js", () => ({
  ...realImageGenApi,
  generateImageGen: (chatId: string, input: GenerateImageGenInput, signal?: AbortSignal) => {
    const parked = parkedGenerate(signal);
    generateCalls.push([chatId, input, signal]);
    pendingByChat.set(chatId, parked);
    return parked.promise;
  },
}));

mock.module("./api-actions/chat-actions.js", () => ({
  ...realChatActions,
  fetchChatAction: (chatId: { __brand?: string } | string) => {
    refreshCalls.push(String(chatId));
    return Promise.resolve();
  },
}));

mock.module("sonner", () => ({
  ...realSonner,
  toast: { ...realSonner.toast, error: (message: string) => toastErrors.push(message) },
}));

const pendingByChat = new Map<string, ReturnType<typeof parkedGenerate>>();

const { useImageGenChatStore } = await import("./image-gen-chat-store.js");

function input(mode: string, anchorMessageId = "m1"): GenerateImageGenInput {
  return { profileId: "p1", mode: mode as GenerateImageGenInput["mode"], anchorMessageId };
}

afterEach(() => {
  generateCalls.length = 0;
  refreshCalls.length = 0;
  toastErrors.length = 0;
  // The store is a module singleton shared across files in this worker —
  // leave every IG-17 draft map pristine for the next test/file.
  useImageGenChatStore.setState({ fineTuningDraftByChat: {} });
});

describe("image-gen chat store (IG-16)", () => {
  it("fires the client generate call with the chat, the payload, and the abort signal", async () => {
    const run = useImageGenChatStore.getState().runGeneration("chat-a", input("portrait"));
    await Promise.resolve(); // let the call start
    expect(generateCalls.length).toBe(1);
    const [chatId, body, signal] = generateCalls[0];
    expect(chatId).toBe("chat-a");
    expect(body.profileId).toBe("p1");
    expect(body.mode).toBe("portrait");
    expect(body.anchorMessageId).toBe("m1");
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
    expect(useImageGenChatStore.getState().runningByChat["chat-a"]).toEqual({
      mode: "portrait",
      anchorMessageId: "m1",
    });
    pendingByChat.get("chat-a")!.resolve();
    await run;
    expect(useImageGenChatStore.getState().runningByChat["chat-a"]).toBeUndefined();
  });

  it("success refreshes the chat through fetchChatAction", async () => {
    const run = useImageGenChatStore.getState().runGeneration("chat-b", input("character", "m2"));
    await Promise.resolve();
    pendingByChat.get("chat-b")!.resolve();
    await run;
    expect(refreshCalls.length).toBe(1);
  });

  it("guard: one in-flight generation per chat — a second start is a no-op", async () => {
    const first = useImageGenChatStore.getState().runGeneration("chat-c", input("portrait"));
    await Promise.resolve();
    void useImageGenChatStore.getState().runGeneration("chat-c", input("scene-background"));
    await Promise.resolve();
    expect(generateCalls.length).toBe(1);
    pendingByChat.get("chat-c")!.resolve();
    await first;
  });

  it("Stop aborts the controller — the run settles silently (no toast) and returns to idle", async () => {
    const run = useImageGenChatStore.getState().runGeneration("chat-d", input("portrait"));
    await Promise.resolve();
    const signal = generateCalls[0][2]!;
    useImageGenChatStore.getState().abortGeneration("chat-d");
    expect(signal.aborted).toBe(true);
    await run;
    expect(useImageGenChatStore.getState().runningByChat["chat-d"]).toBeUndefined();
    expect(toastErrors.length).toBe(0);
  });

  it("failure clears the run and toasts the normalized message; another chat's run is untouched", async () => {
    const failing = useImageGenChatStore.getState().runGeneration("chat-e", input("portrait"));
    const other = useImageGenChatStore.getState().runGeneration("chat-f", input("portrait"));
    await Promise.resolve();
    pendingByChat.get("chat-e")!.reject(new Error("Image-gen generate failed: 502 LLM assist failed: upstream"));
    await failing.catch(() => {});
    expect(toastErrors).toEqual(["Image-gen generate failed: 502 LLM assist failed: upstream"]);
    expect(useImageGenChatStore.getState().runningByChat["chat-e"]).toBeUndefined();
    // The other chat's run survives (per-chat isolation).
    expect(useImageGenChatStore.getState().runningByChat["chat-f"]).toBeDefined();
    pendingByChat.get("chat-f")!.resolve();
    await other;
  });

  it("fine-tuning + profile state is per-chat and independent", () => {
    useImageGenChatStore.getState().setFineTuning("chat-g", true);
    useImageGenChatStore.getState().setActiveProfile("chat-g", "p2");
    expect(useImageGenChatStore.getState().fineTuningByChat["chat-g"]).toBe(true);
    expect(useImageGenChatStore.getState().fineTuningByChat["chat-h"]).toBeUndefined();
    expect(useImageGenChatStore.getState().activeProfileIdByChat["chat-g"]).toBe("p2");
    expect(useImageGenChatStore.getState().activeProfileIdByChat["chat-h"]).toBeUndefined();
  });
});

describe("image-gen chat store — fine-tuning draft (IG-17)", () => {
  it("starts pristine; setFineTuningDraft patches from EMPTY and keeps the rest", () => {
    expect(useImageGenChatStore.getState().fineTuningDraftByChat["chat-i"]).toBeUndefined();
    useImageGenChatStore.getState().setFineTuningDraft("chat-i", { prompt: "a castle at dawn" });
    expect(useImageGenChatStore.getState().fineTuningDraftByChat["chat-i"]).toEqual({
      prompt: "a castle at dawn",
      negative: "",
    });
    // A second patch keeps the earlier fields (partial-update semantics).
    useImageGenChatStore.getState().setFineTuningDraft("chat-i", { sampler: "Euler a" });
    expect(useImageGenChatStore.getState().fineTuningDraftByChat["chat-i"]).toEqual({
      prompt: "a castle at dawn",
      negative: "",
      sampler: "Euler a",
    });
  });

  it("clearFineTuningDraft resets the chat to pristine (undefined)", () => {
    useImageGenChatStore.getState().setFineTuningDraft("chat-j", { prompt: "x", model: "m-1" });
    useImageGenChatStore.getState().clearFineTuningDraft("chat-j");
    expect(useImageGenChatStore.getState().fineTuningDraftByChat["chat-j"]).toBeUndefined();
  });

  it("drafts are isolated across chats", () => {
    useImageGenChatStore.getState().setFineTuningDraft("chat-k", { prompt: "one" });
    useImageGenChatStore.getState().setFineTuningDraft("chat-l", { negative: "blur" });
    expect(useImageGenChatStore.getState().fineTuningDraftByChat["chat-k"]?.prompt).toBe("one");
    expect(useImageGenChatStore.getState().fineTuningDraftByChat["chat-k"]?.negative).toBe("");
    expect(useImageGenChatStore.getState().fineTuningDraftByChat["chat-l"]?.prompt).toBe("");
    expect(useImageGenChatStore.getState().fineTuningDraftByChat["chat-l"]?.negative).toBe("blur");
  });
});
