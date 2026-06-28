import type { PersonaRuntimeApi } from "../contract/runtime-api.js";
import { brandId, type PersonaId, type ChatId } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import type { SessionRuntime } from "../../runtime/session/session-runtime.js";
import type { AssetService } from "../../domain/asset/asset-service.js";
import type { ProviderProfileService } from "../../domain/providers/provider-profile-service.js";
import { validation, notFound } from "../../shared/errors.js";
import { describeAttachments, resolveVisionDescribePrompt } from "../../infrastructure/ai/vision-gate.js";
import { serializePersona, buildStPersonaSlice, buildVtPersonaPayload, mergeStSlices } from "../../domain/persona/persona-export.js";
import { personaExportVtSchema, stPersonaBackupSchema } from "@vibe-tavern/api-contracts";
import { z } from "zod";

export class PersonaAdapter implements PersonaRuntimeApi {
	constructor(
		private readonly sessionRuntime: SessionRuntime,
		private readonly stores: StoreContainer,
		private readonly assetService: AssetService,
		private readonly providerProfileService: ProviderProfileService,
	) {}

	listPersonas = () => this.sessionRuntime.persona.list();

	createPersona = (body: {
		name: string;
		description: string;
		pronouns?: string | null;
		defaultForNewChats?: boolean;
	}) => this.sessionRuntime.persona.create(body);

	updatePersona = async (
		personaId: string,
		body: {
			chatId?: string;
			name?: string;
			description?: string;
			pronouns?: string | null;
			avatarAssetId?: string | null;
			avatarFullAssetId?: string | null;
			avatarCropJson?: string | null;
			includeAvatarInPrompt?: boolean;
			avatarDescription?: string | null;
		},
	) => {
		if (body.avatarAssetId !== undefined) {
			const persona = await this.stores.personas.getById(personaId);
			// Folder-resident avatar (avatarExt set) is handled by the folder
			// lifecycle — skip flat cleanup.
			if (!persona?.avatarExt && persona?.avatarAssetId && persona.avatarAssetId !== body.avatarAssetId) {
				this.assetService.cleanup(persona.avatarAssetId);
			}
		}
		return this.sessionRuntime.persona.update(
			personaId,
			{ ...body, chatId: body.chatId != null ? brandId<ChatId>(body.chatId) : undefined },
		);
	};

	deletePersona = async (personaId: string) => {
		const persona = await this.stores.personas.getById(personaId);
		// Folder-resident avatar (avatarExt) is removed by the store's
		// deleteEntityFolder; only legacy flat avatars need explicit cleanup.
		if (!persona?.avatarExt && persona?.avatarAssetId) {
			this.assetService.cleanup(persona.avatarAssetId);
		}
		await this.sessionRuntime.persona.delete(personaId);
	};

	duplicatePersona = (personaId: string) =>
		this.sessionRuntime.persona.duplicate(personaId);

	setDefaultPersona = (personaId: string) =>
		this.sessionRuntime.persona.setDefault(personaId);

	uploadPersonaAvatar = async (personaId: string, crop: File, full?: File): Promise<{ avatarExt: string; avatarFullExt: string | null }> => {
		const { ext } = await this.assetService.writePersonaAvatar(personaId, crop);
		await this.stores.personas.setFolderAvatar(personaId, ext);
		let avatarFullExt: string | null = null;
		if (full) {
			const f = await this.assetService.writePersonaAvatarFull(personaId, full);
			await this.stores.personas.setFolderAvatarFull(personaId, f.ext);
			avatarFullExt = f.ext;
		}
		return { avatarExt: ext, avatarFullExt };
	};

	servePersonaAvatar = async (personaId: string): Promise<Response | null> => {
		const persona = await this.stores.personas.getById(personaId);
		if (!persona) return null;
		if (persona.avatarExt) {
			return this.assetService.servePersonaAvatar(personaId, persona.avatarExt);
		}
		if (persona.avatarAssetId) {
			return this.assetService.serve(persona.avatarAssetId);
		}
		return null;
	};

	servePersonaAvatarFull = async (personaId: string): Promise<Response | null> => {
		const persona = await this.stores.personas.getById(personaId);
		if (!persona) return null;
		if (persona.avatarFullExt) {
			return this.assetService.servePersonaAvatarFull(personaId, persona.avatarFullExt);
		}
		if (persona.avatarExt) {
			return this.assetService.servePersonaAvatar(personaId, persona.avatarExt);
		}
		if (persona.avatarAssetId) {
			return this.assetService.serve(persona.avatarAssetId);
		}
		return null;
	};

