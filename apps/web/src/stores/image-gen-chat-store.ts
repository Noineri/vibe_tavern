/**
 * Image-gen chat UI state (IMAGE_GENERATION_PLAN IG-16): the per-chat
 * "Fine tuning" toggle + the in-flight generation tracking that powers the
 * message-action Stop control. Plain zustand — UI state only, never canonical
 * data (the dictation-store precedent); profile POINTERs are chat-local
 * choices here, not server-side ui_settings.
 *
 * `activeProfileIdByChat` is the per-chat image-gen profile choice IG-2
 * deliberately kept out of the DB (no is_default column — the "active"
 * profile is a chat-level consumer concern). IG-17's fine-tuning chip reads
 * and writes the same map.
 *
 * One in-flight generation per chat (v1): starting a second while one runs
 * is prevented by the UI (the trigger morphs into Stop) and guarded here.
 * The AbortControllers live in a module-level map, NOT in zustand state —
 * controllers are imperative handles, not renderable state.
 *
 * IG-17: `fineTuningDraftByChat` is the chip's editable draft (positive /
 * negative prompt, model + sampler picks) — per chat, UI-only, lives while
 * the toggle is on; the message popover folds it into the next generate
 * payload (prompt verbatim, picks → overrides).
 */

import { create } from "zustand";
import { toast } from "sonner";

import { brandId, type ChatId, type ImageGenerationMode } from "@vibe-tavern/domain";
import { generateImageGen, interruptImageGenProfile } from "../api/image-gen-api.js";
import { fetchChatAction } from "./api-actions/chat-actions.js";
import type { GenerateImageGenInput, ImageGenGenerateOverridesValue } from "@vibe-tavern/api-contracts";

/** What the UI needs about a running generation (renderable projection —
 *  the AbortController stays in the module map below). `profileId` powers
 *  the PG-2 progress poll; `liveProgress` is the profile's capability
 *  snapshot at START time — the abort path and the progress row gate on it
 *  (a profile switch mid-run must not change what the in-flight run can
 *  do). */
export interface ImageGenRunState {
  mode: string;
  anchorMessageId: string;
  profileId: string;
  /** True when the run's profile was local-with-live-progress (A1111
   *  dialect in v1) — Stop then ALSO interrupts the server-side job. */
  liveProgress: boolean;
}

/** PG-2 run metadata supplied by the STARTER (it holds the effective
 *  profile record with its capabilities). */
export interface ImageGenRunMeta {
  liveProgress: boolean;
}

/** One enabled LoRA in the chip's draft (CG-C3) — the web-side twin of
 *  the generate contract's `overrides.loras` entries: name verbatim + ONE
 *  strength (FT-A5 single slider — feeds both strength_model and
 *  strength_clip on ComfyUI; `<lora:name:strength>` tags on A1111/FT-A4).
 *  Structurally the contract entry, so the fold assigns it as-is. */
export interface ImageGenLoraPick {
  name: string;
  strength: number;
}

/** The IG-17 chip's per-chat draft — every field optional/empty-able; empty
 *  means "not sent" (the generate contract's fallback semantics). The
 *  profile pick is NOT here: it lives in `activeProfileIdByChat` (IG-16),
 *  shared by the popover and the chip. */
export interface ImageGenFineTuningDraft {
  /** Positive prompt — verbatim (the IG-14 contract): non-free modes use it
   *  as the resolved prompt; free REQUIRES it. "" = server builds. */
  prompt: string;
  /** Negative prompt — sent only when non-empty AND the profile's
   *  capabilities allow negatives (the IG-13 gate, enforced at the call
   *  site). */
  negative: string;
  /** Per-chat model pick → overrides.model. undefined = the profile's
   *  selected model. */
  model?: string;
  /** Generation target (FT-A2) — the mode the chip's Generate button fires
   *  (FT-A3) and the resolution-preselect anchor. undefined = the cockpit's
   *  Free display default (committed on first change; six registry modes,
   *  no new names). */
  target?: ImageGenerationMode;
  /** Picked resolution (FT-A2) → overrides.width/height — a CF14 bucket or
   *  a custom pair. Both undefined = Auto (the profile's per-mode size
   *  preset resolves server-side). */
  width?: number;
  height?: number;
  /** UI-only (FT-A2): the Custom size mode is EXPLICIT — a custom pair that
   *  happens to equal a bucket must stay in stepper mode, not snap back to
   *  the bucket entry. Cleared by any bucket/Auto pick; never rides the
   *  wire. */
  customSize?: boolean;
  /** Enabled LoRAs (CG-C3) → overrides.loras at the fold — capability-gated
   *  (supportsLoras). undefined/empty = none sent. Entry ORDER = chain
   *  order on ComfyUI (LoraLoader nodes chain in list sequence). */
  loras?: ImageGenLoraPick[];
}

