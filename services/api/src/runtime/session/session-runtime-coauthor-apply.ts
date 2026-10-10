/**
 * Co-Author Apply RPC implementation (CA-7 / CTX-L2 / CT-7a).
 *
 * Extracted verbatim from `SessionRuntime.applyCoauthorDraft`
 * (session-runtime.ts) during CT-7a — that file sits on the arch-gate size
 * ratchet and the tracker-template Apply branch (CT-7a) needed headroom; the
 * gate's only remedy is extraction, so the whole cohesive Apply body moved
 * here instead of the file growing. Behavior-neutral: same logic, same order,
 * same comments; the runtime keeps a thin delegating method so the public
 * surface (adapters, routes, tests) is unchanged. Sibling of the other
 * session-runtime-*.ts extractions (lore-delegate, chat-lifecycle, ...).
 *
 * Apply does NOT touch chat messages — it parses the proposed `profile.md`
 * into the canonical character fields and persists them via the normal
 * character-update dual-write, then returns a config-patch snapshot. All
 * proposal surfaces merge in the SAME `character.update` call:
 * profile fields, greetings, the frontmatter `extensions` keys (creator /
 * character_version), and the tracker template (CT-7a, via `withTrackerTemplate`
 * over `updateInput.extensions ?? current.extensions`). Lore bundles persist
 * through `LorebookStore.applyCoauthorLoreDraft` after the character update.
 */
import { parseProfileMd, type StoreContainer } from "@vibe-tavern/db";
import { normalizeTrackerTemplate, withTrackerTemplate, type CharacterId, type ChatId } from "@vibe-tavern/domain";
import type { CoauthorApplyRequest, CoauthorCorrection } from "@vibe-tavern/api-contracts";
import type { CoauthorApplyResponse } from "../../api/contract/session-types.js";
import { notFound, unprocessable } from "../../shared/errors.js";
import { findUnsafeMacros } from "../../domain/coauthor/macro-subset.js";
import type { CharacterRuntime } from "../../domain/character/character-runtime.js";

/** The SessionRuntime seams the Apply path needs (stores + the character
 *  runtime's dual-write + the post-update chat-order rebuild). */
export interface CoauthorApplyDeps {
	stores: StoreContainer;
	character: CharacterRuntime;
	rebuildChatOrder: () => Promise<void>;
}

/**
 * Apply a co-author turn's aggregated proposed state to the underlying
 * character card (CA-7).
 *
 * R3 (data-loss guard): an empty `name` is restored from the current card
 * rather than throwing — the omission is surfaced to the user via a
 * `correction` so it is not silently masked. Section/greeting emptiness is
 * intentional-or-loss and is handled upstream (tool guard CA-17) or on the
 * diff (CA-10), not here.
 */