	// ─── Vision describe (A6) ───────────────────────────────────────────
	// Mirrors CharacterAdapter.describeCharacterAvatar (same profile/prompt
	// resolution as chat attachment describe). Persists to `avatarDescription`.

	describePersonaAvatar = async (personaId: string): Promise<{ description: string }> => {
		const persona = await this.stores.personas.getById(personaId);
		if (!persona) throw validation("Persona not found.");
		if (!persona.avatarExt) {
			throw validation("Persona has no avatar.");
		}
		const buffer = await this.assetService.loadPersonaAvatarBuffer(personaId, persona.avatarExt);
		const mimeType = this.assetService.mimeForExt(persona.avatarExt);
		if (!buffer || !mimeType) throw validation("Persona has no avatar.");

		const profile = await this.resolveActiveProfileOrThrow();
		if (!profile.visionModel) {
			throw validation("No vision model configured in the active provider profile. Set one in Provider settings.");
		}
		const prompt = await this.resolveVisionDescribePromptFromPreset();

		const descriptions = await describeAttachments(
			[{ id: "avatar", assetId: "avatar", type: "image", name: `${persona.name} avatar`, mimeType, sizeBytes: 0 }],
			profile.visionModel,
			profile,
			async () => buffer,
			prompt,
		);
		const text = descriptions.get("avatar")?.trim() ?? "";
		await this.stores.personas.setMediaFields(brandId<PersonaId>(personaId), { avatarDescription: text });
		return { description: text };
	};

	// ─── Vision describe helpers (mirror ChatAdapter) ──────────────────

	private async resolveActiveProfileOrThrow() {
		const profile = await this.providerProfileService.resolveActiveProviderProfile();
		if (!profile) {
			throw validation("No active provider profile. Activate one in Provider settings.");
		}
		return { ...profile, defaultModel: profile.defaultModel as string };
	}