/** A pristine draft (shared empty instance — never mutated; setters copy). */
export const EMPTY_IMAGE_GEN_DRAFT: ImageGenFineTuningDraft = { prompt: "", negative: "" };

/** The profile shape the draft fold needs (satisfied by ImageGenProfileRecord
 *  and test rows alike). */
export interface DraftFoldProfile {
  id: string;
  capabilities: { supportsNegativePrompt: boolean; supportsLoras?: boolean };
}

/** THE draft→generate fold (FT-A3): ONE implementation shared by the message
 *  menu (mode = the clicked row) and the chip's Generate button (mode = the
 *  draft target, tail message anchor). Positive prompt VERBATIM when
 *  non-empty (the IG-14 contract — never re-templated server-side); the
 *  picks as overrides with the same empty-means-not-sent semantics and the
 *  IG-13/CG-C3 capability gates (negative, loras). Returns null when no
 *  effective profile exists (the caller's early-return twin). */
export function buildDraftGenerateInput(args: {
  readonly draft: ImageGenFineTuningDraft;
  readonly effective: DraftFoldProfile | null;
  readonly mode: ImageGenerationMode;
  readonly anchorMessageId?: string;
  readonly foldDraft: boolean;
}): GenerateImageGenInput | null {
  if (args.effective === null) return null;
  const input: GenerateImageGenInput = { profileId: args.effective.id, mode: args.mode };
  if (args.anchorMessageId !== undefined) input.anchorMessageId = args.anchorMessageId;
  if (!args.foldDraft) return input;
  const { draft } = args;
  const prompt = draft.prompt.trim();
  if (prompt !== "") input.prompt = prompt;
  const overrides: ImageGenGenerateOverridesValue = {};
  const negative = draft.negative.trim();
  if (negative !== "" && args.effective.capabilities.supportsNegativePrompt) {
    overrides.negativePrompt = negative;
  }
  if (draft.model !== undefined && draft.model !== "") overrides.model = draft.model;
  // FT-A2: the resolution pick rides the run — partial pairs are legal (the
  // contract falls back per side).
  if (draft.width !== undefined) overrides.width = draft.width;
  if (draft.height !== undefined) overrides.height = draft.height;
  // CG-C3: enabled loras ride the run — capability-gated exactly like the
  // negative (a profile without supportsLoras never sees them). Entry order
  // = ComfyUI chain order; strength verbatim from the chip.
  if (draft.loras !== undefined && draft.loras.length > 0 && args.effective.capabilities.supportsLoras === true) {
    overrides.loras = draft.loras;
  }
  if (Object.keys(overrides).length > 0) input.overrides = overrides;
  return input;
}

/** MR-5: the EFFECTIVE image-gen profile record for a chat — the fallback
 *  chain «chat pick → global active → server default → first row» (the
 *  ProviderModal `activeProviderProfileId ?? providerProfiles[0]?.id` twin,
 *  with the per-chat chip pick as the override layer on top). Pure: both
 *  callers (chip + message menu) and tests share the ONE chain.
 *  MR-12: the third arm — the list's `isDefault` row (the server-persisted
 *  pointer, the TTS/STT twin). It is the chain's HYDRATION: after a reload
 *  the session pointer is null and the server flag alone answers "who is
 *  active"; `first row` stays the dead-battery fallback (no profile ever
 *  activated). Optional in T so pre-MR-12 test rows keep compiling. */
