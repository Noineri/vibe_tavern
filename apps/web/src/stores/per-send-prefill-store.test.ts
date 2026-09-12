/**
 * Per-send prefill store (LS-4b) — one-shot semantics.
 *
 * WHAT THIS PROVES
 *   - `consume()` is a one-shot read: the armed value is returned exactly once
 *     and the store clears itself — a send can never observe the same
 *     override twice (the "applies to the NEXT reply, then clears" contract).
 *   - Consuming when nothing is armed returns null and leaves the store null.
 *   - Setting an empty string disarms (no blank-prefill sends).
 *   - The store NEVER reads or writes the prompt preset — the preset value
 *     stays the persistent default by construction (this store holds only the
 *     one-shot override; the pin is the absence of any preset touchpoint).
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { usePerSendPrefillStore } from "./per-send-prefill-store.js";

beforeEach(() => {
  usePerSendPrefillStore.getState().clear();
});

describe("per-send prefill store — one-shot semantics", () => {
  test("consume returns the armed value and clears it (one send only)", () => {
    usePerSendPrefillStore.getState().setValue("Whisper softly:");
    expect(usePerSendPrefillStore.getState().value).toBe("Whisper softly:");

    expect(usePerSendPrefillStore.getState().consume()).toBe("Whisper softly:");
    expect(usePerSendPrefillStore.getState().value).toBeNull();
    // Second consume: nothing armed.
    expect(usePerSendPrefillStore.getState().consume()).toBeNull();
  });

  test("consume with nothing armed returns null and stays null", () => {
    expect(usePerSendPrefillStore.getState().consume()).toBeNull();
    expect(usePerSendPrefillStore.getState().value).toBeNull();
  });

  test("setting an empty value disarms", () => {
    usePerSendPrefillStore.getState().setValue("armed");
    usePerSendPrefillStore.getState().setValue("");
    expect(usePerSendPrefillStore.getState().value).toBeNull();
  });

  test("clear disarms without consuming", () => {
    usePerSendPrefillStore.getState().setValue("armed");
    usePerSendPrefillStore.getState().clear();
    expect(usePerSendPrefillStore.getState().consume()).toBeNull();
  });
});
