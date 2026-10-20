/**
 * Bootstrap-state assembly — extracted from `SessionRuntime.getBootstrapState`
 * for the size ratchet (SIDECHAT_PLAN SC-0d touched the payload, and the
 * composition root was at its line budget). The payload SHAPE assembly lives
 * here; the coordinator stays the caller and supplies its runtime-owned seams
 * (chat order, snapshot builder, preset mapper) through
 * {@link BootstrapAssemblyDps}.
 */
import type { StoreContainer, Character, Chat, PromptPreset, UiSettings } from "@vibe-tavern/db";
import type { ChatId, PromptPresetDto } from "@vibe-tavern/domain";
import type { SessionSnapshot, BootstrapState } from "../../api/contract/session-types.js";
import { pickBootstrapChatId } from "./bootstrap-chat-picker.js";
import { listAgentKinds } from "../../domain/agent/agent-kind-registry.js";
import { toKindSettingsWire } from "../../api/adapters/experience-copilot-wire-mappers.js";

/** The runtime-owned seams the assembly needs (satisfied by SessionRuntime
 *  members — the coordinator remains the single caller). */
export interface BootstrapAssemblyDeps {
  stores: StoreContainer;
  /** Recency-desc chat order (`ChatOrderService.items`). */
  chatOrderItems: readonly ChatId[];
  getSnapshot: (chatId: ChatId) => Promise<SessionSnapshot>;
  mapPresetToDto: (preset: PromptPreset) => PromptPresetDto;
}

/** Assemble the app bootstrap payload (the `GET /api/bootstrap` response):
 *  initial chat (F-7 — the most-recent NON-coauthor chat so a reload never
 *  drops the user into the co-author surface), its snapshot, first-run flag,
 *  character/preset lists, ui_settings, and the per-kind agent-settings map
 *  (SC-0d — every REGISTERED kind's effective pair, so each shell finds its
 *  remembered model in the one bootstrap round-trip). */
export async function buildBootstrapState(deps: BootstrapAssemblyDeps): Promise<BootstrapState> {
  const { stores, chatOrderItems, getSnapshot, mapPresetToDto } = deps;
  const [userChars, allChats, promptPresets, uiSettings] = await Promise.all([
    stores.characters.listAll(),
    stores.chats.listAll(),
    stores.presets.listAll(),
    stores.uiSettings.get(),
  ]);
  // Boot into the most-recent NON-coauthor chat so a reload never drops the
  // user into the co-author surface (F-7). Falls back to the overall
  // most-recent chat only when no RP chat exists at all.
  const coauthorIds = new Set(allChats.filter((c) => c.mode === 'coauthor').map((c) => c.id));
  const initialChatId = pickBootstrapChatId(chatOrderItems, (id) => coauthorIds.has(id));
  const isArmServer = process.arch.startsWith('arm') && process.platform !== 'darwin';
  // SC-0d: every REGISTERED kind's effective settings — the kind's own row
  // or, for a kind that inherits it (SC-7: only the two pre-split kinds; the
  // descriptor field is the one source of that fact), the legacy
  // ui_settings copilot pair (the store's read-time fallback), keyed by
  // kind id so each shell finds its remembered model in the one bootstrap
  // round-trip. SC-7b: each entry also carries the kind's served chat modes
  // (from the descriptor — never stored), mapped through the SAME row→wire
  // mapper the settings routes use, so the bootstrap map is the wire shape
  // from one source, not a structural twin of the db row.
  const agentKindSettings: BootstrapState['agentKindSettings'] = Object.fromEntries(
    await Promise.all(
      listAgentKinds().map(async (kind) => [
        kind.id,
        toKindSettingsWire(
          await stores.agentKindSettings.get(kind.id, { inheritLegacyPair: kind.inheritsLegacyCopilotPair }),
          kind.servesChatModes,
        ),
      ]),
    ),
  );
  return {
    initialChatId,
    snapshot: initialChatId ? await getSnapshot(initialChatId) : null,
    isFirstRun: allChats.length === 0 && userChars.length === 0,
    allCharacters: userChars.map((c) => ({
      id: c.id,
      name: c.name,
      subtitle: c.tags.length > 0 ? c.tags[0] : '',
      tags: c.tags,
      avatarAssetId: c.avatarAssetId,
      avatarFullAssetId: c.avatarFullAssetId,
      avatarCropJson: c.avatarCropJson,
      avatarExt: c.avatarExt,
      avatarFullExt: c.avatarFullExt,
      updatedAt: c.updatedAt,
    })),
    promptPresets: promptPresets.map((p) => mapPresetToDto(p)),
    uiSettings,
    agentKindSettings,
    isArmServer,
  };
}