export function resolveEffectiveImageGenProfile<T extends { id: string; isDefault?: boolean }>(
  profiles: T[] | null | undefined,
  chatPick: string | null | undefined,
  globalActive: string | null,
): T | null {
  const list = profiles ?? [];
  const byPick = chatPick != null ? list.find((p) => p.id === chatPick) : undefined;
  if (byPick !== undefined) return byPick;
  const byGlobal = globalActive !== null ? list.find((p) => p.id === globalActive) : undefined;
  if (byGlobal !== undefined) return byGlobal;
  const byDefault = list.find((p) => p.isDefault === true);
  if (byDefault !== undefined) return byDefault;
  return list[0] ?? null;
}

interface ImageGenChatState {
  /** Per-chat "Fine tuning" toggle (default off — the IG-16 gate). */
  fineTuningByChat: Record<string, boolean>;
  /** Per-chat image-gen profile choice — the OVERRIDE on top of the global
   *  active (undefined = inherit the global). */
  activeProfileIdByChat: Record<string, string | undefined>;
  /** MR-5: the GLOBAL active image-gen profile (the owner's "who receives
   *  the next generation" answer when no chat-level pick exists — the
   *  text providers' activeProviderProfileId twin, set from the profile
   *  view card's make-active button). Null until the first activation. */
  activeImageGenProfileId: string | null;
  /** ChatId → in-flight run; undefined = idle. */
  runningByChat: Record<string, ImageGenRunState | undefined>;
  /** IG-17 chip drafts, per chat; undefined = pristine (EMPTY_IMAGE_GEN_DRAFT). */
  fineTuningDraftByChat: Record<string, ImageGenFineTuningDraft | undefined>;
}

interface ImageGenChatActions {
  setFineTuning(chatId: string, on: boolean): void;
  setActiveProfile(chatId: string, profileId: string | undefined): void;
  /** MR-5/MR-12: set the GLOBAL active image-gen profile — the SESSION
   *  flip only. The persisting path is the pane hook's `activateProfile`
   *  (server PUT → reload → this flip); keeping the raw setter lets the
   *  hook flip without re-implementing the store write. */
  setActiveImageGenProfile(profileId: string): void;
  /** Fire ONE generation (guarded one-per-chat); resolves when the run
   *  settles. User-aborts are silent; failures toast the normalized server
   *  message; success refreshes the chat through fetchChatAction. `meta`
   *  carries the START-side capability snapshot (PG-2). */
  runGeneration(chatId: string, input: GenerateImageGenInput, meta?: ImageGenRunMeta): Promise<void>;
  /** Abort the chat's in-flight generation (the Stop control). The pending
   *  runGeneration settles silently via its AbortError path. For a
   * live-progress run this ALSO asks the local instance to cancel its
   * server-side job (PG-2, fire-and-forget). */
  abortGeneration(chatId: string): void;
  /** Patch the chat's fine-tuning draft (creates it from EMPTY on first
   *  touch). */
  setFineTuningDraft(chatId: string, patch: Partial<ImageGenFineTuningDraft>): void;
  /** Toggle one lora in the chat's draft (CG-C3): enable appends
   *  `{name, strength: 1}` at the chain's END; disable removes the entry
   *  (an emptied array stays `[]` — the fold sends nothing for it). */
  setFineTuningLoraEnabled(chatId: string, name: string, enabled: boolean): void;
  /** Update one enabled lora's strength in place (no-op when the lora is
   *  not enabled — the slider only renders for enabled rows). */
  setFineTuningLoraStrength(chatId: string, name: string, strength: number): void;
  /** Reset the chat's draft to pristine (the chip's Clear). */
  clearFineTuningDraft(chatId: string): void;
}

export type ImageGenChatStore = ImageGenChatState & ImageGenChatActions;

