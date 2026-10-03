/**
 * Co-Author LORE tools (CTX-L1 Wave 4, CTX-L2b, CE-B1) — the lore half of the
 * co-author tool set, split out of `domain/chat/coauthor-tools.ts` (which keeps
 * the profile / greeting / context-search tools and remains the public tool-set
 * entry, re-exporting this module's seams). The split exists so the lore tool
 * surface can grow without re-growing that file: it sits on the arch-gate
 * ratchet baseline and may only shrink.
 *
 * Everything here is PROPOSAL-ONLY, exactly as before the split: the tools
 * allocate stable draft IDs and mutate ONLY the turn-local {@link LoreDraftState}
 * (closure state, one instance per assembled tool set) — no `LorebookStore`, no
 * SQLite. Apply (`SessionRuntime.applyCoauthorDraft`, CTX-L2) is the sole
 * persistence boundary; every successful call returns the COMPLETE cumulative
 * lore bundle so aggregation keeps the whole graph.
 *
 * `buildLoreTools` is called by `buildCoauthorTools`, which spreads the result
 * into the tool set between the greeting tools and the context-search tools.
 * The deps mirror the injection seams `buildCoauthorTools` receives
 * (`loreIdGen`, `loreDelegate`, `loreEntityLookup`) plus a getter for the live
 * working profile (delegations ground on the in-flux character card).
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  type CoauthorDraftLoreEntry,
  type CoauthorDraftLorebook,
  type CoauthorLoreBundleOutput,
} from "@vibe-tavern/api-contracts";
import { log, LORE_LOGIC } from "@vibe-tavern/domain";
import {
  defaultLoreDraftIdGen,
  type EditLoreEntryInput,
  type EditLorebookInput,
  LoreDraftState,
  type LoreDraftIdGen,
  type LoreDraftScopeType,
} from "./lore-draft-state.js";
import type { LoreDelegate, LoreDelegateInput } from "./lore-delegate.js";

/**
 * CE-B1: loads a persisted lore entity's current state as a draft-compatible
 * node, so the edit tools can import it into the turn draft before patching.
 * Injected by the runtime (constructed from `LorebookStore`); OPTIONAL — when
 * absent, edit / re-delegation tools still work for ids drafted earlier in the
 * SAME turn (no cross-turn edit of persisted entities). Mirrors the
 * `loreDelegate` injection seam. Returns null when the id does not exist.
 */
export interface LoreEntityLookup {
  lorebook(id: string): Promise<CoauthorDraftLorebook | null>;
  entry(id: string): Promise<CoauthorDraftLoreEntry | null>;
}

/** CA-17/CANARY: structured log for every co-author tool call — same
 * `coauthor.tool` tag as `coauthor-tools.ts`, so lore tool I/O lands in the
 * same observability stream (errors feed back to the model as tool-results via
 * the stepCountIs loop and never reach the server logger without this). Set
 * LOG_LEVEL=debug to see the full proposed body. */
const logger = log.tag("coauthor.tool");

/** Injection seams the lore tools need from the assembling co-author turn. */
export interface LoreToolsDeps {
  /** Draft-id generator (`buildCoauthorTools`'s `loreIdGen` opt). */
  idGen?: LoreDraftIdGen;
  /** CTX-L2b: optional one-shot LLM delegate for content / key generation. */
  loreDelegate?: LoreDelegate;
  /** CE-B1: optional lookup that loads a persisted lore entity's current state
   *  as a draft node, so the edit / re-delegation tools can target entities
   *  created in earlier turns. */
  loreEntityLookup?: LoreEntityLookup;
  /** Live working profile.md of the character being authored (may include this
   *  turn's un-committed profile edits — grounds the delegate on the up-to-date
   *  character). Passed as a getter because the working profile is mutable
   *  closure state owned by `buildCoauthorTools`. */
  getWorkingProfileMd: () => string | undefined;
}

