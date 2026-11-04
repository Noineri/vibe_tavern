import { z } from "zod";

/**
 * Agent-thread frozen-event wire (SIDECHAT_PLAN Wave 5 / SC-19a) — the
 * response item of `GET /api/agent/threads/:threadId/events`: one frozen
 * context event of a chat-owned thread, in merged-timeline order, anchored
 * for the web's separator placement (SC-19b interleaves each event before
 * the message row the anchor names; `null` means the event is the newest
 * row — it renders after everything).
 *
 * The wire mirrors what the SERVER's one mapper (`mapTimelineEvent`,
 * services/api/src/domain/sidechat/sidechat-context.ts — the same parser
 * the context loader and the compaction service run) produces for a stored
 * event row: the four stored kinds with their frozen payload shapes
 * (SC-1/SC-2c). The schema is a DESCRIPTION of that output, never a second
 * parser — nothing on the response path validates through it.
 *
 * Payload mirrors, verbatim from the frozen sources:
 * - `rp_sync` / `selection_changed` → `RpSyncPayload` / `SelectionChangedPayload`
 *   (domain/sidechat/rp-sync.ts); the message `role` is the four-value chat
 *   role set the loader's parser enforces (anything else is refused, not
 *   widened here). Since SC-23a the messages and the selection pairs carry
 *   `model` / `preset` (nullable) — the loader NORMALIZES absent to null, so
 *   the wire always carries the keys.
 * - `variants_attached` / `branch_forked` → `VariantsAttachedPayload` /
 *   `BranchForkedPayload` (domain/sidechat/sidechat-xml.ts); each variant
 *   also carries `number` / `model` / `preset` (nullable, same normalization).
 *
 * `rp_summary` is NOT here on purpose: summaries are never stored as
 * events (SC-6 renders them live from coverage), so no stored row maps to
 * that kind — the events route can never emit it.
 *
 * The five payload schemas below are exported since AFP-7
 * (AGENT_FEED_PERFORMANCE_PLAN Wave 2): `agent-feed-schema.ts` reuses their
 * element schemas for the paged frozen-detail responses — ONE derivation of
 * every frozen shape, never a second parser.
 */

/** `rp_sync` payload wire — mirrors `RpSyncPayload` (domain/sidechat/rp-sync.ts). */
export const rpSyncPayloadSchema = z.object({
  fromPosition: z.number(),
  toPosition: z.number(),
  messages: z.array(
    z.object({
      id: z.string(),
      position: z.number(),
      role: z.enum(["system", "user", "assistant", "tool"]),
      authorName: z.string().nullable(),
      variantId: z.string().nullable(),
      model: z.string().nullable(),
      preset: z.string().nullable(),
      text: z.string(),
    }),
  ),
});

/** `variants_attached` payload wire — mirrors `VariantsAttachedPayload`
 * (domain/sidechat/sidechat-xml.ts), readonly modifiers included. */
export const variantsAttachedPayloadSchema = z
  .object({
    position: z.number(),
    variants: z.array(
      z
        .object({
          text: z.string(),
          selected: z.boolean(),
          number: z.number().nullable(),
          model: z.string().nullable(),
          preset: z.string().nullable(),
        })
        .readonly(),
    ).readonly(),
  })
  .readonly();

/** One selected-variant pair — mirrors `RpVariantSelection`
 * (domain/sidechat/rp-sync.ts). */
const variantSelectionSchema = z.object({
  variantId: z.string(),
  text: z.string(),
  model: z.string().nullable(),
  preset: z.string().nullable(),
});

/** `selection_changed` payload wire — mirrors `SelectionChangedPayload`
 * (domain/sidechat/rp-sync.ts). */
export const selectionChangedPayloadSchema = z.object({
  messageId: z.string(),
  position: z.number(),
  previous: variantSelectionSchema,
  current: variantSelectionSchema,
});

/** `branch_forked` payload wire — mirrors `BranchForkedPayload`
 * (domain/sidechat/sidechat-xml.ts), readonly modifiers included. */
export const branchForkedPayloadSchema = z.object({
  at: z.number(),
}).readonly();

/** `profile_changed` payload wire — mirrors `ProfileChangedPayload`
 * (domain/sidechat/sidechat-profile-change.ts). The from/to profile ids plus
 * the display names frozen at WRITE time (server seed names for built-ins —
 * the WEB localizes built-in ids through its own name derivation and falls
 * back to the frozen name for user profiles, exactly like the profile chip).
 * DR-12: user-feed provenance only — the context loader and the compaction
 * service skip this kind; only the events route serves it. */
export const profileChangedPayloadSchema = z
  .object({
    from: z.object({ id: z.string(), name: z.string() }).readonly(),
    to: z.object({ id: z.string(), name: z.string() }).readonly(),
  })
  .readonly();

/**
 * One frozen event on the events route's response: the event row's id and
 * kind, its payload as the loader's own mapper produces it, and the
 * `beforeMessageId` anchor — the FIRST message row after the event on the
 * merged timeline (`listTimeline`'s order), `null` when no message follows
 * (the event is the newest row).
 */
export const agentThreadEventSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string(),
    kind: z.literal("rp_sync"),
    payload: rpSyncPayloadSchema,
    beforeMessageId: z.string().nullable(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("variants_attached"),
    payload: variantsAttachedPayloadSchema,
    beforeMessageId: z.string().nullable(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("selection_changed"),
    payload: selectionChangedPayloadSchema,
    beforeMessageId: z.string().nullable(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("branch_forked"),
    payload: branchForkedPayloadSchema,
    beforeMessageId: z.string().nullable(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("profile_changed"),
    payload: profileChangedPayloadSchema,
    beforeMessageId: z.string().nullable(),
  }),
]);
export type AgentThreadEventWire = z.infer<typeof agentThreadEventSchema>;
