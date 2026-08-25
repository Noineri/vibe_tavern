import type { RegexRuntimeApi } from "../contract/runtime-api.js";
import type { StoreContainer } from "@vibe-tavern/db";
import type { CreateRegexPresetInput, CreateRegexProfileInput, UpdateRegexPresetInput, UpdateRegexProfileInput } from "@vibe-tavern/api-contracts";
import { applyTargetFlags } from "@vibe-tavern/domain";

export class RegexAdapter implements RegexRuntimeApi {
	constructor(private readonly stores: StoreContainer) {}

	listAllRegexPresets = () => this.stores.regex.listAll();

	getRegexPreset = (id: string) =>
		this.stores.regex.getById(id);

	createRegexPreset = (body: CreateRegexPresetInput) =>
		// Depth bounds are optional on the wire; absent = unlimited = store's null.
		this.stores.regex.create({
			...body,
			minDepth: body.minDepth ?? null,
			maxDepth: body.maxDepth ?? null,
		});

	/**
	 * `applyTarget` is the UI write-mode selector (RX-6); it expands via domain
	 * `applyTargetFlags` into the ST ephemerality flags. An explicit
	 * markdownOnly/promptOnly field in the SAME request wins over applyTarget
	 * for its slot; an absent applyTarget leaves the flag pair untouched.
	 */
	updateRegexPreset = async (id: string, body: UpdateRegexPresetInput) => {
		const { applyTarget, markdownOnly, promptOnly, ...rest } = body;
		if (applyTarget === undefined) {
			return this.stores.regex.update(id, { markdownOnly, promptOnly, ...rest });
		}
		const flags = applyTargetFlags(applyTarget);
		return this.stores.regex.update(id, {
			markdownOnly: markdownOnly ?? flags.markdownOnly,
			promptOnly: promptOnly ?? flags.promptOnly,
			...rest,
		});
	};

	deleteRegexPreset = async (id: string) => {
		await this.stores.regex.delete(id);
	};

	getRegexLinks = (id: string) =>
		this.stores.regex.getLinks(id);

	setRegexLinks = (id: string, links: Array<{ targetType: "character" | "preset"; targetId: string }>) =>
		this.stores.regex.setLinks(id, links);

	resolveActiveRegex = (query: { characterId?: string; presetId?: string }) =>
		this.stores.regex.resolveActiveRegexPresets({
			characterId: query.characterId ?? null,
			presetId: query.presetId ?? null,
		});

	// ─── R-13 profiles ────────────────────────────────────────────────────

	listAllRegexProfiles = () => this.stores.regex.listProfiles();

	getRegexProfile = (id: string) => this.stores.regex.getProfileById(id);

	createRegexProfile = (body: CreateRegexProfileInput) =>
		this.stores.regex.createProfile(body);

	updateRegexProfile = (id: string, body: UpdateRegexProfileInput) =>
		this.stores.regex.updateProfile(id, body);

	deleteRegexProfile = (id: string, mode: "keep" | "cascade") =>
		this.stores.regex.deleteProfile(id, mode);

	attachRegexRule = (profileId: string, ruleId: string) =>
		this.stores.regex.attachRule(profileId, ruleId);

	detachRegexRule = (ruleId: string) => this.stores.regex.detachRule(ruleId);

	getRegexProfileLinks = (id: string) => this.stores.regex.getProfileLinks(id);

	setRegexProfileLinks = (id: string, links: Array<{ targetType: "character" | "preset"; targetId: string }>) =>
		this.stores.regex.setProfileLinks(id, links);

	listRegexProfileMemberIds = (profileId: string) =>
		this.stores.regex.listProfileMemberIds(profileId);
}