/**
 * Build the lore tool set half. Pure — no I/O, no store access; each tool
 * validates and mutates the turn-local draft only. Key order is part of the
 * wire shape (the tool block is serialized to the model in object order), so
 * the returned object lists the tools in the exact order `coauthor-tools.ts`
 * spread them before the split.
 */
export function buildLoreTools(deps: LoreToolsDeps): ToolSet {
  const { loreDelegate, loreEntityLookup } = deps;

  // ── Turn-local lore draft state (CTX-L1, Wave 4) ──────────────────────────
  // Proposal-only: allocates stable draft IDs and mutates closure state only —
  // NO LorebookStore, NO SQLite. Apply (CTEX-L2) is the sole persistence
  // boundary; Cancel drops this instance. The engine self-serializes its own
  // mutations through a separate non-poisoning queue (independent of the
  // profile queue), validates parent lorebook refs, and returns the complete
  // cumulative bundle from every successful call.
  const loreDraft = new LoreDraftState({ idGen: deps.idGen ?? defaultLoreDraftIdGen() });

  /** Gather the delegation context for a drafted entry (entry + parent lorebook). */
  function buildLoreDelegateInput(
    kind: "write_entry" | "generate_keys",
    entryId: string,
    instruction: string,
    toolName: string,
    opts?: { keyTarget?: "primary" | "secondary" | "both" },
  ): LoreDelegateInput {
    const snap = loreDraft.snapshot();
    const entry = snap.entries.find((e) => e.id === entryId);
    if (!entry) {
      throw new Error(`${toolName}: entry '${entryId}' does not exist in the draft`);
    }
    const lorebook = snap.lorebooks.find((lb) => lb.id === entry.lorebookId);
    return {
      kind,
      characterProfileMd: deps.getWorkingProfileMd() ?? "",
      lorebookName: lorebook?.name ?? "",
      lorebookDescription: lorebook?.description ?? "",
      entryId: entry.id,
      entryTitle: entry.title,
      entryContent: entry.content,
      entryKeys: entry.keys,
      entrySecondaryKeys: entry.secondaryKeys,
      instruction,
      // generate_keys params (ignored for write_entry). CE-A2: logic now
      // flows from the draft entry (settable via create_lore_entry); default and_any.
      keyTarget: opts?.keyTarget ?? "both",
      logic: entry.logic ?? LORE_LOGIC.andAny,
    };
  }

  /**
   * CE-B1: ensure a lorebook is in the turn draft, importing it from the DB if
   * it is a persisted entity not yet drafted this turn. A no-op when the id is
   * already drafted. Throws when the id is neither drafted nor found via the
   * lookup (or when no lookup is configured for a non-draft id).
   */
  async function ensureLorebookInDraft(id: string, toolName: string): Promise<void> {
    if (loreDraft.hasLorebook(id)) return;
    if (!loreEntityLookup) {
      throw new Error(
        `${toolName}: lorebook '${id}' is not in this turn's draft and no entity lookup is configured (cannot edit a persisted lorebook)`,
      );
    }
    const current = await loreEntityLookup.lorebook(id);
    if (!current) {
      throw new Error(`${toolName}: lorebook '${id}' does not exist`);
    }
    await loreDraft.importLorebook(current);
  }

  /**
   * CE-B1: ensure an entry is in the turn draft (import from DB if persisted).
   * Used by the edit tools AND the re-delegation tools
   * (ai_write_lore_entry / ai_generate_lore_keys) so they accept ANY entry id —
   * drafted this turn or persisted — without each call repeating the import.
   */
  async function ensureEntryInDraft(id: string, toolName: string): Promise<void> {
    if (loreDraft.hasEntry(id)) return;
    if (!loreEntityLookup) {
      throw new Error(
        `${toolName}: entry '${id}' is not in this turn's draft and no entity lookup is configured (cannot edit a persisted entry)`,
      );
    }
    const current = await loreEntityLookup.entry(id);
    if (!current) {
      throw new Error(`${toolName}: entry '${id}' does not exist`);
    }
    await loreDraft.importEntry(current);
  }

  return {
    // ── Wave 4: proposal-only lore tools (CTX-L1) ────────────────────────────
    // These allocate stable draft IDs and mutate ONLY the turn-local
    // LoreDraftState; they never touch LorebookStore / SQLite. Each returns the
    // complete cumulative lore bundle so aggregation keeps the whole graph. The
    // AI-delegation tools (ai_write_lore_entry / ai_generate_lore_keys) land in
    // CTX-L2 alongside the Apply transaction.
    create_lorebook: tool({
      description:
        "Propose creating a NEW lorebook (world-info book) for the character. Returns the complete cumulative lore draft (all books + entries proposed this turn). The book is shown for review before applying — nothing is persisted until Apply.",
      inputSchema: z.object({
        name: z.string().describe("The lorebook's display name, e.g. 'World Lore' or 'Castle Anvil'."),
        description: z.string().optional().describe("A short description of what this lorebook covers."),
        scopeType: z
          .enum(["global", "entity", "chat"])
          .optional()
          .describe("Where this lorebook is scoped. 'entity' (default) attaches it to the current character."),
        enabled: z.boolean().optional().describe("Whether the lorebook is active. Defaults to true."),
        scanDepth: z.number().int().optional().describe("Activation: how many recent messages to scan for key matches. Default 10."),
        tokenBudget: z.number().int().optional().describe("Activation: max tokens this lorebook may inject per turn. Default 1000."),
        recursiveScanning: z.boolean().optional().describe("Activation: whether a key match can recurse into matched entries' keys. Default false."),
        summary: z.string().max(200).describe("One-line description of this lorebook, shown above the Apply button."),
      }),
      execute: async ({ name, description, scopeType, enabled, scanDepth, tokenBudget, recursiveScanning, summary }): Promise<CoauthorLoreBundleOutput> => {
        logger.info("create_lorebook IN name=%j scopeType=%s scanDepth=%s tokenBudget=%s recursive=%s summary=%s", name, scopeType ?? "(default)", scanDepth ?? "(default)", tokenBudget ?? "(default)", recursiveScanning ?? "(default)", summary);
        const bundle = await loreDraft.createLorebook({ name, description, scopeType: scopeType as LoreDraftScopeType | undefined, enabled, scanDepth, tokenBudget, recursiveScanning });
        return { target: "lore_bundle", bundle, summary };
      },
    }),

    create_lore_entry: tool({
      description:
        "Propose adding a NEW entry SKELETON to a lorebook drafted this turn. `lorebookId` MUST be the id of a lorebook returned by an earlier create_lorebook in this turn. This creates the entry with a title + activation params ONLY — it does NOT set content or keys. After creating the skeleton: delegate CONTENT via ai_write_lore_entry, then delegate KEYS via ai_generate_lore_keys. Returns the complete cumulative lore draft.",
      inputSchema: z.object({
        lorebookId: z.string().describe("The id of the parent lorebook (from a create_lorebook result this turn)."),
        title: z.string().optional().describe("A short title for the entry (organizational; not an activation trigger)."),
        constant: z.boolean().optional().describe("If true the entry activates every turn regardless of key match. Defaults to false."),
        position: z.string().optional().describe("Where the entry injects (e.g. 'before_char'). Defaults to 'before_char'."),
        depth: z.number().int().optional().describe("Injection depth for depth-aware positions. Defaults to 4."),
        logic: z.enum([LORE_LOGIC.andAny, LORE_LOGIC.andAll, LORE_LOGIC.notAny, LORE_LOGIC.notAll] as const).optional().describe("How keys combine for activation. 'and_any' (default) = at least one key matches; 'and_all' = all must match; 'not_any' = none may match; 'not_all' = not all match."),
        summary: z.string().max(200).describe("One-line description of this entry, shown above the Apply button."),
      }),
      execute: async ({ lorebookId, title, constant, position, depth, logic, summary }): Promise<CoauthorLoreBundleOutput> => {
        logger.info("create_lore_entry IN lorebookId=%s title=%j logic=%s summary=%s", lorebookId, title, logic ?? "(default)", summary);
        const bundle = await loreDraft.createLoreEntry({ lorebookId, title, constant, position, depth, logic });
        return { target: "lore_bundle", bundle, summary };
      },
    }),

    set_lore_activation: tool({
      description:
        "Adjust activation fields on a lore entry drafted this turn (e.g. make it constant so it always injects, or disable it). `entryId` MUST be the id of an entry returned earlier this turn. Returns the complete cumulative lore draft.",
      inputSchema: z.object({
        entryId: z.string().describe("The id of the entry to adjust (from an earlier create_lore_entry result this turn)."),
        constant: z.boolean().optional().describe("If true the entry activates every turn regardless of key match."),
        enabled: z.boolean().optional().describe("Whether the entry is active at all."),
        summary: z.string().max(200).describe("One-line description of this activation change, shown above the Apply button."),
      }),
      execute: async ({ entryId, constant, enabled, summary }): Promise<CoauthorLoreBundleOutput> => {
        logger.info("set_lore_activation IN entryId=%s constant=%s enabled=%s summary=%s", entryId, constant, enabled, summary);
        const bundle = await loreDraft.setLoreActivation({ entryId, constant, enabled });
        return { target: "lore_bundle", bundle, summary };
      },
    }),

    // ── CE-B1: edit tools for authored entities (turn-drafted OR persisted) ───
    // These target a stable id that may be a node drafted earlier this turn OR
    // a previously-created (persisted) co-author entity. For persisted ids the
    // tool imports the entity's current state into the draft (via the injected
    // LoreEntityLookup) before patching, so Apply's existing upsert UPDATEs the
    // real row. The draft node is badged mode:"edit" for the review UI. Keys /
    // content stay delegate-only — edit_lore_entry changes title + activation
    // params + logic, NOT keys/content.
    edit_lorebook: tool({
      description:
        "Propose editing an EXISTING lorebook — rename it, change its description, or adjust its activation params (scanDepth / tokenBudget / recursiveScanning / scope / enabled). The lorebook can be one drafted earlier this turn OR a previously-created (persisted) one, referenced by its id. Only the fields you supply are changed. Returns the complete cumulative lore draft.",
      inputSchema: z.object({
        lorebookId: z.string().describe("The id of the lorebook to edit — a create_lorebook id from this turn, or a persisted lorebook id."),
        name: z.string().optional().describe("New display name for the lorebook."),
        description: z.string().optional().describe("New short description."),
        scopeType: z.enum(["global", "entity", "chat"]).optional().describe("New scope.",),
        enabled: z.boolean().optional().describe("Whether the lorebook is active."),
        scanDepth: z.number().int().optional().describe("Activation: how many recent messages to scan for key matches."),
        tokenBudget: z.number().int().optional().describe("Activation: max tokens this lorebook may inject per turn."),
        recursiveScanning: z.boolean().optional().describe("Activation: whether a key match can recurse into matched entries' keys."),
        summary: z.string().max(200).describe("One-line description of this edit, shown above the Apply button."),
      }),
      execute: async ({ lorebookId, name, description, scopeType, enabled, scanDepth, tokenBudget, recursiveScanning, summary }): Promise<CoauthorLoreBundleOutput> => {
        logger.info("edit_lorebook IN id=%s summary=%s", lorebookId, summary);
        await ensureLorebookInDraft(lorebookId, "edit_lorebook");
        const patch: EditLorebookInput = { id: lorebookId };
        if (name !== undefined) patch.name = name;
        if (description !== undefined) patch.description = description;
        if (scopeType !== undefined) patch.scopeType = scopeType as LoreDraftScopeType;
        if (enabled !== undefined) patch.enabled = enabled;
        if (scanDepth !== undefined) patch.scanDepth = scanDepth;
        if (tokenBudget !== undefined) patch.tokenBudget = tokenBudget;
        if (recursiveScanning !== undefined) patch.recursiveScanning = recursiveScanning;
        const bundle = await loreDraft.editLorebook(patch);
        return { target: "lore_bundle", bundle, summary };
      },
    }),

    edit_lore_entry: tool({
      description:
        "Propose editing an EXISTING lore entry's title or activation params (constant / position / depth / logic / enabled). The entry can be one drafted earlier this turn OR a previously-created (persisted) one, referenced by its id. Only the fields you supply are changed. This does NOT change content or keys — delegate those with ai_write_lore_entry / ai_generate_lore_keys. Returns the complete cumulative lore draft.",
      inputSchema: z.object({
        entryId: z.string().describe("The id of the entry to edit — a create_lore_entry id from this turn, or a persisted entry id."),
        title: z.string().optional().describe("New organizational title (not an activation trigger)."),
        constant: z.boolean().optional().describe("If true the entry activates every turn regardless of key match."),
        position: z.string().optional().describe("Where the entry injects (e.g. 'before_char')."),
        depth: z.number().int().optional().describe("Injection depth for depth-aware positions."),
        logic: z.enum([LORE_LOGIC.andAny, LORE_LOGIC.andAll, LORE_LOGIC.notAny, LORE_LOGIC.notAll] as const).optional().describe("How keys combine for activation: 'and_any' = at least one matches; 'and_all' = all match; 'not_any' = none may match; 'not_all' = not all match."),
        enabled: z.boolean().optional().describe("Whether the entry is active."),
        summary: z.string().max(200).describe("One-line description of this edit, shown above the Apply button."),
      }),
      execute: async ({ entryId, title, constant, position, depth, logic, enabled, summary }): Promise<CoauthorLoreBundleOutput> => {
        logger.info("edit_lore_entry IN id=%s logic=%s summary=%s", entryId, logic ?? "(unchanged)", summary);
        await ensureEntryInDraft(entryId, "edit_lore_entry");
        const patch: EditLoreEntryInput = { id: entryId };
        if (title !== undefined) patch.title = title;
        if (constant !== undefined) patch.constant = constant;
        if (position !== undefined) patch.position = position;
        if (depth !== undefined) patch.depth = depth;
        if (logic !== undefined) patch.logic = logic;
        if (enabled !== undefined) patch.enabled = enabled;
        const bundle = await loreDraft.editLoreEntry(patch);
        return { target: "lore_bundle", bundle, summary };
      },
    }),

    add_lore_entry: tool({
      description:
        "Propose adding a NEW entry skeleton to an EXISTING lorebook — one drafted this turn OR a previously-created (persisted) one. Use this (not create_lore_entry) when the lorebook already exists. It creates a title + activation params skeleton ONLY; delegate CONTENT via ai_write_lore_entry and KEYS via ai_generate_lore_keys afterward. Returns the complete cumulative lore draft.",
      inputSchema: z.object({
        lorebookId: z.string().describe("The id of an EXISTING lorebook (drafted this turn or persisted) to add the entry to."),
        title: z.string().optional().describe("A short title for the entry (organizational; not an activation trigger)."),
        constant: z.boolean().optional().describe("If true the entry activates every turn regardless of key match. Defaults to false."),
        position: z.string().optional().describe("Where the entry injects (e.g. 'before_char'). Defaults to 'before_char'."),
        depth: z.number().int().optional().describe("Injection depth for depth-aware positions. Defaults to 4."),
        logic: z.enum([LORE_LOGIC.andAny, LORE_LOGIC.andAll, LORE_LOGIC.notAny, LORE_LOGIC.notAll] as const).optional().describe("How keys combine for activation. 'and_any' (default) = at least one matches."),
        summary: z.string().max(200).describe("One-line description of this entry, shown above the Apply button."),
      }),
      execute: async ({ lorebookId, title, constant, position, depth, logic, summary }): Promise<CoauthorLoreBundleOutput> => {
        logger.info("add_lore_entry IN lorebookId=%s title=%j summary=%s", lorebookId, title, summary);
        // Validate the parent exists: if not in the draft, confirm via the
        // lookup. The parent is NOT imported (it would badge as an edit and a
        // no-op Apply could rewrite ownership); instead the new entry carries
        // parentMode:"persisted" so review/selection accept the external parent.
        let parentMode: "persisted" | undefined;
        if (!loreDraft.hasLorebook(lorebookId)) {
          if (!loreEntityLookup) {
            throw new Error(
              `add_lore_entry: lorebook '${lorebookId}' is not in this turn's draft and no entity lookup is configured`,
            );
          }
          const exists = await loreEntityLookup.lorebook(lorebookId);
          if (!exists) {
            throw new Error(`add_lore_entry: lorebook '${lorebookId}' does not exist`);
          }
          parentMode = "persisted";
        }
        const bundle = await loreDraft.addLoreEntry({ lorebookId, title, constant, position, depth, logic, parentMode });
        return { target: "lore_bundle", bundle, summary };
      },
    }),

    // ── Wave 4: AI-delegation lore tools (CTX-L2b) ───────────────────────────
    // These delegate content / key generation to the AI-assistant via an
    // isolated one-shot LLM call (a focused, separate model authors the prose
    // / proposes keys) — IDE-style. Like the other lore tools they mutate ONLY
    // the turn-local draft; Apply is the sole persistence boundary. The
    // delegate reuses the standalone assistant's lore system-prompt assets and
    // grounds on the live working profile of the character being authored.
    ai_write_lore_entry: tool({
      description:
        "Delegate WRITING the content body of a lore entry to the AI-assistant (a separate, focused generation call — a smaller model authors dense worldbuilding prose). Use this for an entry drafted this turn OR a persisted entry whose stable `entryId` is shown beside its title in Bound lorebooks awareness. Never pass a display title as `entryId`. " +
        "CRITICAL: the AI-assistant sees ONLY the character card + this entry's lorebook + your `instruction` — it does NOT see this conversation. So `instruction` must be a COMPLETE, self-contained authoring brief: translate the user's request (however vague) into a precise generation directive — the subject to cover, the specific facts/angles/sensory detail to include, and any tone or length guidance. Do NOT write 'as we discussed' or 'the thing the user mentioned' — spell out everything the assistant needs to author the entry in isolation. The generated content updates the draft entry for review. Returns the complete cumulative lore draft.",
      inputSchema: z.object({
        entryId: z.string().describe("Stable entry id: from a create_lore_entry result this turn, or the [entryId: ...] shown beside a persisted bound entry's title. Never use the display title."),
        instruction: z.string().describe("A COMPLETE, self-contained authoring brief for the AI-assistant (which sees ONLY the character card + this instruction, not the conversation). State the subject, the specifics/facts/angles to cover, and any tone. Expand the user's request into a precise directive — e.g. 'Write the backstory for why {{char}} fears the word X: the originating incident, the sensory trigger, how the fear manifests. Eerie tone, 2-3 paragraphs.'"),
        summary: z.string().max(200).describe("One-line description of this delegation, shown above the Apply button."),
      }),
      execute: async ({ entryId, instruction, summary }): Promise<CoauthorLoreBundleOutput> => {
        if (!loreDelegate) {
          throw new Error("ai_write_lore_entry: no provider is configured for AI delegation");
        }
        // CE-B1: accept ANY entry id — import a persisted entry into the draft
        // before delegating, so re-writing content works across turns.
        await ensureEntryInDraft(entryId, "ai_write_lore_entry");
        logger.info("ai_write_lore_entry IN entryId=%s instructionLen=%d summary=%s", entryId, instruction.length, summary);
        const input = buildLoreDelegateInput("write_entry", entryId, instruction, "ai_write_lore_entry");
        const result = await loreDelegate(input);
        const content = result.content ?? "";
        const bundle = await loreDraft.setLoreEntryContent({ entryId, content });
        logger.info("ai_write_lore_entry OK entryId=%s contentLen=%d", entryId, content.length);
        return { target: "lore_bundle", bundle, summary };
      },
    }),

    ai_generate_lore_keys: tool({
      description:
        "Delegate GENERATING activation keys for a lore entry to the AI-assistant (a separate, focused generation call analyzes the entry and proposes conversational trigger keywords), exactly as the manual key-generation quickpill does. Use this for an entry drafted this turn OR a persisted entry whose stable `entryId` is shown beside its title in Bound lorebooks awareness. Never pass a display title as `entryId`. Control WHICH key set to generate with `keyTarget`, and HOW the generated keys combine with the entry's existing keys with `appendMode` (false = REPLACE the targeted set(s); true = AUGMENT — append only newly-generated keys, deduped). The non-targeted key set is always left untouched. Returns the complete cumulative lore draft.",
      inputSchema: z.object({
        entryId: z.string().describe("Stable entry id: from a create_lore_entry result this turn, or the [entryId: ...] shown beside a persisted bound entry's title. Never use the display title."),
        keyTarget: z
          .enum(["primary", "secondary", "both"])
          .optional()
          .describe("Which key set to generate: 'primary' (activation triggers only), 'secondary' (additional signal only), or 'both' (default). The non-targeted set is left untouched."),
        appendMode: z
          .boolean()
          .optional()
          .describe("How to combine generated keys with the entry's existing ones. false (default) = REPLACE the targeted set(s); true = AUGMENT (append only newly-generated keys, deduped against existing)."),
        summary: z.string().max(200).describe("One-line description of this delegation, shown above the Apply button."),
      }),
      execute: async ({ entryId, keyTarget, appendMode, summary }): Promise<CoauthorLoreBundleOutput> => {
        if (!loreDelegate) {
          throw new Error("ai_generate_lore_keys: no provider is configured for AI delegation");
        }
        // CE-B1: accept ANY entry id — import a persisted entry before
        // delegating, so regenerating keys works across turns. Its existing
        // keys (loaded from the DB) seed the merge below.
        await ensureEntryInDraft(entryId, "ai_generate_lore_keys");
        const target = keyTarget ?? "both";
        const augment = appendMode ?? false;
        logger.info("ai_generate_lore_keys IN entryId=%s target=%s augment=%s summary=%s", entryId, target, augment, summary);
        const input = buildLoreDelegateInput("generate_keys", entryId, "", "ai_generate_lore_keys", { keyTarget: target });
        const result = await loreDelegate(input);
        // Merge the generated keys with the entry's existing ones, mirroring the
        // manual lore_keys quickpill (lore-keys-ai-pill.tsx): gate by target,
        // then replace the targeted set(s) or augment (append, deduped). The
        // non-targeted set is always left untouched.
        const snap = loreDraft.snapshot();
        const entry = snap.entries.find((e) => e.id === entryId);
        const existingKeys = entry ? [...entry.keys] : [];
        const existingSec = entry ? [...entry.secondaryKeys] : [];
        const wantPrimary = target !== "secondary";
        const wantSecondary = target !== "primary";
        const genKeys = result.keys ?? [];
        const genSec = result.secondaryKeys ?? [];
        let nextKeys = existingKeys;
        let nextSec = existingSec;
        if (augment) {
          if (wantPrimary) nextKeys = [...existingKeys, ...genKeys.filter((k) => !existingKeys.includes(k))];
          if (wantSecondary) nextSec = [...existingSec, ...genSec.filter((k) => !existingSec.includes(k))];
        } else {
          if (wantPrimary && genKeys.length) nextKeys = genKeys;
          if (wantSecondary && genSec.length) nextSec = genSec;
        }
        const bundle = await loreDraft.setLoreEntryKeys({ entryId, keys: nextKeys, secondaryKeys: nextSec });
        logger.info("ai_generate_lore_keys OK entryId=%s keys=%d secondary=%d (target=%s augment=%s)", entryId, nextKeys.length, nextSec.length, target, augment);
        return { target: "lore_bundle", bundle, summary };
      },
    }),
  };
}