export async function applyCoauthorDraft(
	deps: CoauthorApplyDeps,
	chatId: ChatId,
	body: CoauthorApplyRequest,
): Promise<CoauthorApplyResponse> {
	const chat = await deps.stores.chats.getById(chatId);
	if (!chat) {
		throw notFound("Chat", `Chat '${chatId}' was not found.`);
	}
	const characterId = chat.characterId as CharacterId;

	const corrections: CoauthorCorrection[] = [];
	const updateInput: Parameters<CharacterRuntime["update"]>[1] = { chatId };

	if (body.profileMd !== undefined) {
		const { profile } = parseProfileMd(body.profileMd);
		const current = await deps.stores.characters.getById(characterId);
		// R3: empty name → omit (character.update keeps current) + notify user.
		const proposedName = profile.name.trim();
		if (proposedName) {
			updateInput.name = proposedName;
		} else {
			corrections.push({
				field: "name",
				action: "restored",
				reason: `Model returned an empty name; restored "${current?.name ?? ""}" from the card.`,
			});
		}
		updateInput.tags = profile.tags;
		updateInput.creatorNotes = profile.creatorNotes;
		updateInput.description = profile.description;
		updateInput.scenario = profile.scenario ?? "";
		updateInput.mesExample = profile.mesExample;
		updateInput.mesExampleMode = profile.mesExampleMode;
		updateInput.mesExampleDepth = profile.mesExampleDepth;
		// Lossless frontmatter round-trip: creator / character_version live in
		// `extensions` (not top-level update fields). Merge over current so a
		// model edit to either is honored; omitting would preserve current.
		const baseExtensions = (current?.extensions ?? {}) as Record<string, unknown>;
		updateInput.extensions = {
			...baseExtensions,
			...(profile.creator !== null ? { creator: profile.creator } : {}),
			...(profile.characterVersion !== null ? { character_version: profile.characterVersion } : {}),
		};
	}

	if (body.firstMessage !== undefined) {
		updateInput.firstMessage = body.firstMessage;
	}
	if (body.alternateGreetings !== undefined) {
		updateInput.alternateGreetings = body.alternateGreetings;
	}

	// CT-7a: tracker-template Apply branch. The template rides
	// `extensions` through the CT-1 helper in the SAME character.update call
	// as the profile merge above (whose extensions edit — creator /
	// character_version — already sits in `updateInput.extensions`). A
	// template-only Apply (no `profileMd`) reads the character's current
	// `extensions` itself, and `character.update` still runs. Absent field =
	// the template is left untouched; every other `extensions` key survives
	// the merge.
	if (body.trackerTemplate !== undefined) {
		const current = updateInput.extensions === undefined
			? await deps.stores.characters.getById(characterId)
			: null;
		const baseExtensions = (updateInput.extensions ?? current?.extensions ?? {}) as Record<string, unknown>;
		// The wire schema keeps `version` numeric (transport boundary); domain
		// normalization is the one authority for supported versions — the same
		// bridge the CT-3 tracker-template PUT route applies. The aggregate only
		// forwards tool-normalized (version 1) templates, so this guard fires
		// only on a hand-crafted payload; it never silently drops the edit.
		const template = normalizeTrackerTemplate(body.trackerTemplate);
		if (template === null) {
			throw unprocessable("The tracker template is invalid.", { code: "invalid_tracker_template" });
		}
		updateInput.extensions = withTrackerTemplate(baseExtensions, template);
	}

	// B5: flag macros the model emitted outside the safe reusable subset
	// (identity + pronouns). The prose is preserved as-is — these are warnings,
	// not silent edits; the user decides whether to keep each token. One
	// correction per (field, distinct macro) so the toast names exactly what
	// to review and where.
	const proseFields: Array<[string, string | string[] | null | undefined]> = [
		["name", updateInput.name],
		["description", updateInput.description],
		["scenario", updateInput.scenario],
		["mesExample", updateInput.mesExample],
		["creatorNotes", updateInput.creatorNotes],
		["firstMessage", updateInput.firstMessage],
		["alternateGreetings", updateInput.alternateGreetings],
	];
	for (const [field, value] of proseFields) {
		if (value === null || value === undefined) continue;
		const texts = Array.isArray(value) ? value : [value];
		const unsafe = new Set<string>();
		for (const text of texts) {
			for (const name of findUnsafeMacros(text)) unsafe.add(name);
		}
		for (const name of unsafe) {
			corrections.push({
				field,
				action: "warned",
				reason: `Model used {{${name}}}, which is outside the reusable macro set ({{user}}, {{char}}, pronouns) and may not resolve as intended; left as-is for review.`,
			});
		}
	}

	const patch = await deps.character.update(characterId, updateInput, {
		rebuildChatOrder: deps.rebuildChatOrder,
	});

	// CTX-L2 (Wave 4): lore-bundle Apply branch. The accepted cumulative draft
	// is persisted idempotently (preallocated ids upsert the same rows) in one
	// transaction. Character-scoped draft books are written with characterId so
	// the activation engine discovers them. Absent/empty bundle = no-op (the
	// common profile/greeting-only Apply path is unchanged).
	let lore: { lorebookIds: string[]; entryIds: string[] } | undefined;
	if (body.loreBundle && (body.loreBundle.lorebooks.length > 0 || body.loreBundle.entries.length > 0)) {
		lore = await deps.stores.lorebooks.applyCoauthorLoreDraft(
			characterId as unknown as string,
			body.loreBundle,
		);
	}

	return { ...patch, corrections, ...(lore ? { lore } : {}) };
}
