import { create } from "zustand";

/**
 * The sidechat's pending RP-variant attachments (SIDECHAT_PLAN, Wave 5 /
 * SC-18) — the chips the «Discuss in the sidechat» RP-message entry parks
 * between the RP message and the sidechat's composer.
 *
 * Keyed by chat + branch (NOT per thread): the entry lives in MessageShell
 * (which knows chat + branch, never the sidechat thread), and SC-17's freeze
 * validates ownership server-side anyway. The sidechat host's
 * `buildSendOptions` reads the CURRENT chat+branch list and maps it to
 * `attachedVariants`; the host's `onSendSettled` clears it on success and
 * keeps it on failure (the user retries with the same chips).
 */

/** One pending chip: an (messageId, variantId) pair plus its display facts. */
export interface PendingVariantAttachment {
  /** The RP message the variant belongs to. */
  messageId: string;
  /** The immutable `message_variants.id`. */
  variantId: string;
  /** N = the variant number the RP shows (`variantIndex + 1`). */
  variantNumber: number;
  /** True when this variant is the RP's selected one (chip copy only — the
   *  wire pair carries NO selected marker, the schema rejects it). */
  selected: boolean;
}

/** The single spelling of the per-chat+branch map key. */
export function variantAttachmentsKey(chatId: string, branchId: string): string {
  return `${chatId}\n${branchId}`;
}

interface SidechatVariantAttachmentsState {
  /** Pending chips per chat+branch (sparse — absent means none). */
  pendingByChatBranch: Record<string, PendingVariantAttachment[]>;
  /** Parks chips (exact-duplicate pairs are skipped, order preserved). */
  attachVariants: (chatId: string, branchId: string, chips: readonly PendingVariantAttachment[]) => void;
  /** Removes one chip (the per-chip ×). */
  removeVariantAttachment: (chatId: string, branchId: string, messageId: string, variantId: string) => void;
  /** Drops every pending chip (a successful send). */
  clearVariantAttachments: (chatId: string, branchId: string) => void;
}

export const useSidechatVariantAttachmentsStore = create<SidechatVariantAttachmentsState>((set) => ({
  pendingByChatBranch: {},
  attachVariants: (chatId, branchId, chips) => {
    if (chips.length === 0) return;
    const key = variantAttachmentsKey(chatId, branchId);
    set((s) => {
      const prev = s.pendingByChatBranch[key] ?? [];
      const seen = new Set(prev.map((chip) => `${chip.messageId}\n${chip.variantId}`));
      const next = [...prev];
      for (const chip of chips) {
        const chipKey = `${chip.messageId}\n${chip.variantId}`;
        if (seen.has(chipKey)) continue;
        seen.add(chipKey);
        next.push(chip);
      }
      if (next.length === prev.length) return s;
      return { pendingByChatBranch: { ...s.pendingByChatBranch, [key]: next } };
    });
  },
  removeVariantAttachment: (chatId, branchId, messageId, variantId) => {
    const key = variantAttachmentsKey(chatId, branchId);
    set((s) => {
      const prev = s.pendingByChatBranch[key];
      if (prev === undefined) return s;
      const next = prev.filter((chip) => !(chip.messageId === messageId && chip.variantId === variantId));
      if (next.length === prev.length) return s;
      const pendingByChatBranch = { ...s.pendingByChatBranch };
      if (next.length === 0) delete pendingByChatBranch[key];
      else pendingByChatBranch[key] = next;
      return { pendingByChatBranch };
    });
  },
  clearVariantAttachments: (chatId, branchId) => {
    const key = variantAttachmentsKey(chatId, branchId);
    set((s) => {
      if (s.pendingByChatBranch[key] === undefined) return s;
      const pendingByChatBranch = { ...s.pendingByChatBranch };
      delete pendingByChatBranch[key];
      return { pendingByChatBranch };
    });
  },
}));

/** Pure read of one chat+branch pending list outside React (buildSendOptions). */
export function readPendingVariantAttachments(chatId: string, branchId: string): PendingVariantAttachment[] {
  return (
    useSidechatVariantAttachmentsStore.getState().pendingByChatBranch[variantAttachmentsKey(chatId, branchId)] ??
    []
  );
}

/** Stable empty list — the selector below must return a referentially stable
 *  value when absent (a fresh `[]` per call re-renders forever). */
const EMPTY_PENDING: PendingVariantAttachment[] = [];

/** One chat+branch pending list inside React (the composer's chips row). */
export function usePendingVariantAttachments(chatId: string, branchId: string): PendingVariantAttachment[] {
  return useSidechatVariantAttachmentsStore(
    (s) => s.pendingByChatBranch[variantAttachmentsKey(chatId, branchId)] ?? EMPTY_PENDING,
  );
}

// Debug helper — mirrors the window.__ exposure pattern used by the other
// ephemeral stores. Lets a live Playwright / dev-console session inspect the
// pending chips to diagnose "variants not attached" reports.
if (typeof window !== "undefined") {
  (window as unknown as { __useSidechatVariantAttachmentsStore?: unknown }).__useSidechatVariantAttachmentsStore =
    useSidechatVariantAttachmentsStore;
}