/** Imperative abort handles, keyed by chatId (kept OUT of zustand state). */
const controllers = new Map<string, AbortController>();

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export const useImageGenChatStore = create<ImageGenChatStore>()((set, get) => ({
  fineTuningByChat: {},
  activeProfileIdByChat: {},
  activeImageGenProfileId: null,
  runningByChat: {},
  fineTuningDraftByChat: {},

  setFineTuning: (chatId, on) => {
    set((s) => ({ fineTuningByChat: { ...s.fineTuningByChat, [chatId]: on } }));
  },

  setActiveProfile: (chatId, profileId) => {
    set((s) => ({ activeProfileIdByChat: { ...s.activeProfileIdByChat, [chatId]: profileId } }));
  },

  setActiveImageGenProfile: (profileId) => {
    set({ activeImageGenProfileId: profileId });
  },

  runGeneration: async (chatId, input, meta) => {
    if (get().runningByChat[chatId] !== undefined || controllers.has(chatId)) return;
    const controller = new AbortController();
    controllers.set(chatId, controller);
    set((s) => ({
      runningByChat: {
        ...s.runningByChat,
        [chatId]: {
          mode: input.mode,
          anchorMessageId: input.anchorMessageId ?? "",
          profileId: input.profileId,
          liveProgress: meta?.liveProgress ?? false,
        },
      },
    }));
    try {
      await generateImageGen(chatId, input, controller.signal);
      // Still the current run (not aborted-and-restarted mid-flight).
      if (controllers.get(chatId) === controller) {
        controllers.delete(chatId);
        set((s) => {
          const next = { ...s.runningByChat };
          delete next[chatId];
          return { runningByChat: next };
        });
        // The server already appended the image slot — pull the fresh
        // snapshot through the standard chat refresh path.
        try {
          await fetchChatAction(brandId<ChatId>(chatId));
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Chat refresh failed");
        }
      }
    } catch (err) {
      if (controllers.get(chatId) === controller) {
        controllers.delete(chatId);
        set((s) => {
          const next = { ...s.runningByChat };
          delete next[chatId];
          return { runningByChat: next };
        });
        // User cancel is silent by design (the owner's explicit Stop — the
        // route maps it to a silent abort, not an error).
        if (!isAbortError(err)) {
          toast.error(err instanceof Error ? err.message : "Image generation failed");
        }
      }
    }
  },

  abortGeneration: (chatId) => {
    // PG-2: a live-progress run cancels its server-side job too — the
    // transport abort below is client-side only. Fire-and-forget: a dead
    // interrupt (server already done, instance down) must not surface over
    // the silent-cancel contract.
    const run = get().runningByChat[chatId];
    if (run?.liveProgress) {
      void interruptImageGenProfile(run.profileId).catch(() => {});
    }
    controllers.get(chatId)?.abort();
  },

  setFineTuningDraft: (chatId, patch) => {
    set((s) => ({
      fineTuningDraftByChat: {
        ...s.fineTuningDraftByChat,
        [chatId]: { ...(s.fineTuningDraftByChat[chatId] ?? EMPTY_IMAGE_GEN_DRAFT), ...patch },
      },
    }));
  },

  setFineTuningLoraEnabled: (chatId, name, enabled) => {
    set((s) => {
      const current = s.fineTuningDraftByChat[chatId] ?? EMPTY_IMAGE_GEN_DRAFT;
      const picks = current.loras ?? [];
      const next = enabled
        ? [...picks, { name, strength: 1 }]
        : picks.filter((p) => p.name !== name);
      return {
        fineTuningDraftByChat: {
          ...s.fineTuningDraftByChat,
          [chatId]: { ...current, loras: next },
        },
      };
    });
  },

  setFineTuningLoraStrength: (chatId, name, strength) => {
    set((s) => {
      const current = s.fineTuningDraftByChat[chatId] ?? EMPTY_IMAGE_GEN_DRAFT;
      const picks = current.loras ?? [];
      if (!picks.some((p) => p.name === name)) return {};
      return {
        fineTuningDraftByChat: {
          ...s.fineTuningDraftByChat,
          [chatId]: {
            ...current,
            loras: picks.map((p) => (p.name === name ? { ...p, strength } : p)),
          },
        },
      };
    });
  },

  clearFineTuningDraft: (chatId) => {
    set((s) => {
      const next = { ...s.fineTuningDraftByChat };
      delete next[chatId];
      return { fineTuningDraftByChat: next };
    });
  },
}));

if (typeof window !== "undefined") {
  (window as { __useImageGenChatStore?: typeof useImageGenChatStore }).__useImageGenChatStore =
    useImageGenChatStore;
}