	private async resolveVisionDescribePromptFromPreset(): Promise<string> {
		const settings = await this.stores.uiSettings.get();
		let aiAssistantPrompts: Record<string, string> | null = null;
		if (settings?.activePromptPresetId) {
			const preset = await this.stores.presets.getById(settings.activePromptPresetId);
			if (preset?.aiAssistantPrompts) {
				try {
					const parsed = JSON.parse(preset.aiAssistantPrompts);
					if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
						aiAssistantPrompts = Object.fromEntries(
							Object.entries(parsed).filter(([, v]) => typeof v === "string"),
						) as Record<string, string>;
					}
				} catch {}
			}
		}
		return resolveVisionDescribePrompt(aiAssistantPrompts);
	}

	// ─── Export / Import (PR-5) ─────────────────────────────────────────
	// Single + bulk use serializePersona (persona-export.ts) + the format builders.
	// Bulk mirrors ST backup semantics: one self-contained JSON, no zip dependency.

	private personaExportFilename(prefix: string): string {
		const d = new Date();
		const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
		return `${prefix}_${stamp}.json`;
	}

	private avatarKeyFor(persona: { id: string; name: string; avatarExt: string | null }): string {
		// Prefer the on-disk avatar extension so the key matches ST's
		// "User Avatars/<key>.png" convention. Fall back to png for no-avatar personas.
		const ext = persona.avatarExt ?? "png";
		const safeName = persona.name.replace(/[^A-Za-z0-9_-]+/g, "_") || "persona";
		return `${persona.id}-${safeName}.${ext}`;
	}

	exportPersona = async (personaId: string, format: "st" | "vt") => {
		const payload = await serializePersona(this.stores, this.assetService, personaId);
		if (!payload) throw notFound("Persona", `Persona '${personaId}' was not found.`);
		if (format === "st") {
			const key = this.avatarKeyFor(payload.persona);
			const slice = buildStPersonaSlice(payload, key);
			const body = mergeStSlices([{ slice, isDefault: payload.persona.defaultForNewChats }]);
			return { body: body as unknown as Record<string, unknown>, filename: this.personaExportFilename("persona"), contentType: "application/json; charset=utf-8" };
		}
		const body = buildVtPersonaPayload(payload);
		return { body: body as unknown as Record<string, unknown>, filename: this.personaExportFilename("persona"), contentType: "application/json; charset=utf-8" };
	};

	exportAllPersonas = async (format: "st" | "vt") => {
		const all = await this.stores.personas.listAll();
		if (format === "st") {
			const slices: Array<{ slice: ReturnType<typeof buildStPersonaSlice>; isDefault: boolean }> = [];
			for (const p of all) {
				const payload = await serializePersona(this.stores, this.assetService, p.id);
				if (!payload) continue;
				const key = this.avatarKeyFor(payload.persona);
				slices.push({ slice: buildStPersonaSlice(payload, key), isDefault: payload.persona.defaultForNewChats });
			}
			return { body: mergeStSlices(slices), filename: this.personaExportFilename("personas"), contentType: "application/json; charset=utf-8" };
		}
		const payloads = [];
		for (const p of all) {
			const payload = await serializePersona(this.stores, this.assetService, p.id);
			if (!payload) continue;
			payloads.push(buildVtPersonaPayload(payload));
		}
		return { body: payloads, filename: this.personaExportFilename("personas"), contentType: "application/json; charset=utf-8" };
	};

	importPersonas = async (input: unknown) => {
		const created = { count: 0 };
		const errors: string[] = [];
		let skipped = 0;
		if (Array.isArray(input)) {
			// VT bulk array (lossless round-trip).
			for (const item of input) {
				try {
					const parsed = personaExportVtSchema.safeParse(item);
					if (!parsed.success) { skipped++; continue; }
					await this.importVtPersona(parsed.data, created);
				} catch (e) {
					errors.push(e instanceof Error ? e.message : String(e));
				}
			}
		} else if (input && typeof input === "object") {
			// ST backup object (lossy: VT-only fields not restorable).
			const parsed = stPersonaBackupSchema.safeParse(input);
			if (!parsed.success) return { created: 0, skipped: 1, errors: ["Unrecognized ST backup shape"] };
			const data = parsed.data;
			for (const key of Object.keys(data.personas)) {
				try {
					const name = data.personas[key];
					const desc = data.persona_descriptions[key];
					if (!name?.trim()) { skipped++; continue; }
					const rec = await this.stores.personas.create({
						name: name.trim(),
						description: desc?.description ?? "",
						defaultForNewChats: key === data.default_persona,
					});
					// ST pronoun → VT PronounForms remap (only when the 5-field extension block is present).
					if (desc?.pronoun) {
						const pr = desc.pronoun;
						await this.stores.personas.update(rec.id, {
							pronouns: "custom",
							pronounForms: {
								subjective: pr.subjective, objective: pr.objective,
								possessive: pr.posDet, possessivePronoun: pr.posPro, reflexive: pr.reflexive,
							},
						});
					}
					created.count++;
				} catch (e) {
					errors.push(e instanceof Error ? e.message : String(e));
				}
			}
		} else {
			return { created: 0, skipped: 0, errors: ["Expected an array (VT) or object (ST backup)"] };
		}
		return { created: created.count, skipped, errors };
	};

	private async importVtPersona(p: z.infer<typeof personaExportVtSchema>, created: { count: number }): Promise<void> {
		const rec = await this.stores.personas.create({
			name: p.name,
			description: p.description,
			pronouns: p.pronouns,
			pronounForms: p.pronounForms,
			avatarDescription: p.avatarDescription,
			includeAvatarInPrompt: p.includeAvatarInPrompt,
			defaultForNewChats: p.defaultForNewChats,
		});
		// Restore avatars from base64.
		if (p.avatarThumb) {
			const bytes = Buffer.from(p.avatarThumb.bytesBase64, "base64");
			const blob = new Blob([new Uint8Array(bytes)]);
			const file = new File([blob], `avatar.${p.avatarThumb.ext}`, { type: "application/octet-stream" });
			const { ext } = await this.assetService.writePersonaAvatar(rec.id, file);
			await this.stores.personas.setFolderAvatar(rec.id, ext);
		}
		if (p.avatarFull) {
			const bytes = Buffer.from(p.avatarFull.bytesBase64, "base64");
			const blob = new Blob([new Uint8Array(bytes)]);
			const file = new File([blob], `avatar-full.${p.avatarFull.ext}`, { type: "application/octet-stream" });
			const f = await this.assetService.writePersonaAvatarFull(rec.id, file);
			await this.stores.personas.setFolderAvatarFull(rec.id, f.ext);
		}
		created.count++;
	}
}
