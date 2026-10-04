/** Runtime contracts for the TTS, STT, and image-generation profile route families. */

// ─── TTS profiles (TTS_PLAN TS-6) ──────────────────────────────────────────

export interface TtsRuntimeApi {
	listTtsProfiles: () => Promise<import("@vibe-tavern/api-contracts").ClientTtsProfileRecord[]>;
	reorderTtsProfiles: (updates: Array<{ id: string; sortOrder: number }>) => Promise<import("@vibe-tavern/api-contracts").ClientTtsProfileRecord[]>;
	getTtsProfile: (id: string) => Promise<import("@vibe-tavern/api-contracts").ClientTtsProfileRecord | null>;
	createTtsProfile: (body: import("@vibe-tavern/api-contracts").CreateTtsProfileInput) => Promise<import("@vibe-tavern/api-contracts").ClientTtsProfileRecord>;
	updateTtsProfile: (id: string, body: import("@vibe-tavern/api-contracts").UpdateTtsProfileInput) => Promise<import("@vibe-tavern/api-contracts").ClientTtsProfileRecord | null>;
	deleteTtsProfile: (id: string) => Promise<void>;
	setTtsDefault: (id: string) => Promise<import("@vibe-tavern/api-contracts").ClientTtsProfileRecord | null>;
	getDefaultTtsProfile: () => Promise<import("@vibe-tavern/api-contracts").ClientTtsProfileRecord | null>;
	getTtsLinks: (id: string) => Promise<import("@vibe-tavern/domain").TtsProfileLink[]>;
	setTtsLinks: (id: string, links: Array<{ targetType: import("@vibe-tavern/domain").TtsTargetType; targetId: string; mode?: import("@vibe-tavern/domain").TtsLinkMode }>) => Promise<import("@vibe-tavern/domain").TtsProfileLink[]>;
	listAllTtsLinks: () => Promise<import("@vibe-tavern/domain").TtsProfileLink[]>;
	generateTtsSpeech: (body: import("@vibe-tavern/api-contracts").GenerateTtsInput, signal?: AbortSignal) => Promise<{ audio: Buffer; mime: string } | null>;
	listTtsVoices: (profileId: string) => Promise<import("../../domain/tts/tts-backend.js").TtsVoiceInfo[] | null>;
	/** Transient voices lookup from an unsaved form config (no DB row). Throws
	 *  KokoroClientSideError for the browser-only backend (route → 400).
	 *  Response envelope: capabilities ride alongside voices — voices may be
	 *  null (empty library / manual floor) while the backend still supports
	 *  cloning (clone field design, 2026-08-31). */
	draftListTtsVoices: (body: import("@vibe-tavern/api-contracts").DraftTtsVoicesInput) => Promise<{
		voices: import("../../domain/tts/tts-backend.js").TtsVoiceInfo[] | null;
		capabilities: import("../../domain/tts/tts-backend.js").TtsBackendCapabilities;
	}>;
	/** Transient voice clone from an unsaved form config: upload a reference
	 *  sample, get the created voice back. Audio passes through memory only.
	 *  Throws KokoroClientSideError (route → 400) and
	 *  TtsCloneUnsupportedError when the backend lacks the capability (→ 400). */
	cloneTtsVoiceDraft: (body: {
		backend: import("@vibe-tavern/api-contracts").DraftTtsVoicesInput["backend"];
		config: Record<string, unknown>;
		profileId?: string;
		name: string;
		referenceAudio: Buffer;
		mimeType: string;
		/** Reference-audio transcript for providers that require it
		 *  (SiliconFlow `text`); optional otherwise. */
		referenceText?: string;
	}) => Promise<import("../../domain/tts/tts-backend.js").TtsVoiceInfo>;
	/** Transient one-shot synthesis from an unsaved form config. Throws
	 *  KokoroClientSideError for the browser-only backend (route → 400). */
	draftPreviewTts: (body: import("@vibe-tavern/api-contracts").DraftTtsPreviewInput) => Promise<{ audio: Buffer; mime: string }>;
	draftListTtsModels: (body: import("@vibe-tavern/api-contracts").DraftTtsModelsInput) => Promise<import("../../domain/tts/tts-backend.js").TtsModelInfo[] | null>;
	/** Honest docker-availability check for the local-server quickstart
	 *  (D8): `docker --version` bounded by a timeout; never throws. */
	probeLocalDocker: () => Promise<import("@vibe-tavern/api-contracts").LocalDockerStatus>;
	discoverLocalTts: () => Promise<import("@vibe-tavern/domain").ProbeOutcome[]>;
	/** TPE-18c: per-character narration library (one OGG per message).
	 *  The key already encodes character/chat/branch/message/variant — no
	 *  manifest, no DB table. Throws NarrationLibraryUnavailableError when
	 *  no library service is wired (route → 501). */
	saveNarrationFile: (key: import("../../domain/tts/narration-library.js").NarrationLibraryKey, audio: Buffer) => Promise<{ leaf: string }>;
	getNarrationFile: (key: import("../../domain/tts/narration-library.js").NarrationLibraryKey) => Promise<{ audio: Buffer; mime: string } | null>;
	narrationFileExists: (key: import("../../domain/tts/narration-library.js").NarrationLibraryKey) => Promise<boolean>;
	deleteNarrationFile: (key: import("../../domain/tts/narration-library.js").NarrationLibraryKey) => Promise<{ deleted: boolean }>;
	revealNarrationFile: (key: import("../../domain/tts/narration-library.js").NarrationLibraryKey) => Promise<{ argv: string[] }>;
}


export interface SttRuntimeApi {
	listSttProfiles: () => Promise<import("@vibe-tavern/api-contracts").ClientSttProfileRecord[]>;
	reorderSttProfiles: (updates: Array<{ id: string; sortOrder: number }>) => Promise<import("@vibe-tavern/api-contracts").ClientSttProfileRecord[]>;
	getSttProfile: (id: string) => Promise<import("@vibe-tavern/api-contracts").ClientSttProfileRecord | null>;
	createSttProfile: (body: import("@vibe-tavern/api-contracts").CreateSttProfileInput) => Promise<import("@vibe-tavern/api-contracts").ClientSttProfileRecord>;
	updateSttProfile: (id: string, body: import("@vibe-tavern/api-contracts").UpdateSttProfileInput) => Promise<import("@vibe-tavern/api-contracts").ClientSttProfileRecord | null>;
	deleteSttProfile: (id: string) => Promise<void>;
	setSttDefault: (id: string) => Promise<import("@vibe-tavern/api-contracts").ClientSttProfileRecord | null>;
	getDefaultSttProfile: () => Promise<import("@vibe-tavern/api-contracts").ClientSttProfileRecord | null>;
	/** Transcribe one audio payload with a saved profile. Returns null for an
	 *  unknown profile; throws SttClientSideError for the in-browser backend
	 *  (route → 400). The transcription config (own key, then endpoint
	 *  auto-match over provider AND TTS profiles) resolves server-side — the
	 *  secret never crosses the boundary. */
	transcribeSttAudio: (
		profileId: string,
		audio: { buffer: Buffer; mimeType: string; fileName: string },
		language?: string,
	) => Promise<{ text: string; language?: string; annotation?: string } | null>;
	/** Local STT server discovery routed through the API process (ST-8) —
	 *  never throws; each port's failure mode is a ProbeOutcome. */
	discoverLocalStt: () => Promise<import("@vibe-tavern/domain").ProbeOutcome[]>;
	/** Live STT model discovery over the TRANSIENT draft config (P8 — the
	 *  twin of `draftListTtsModels`): the form's current config plus optional
	 *  `profileId` for stored-key resolution. Null = the backend exposes no
	 *  model list (whisper-browser is a fixed local roster — the route maps
	 *  null to a clean 400). */
	draftListSttModels: (body: import("@vibe-tavern/api-contracts").DraftSttModelsInput) => Promise<import("@vibe-tavern/api-contracts").SttModelInfoValue[] | null>;
}


/** Image-gen profiles + generation routes (IMAGE_GENERATION_PLAN IG-8) —
 *  the STT route twin plus the generate/gallery arms: profile CRUD with the
 *  hasStoredApiKey projection, probe/models/samplers through the backend
 *  registry (imported for their registration side effects in the adapter),
 *  one-shot generation that persists bytes as flat attachments and appends
 *  the image message slot, and the gallery-promotion mirror. */
/** IF-20: a saved profile's listing — live, or the last-good snapshot
 *  (`snapshotAt` = its ISO fetch time) when the live fetch failed. */
export interface ImageGenListing<T> {
	data: T;
	snapshotAt?: string;
}

export interface ImageGenRuntimeApi {
	listImageGenProfiles: () => Promise<import("@vibe-tavern/api-contracts").ImageGenProfileValue[]>;
	reorderImageGenProfiles: (updates: Array<{ id: string; sortOrder: number }>) => Promise<import("@vibe-tavern/api-contracts").ImageGenProfileValue[]>;
	getImageGenProfile: (id: string) => Promise<import("@vibe-tavern/api-contracts").ImageGenProfileValue | null>;
	createImageGenProfile: (body: import("@vibe-tavern/api-contracts").CreateImageGenProfileInput) => Promise<import("@vibe-tavern/api-contracts").ImageGenProfileValue>;
	updateImageGenProfile: (id: string, body: import("@vibe-tavern/api-contracts").UpdateImageGenProfileInput) => Promise<import("@vibe-tavern/api-contracts").ImageGenProfileValue | null>;
	deleteImageGenProfile: (id: string) => Promise<void>;
	/** MR-12: move the GLOBAL active-profile pointer (the TTS/STT
	 *  `setDefault` twin). Null = unknown profile (route → 404). */
	setImageGenDefault: (id: string) => Promise<import("@vibe-tavern/api-contracts").ImageGenProfileValue | null>;
	/** Probe a saved profile's endpoint/credential. Null = unknown profile
	 *  (route → 404); failures arrive as `{ok:false}` data, never thrown. */
	probeImageGenProfile: (id: string, signal?: AbortSignal) => Promise<import("@vibe-tavern/api-contracts").ImageGenProbeResultValue | null>;
	/** Model catalog for a saved profile (picker data source): live, or the
	 *  last-good snapshot flagged with `snapshotAt` when the live fetch
	 *  failed (IF-20). Null = unknown profile (route → 404). */
	listImageGenProfileModels: (id: string, signal?: AbortSignal) => Promise<ImageGenListing<import("@vibe-tavern/api-contracts").ImageGenModelInfoValue[]> | null>;
	/** Samplers for a saved profile — capability-gated (A1111-compat only in
	 *  v1). Null = unknown profile (route → 404); `[]`-with-ok-probe is NOT
	 *  used here — a backend without the surface returns null too (route →
	 *  400 "sampler listing not supported", the STT null contract). */
	listImageGenProfileSamplers: (id: string, signal?: AbortSignal) => Promise<import("@vibe-tavern/api-contracts").ImageGenSamplerInfoValue[] | null>;
	/** Scheduler (schedule type) listing for a saved profile — A1111-dialect
	 *  gate (PG-3, the extensions-arm twin): null = unknown profile or
	 *  unsupported backend (route → 404/400, the samplers ladder). */
	listImageGenProfileSchedulers: (id: string, signal?: AbortSignal) => Promise<import("@vibe-tavern/api-contracts").ImageGenSchedulerInfoValue[] | null>;
	/** DiT sidecar (text encoder + VAE) listing for a saved profile —
	 *  comfyui-dialect gate (CG-B1, the schedulers twin): null = unknown
	 *  profile or unsupported backend (route → 404/400). Live, or the
	 *  last-good snapshot flagged with `snapshotAt` (IF-20). */
	listImageGenProfileDitSidecars: (id: string, signal?: AbortSignal) => Promise<ImageGenListing<import("@vibe-tavern/api-contracts").ImageGenDitSidecarsValue> | null>;
	/** LoRA list for a saved profile (dialect-gated: ComfyUI CG-C2, the
	 *  sidecars twin; A1111 with FT-A4). Null = unknown profile or
	 *  unsupported backend (route → 404/400, the samplers ladder). */
	listImageGenProfileLoras: (id: string, signal?: AbortSignal) => Promise<import("@vibe-tavern/api-contracts").ImageGenLoraInfoValue[] | null>;
	listImageGenProfileUpscalers: (id: string, signal?: AbortSignal) => Promise<import("@vibe-tavern/api-contracts").ImageGenUpscalerInfoValue[] | null>;
	listImageGenProfileVae: (id: string, signal?: AbortSignal) => Promise<string[] | null>;
	/** Face-detector model list for a saved profile (comfyui-dialect gate,
	 *  IF-6 — the Impact Pack chain probe): null = unknown profile or
	 *  unsupported backend (route → 404/400); an EMPTY array = the dialect
	 *  is right but the chain is absent (the honest unavailable signal). */
	listImageGenProfileFaceDetectors: (id: string, signal?: AbortSignal) => Promise<string[] | null>;
	/** Live progress snapshot for a saved profile — capability-gated
	 *  (supportsLiveProgress, A1111 dialect in v1). Null = unknown profile
	 *  or unsupported backend (route → 404/400, the samplers ladder). */
	getImageGenProfileProgress: (id: string, signal?: AbortSignal) => Promise<import("@vibe-tavern/api-contracts").ImageGenProgressInfoValue | null>;
	/** Ask the profile's local instance to cancel its current job
	 *  (`POST /sdapi/v1/interrupt`, capability-gated as above). Null =
	 *  unknown profile or unsupported backend; `true` = interrupt sent. */
	interruptImageGenProfile: (id: string, signal?: AbortSignal) => Promise<boolean | null>;
	listImageGenProfileExtensions: (id: string, signal?: AbortSignal) => Promise<string[] | null>;
	/** Shared fetch-by-endpoint model listing over the TRANSIENT draft config
	 *  (the STT draft twin): the form's current config plus optional
	 *  `profileId` for stored-key resolution (endpoint-guarded). Null = the
	 *  backend exposes no model list (route → 400). */
	draftListImageGenModels: (body: import("@vibe-tavern/api-contracts").DraftImageGenModelsInput) => Promise<import("@vibe-tavern/api-contracts").ImageGenModelInfoValue[] | null>;
	/** FT-B2: use the image profile's configured LLM assist to write an
	 * editable prompt only. No image backend or chat message is touched. */
	draftImageGenPrompt: (
		chatId: string,
		body: import("@vibe-tavern/api-contracts").DraftImageGenPromptInput,
		signal?: AbortSignal,
	) => Promise<import("@vibe-tavern/api-contracts").DraftImageGenPromptResponseValue>;
	/** One-shot generation: resolve the profile + chat, merge the per-mode
	 *  size presets and default params with the request overrides, generate
	 *  through the backend adapter, persist the image bytes as flat
	 *  attachments, and append the image message slot to the chat's active
	 *  branch. Throws typed ImageGenNotFoundError (profile/chat) and
	 *  ImageGenValidationError (unknown anchor) for the route ladder. */
	generateImageGen: (
		chatId: string,
		body: import("@vibe-tavern/api-contracts").GenerateImageGenInput,
		signal?: AbortSignal,
	) => Promise<import("@vibe-tavern/api-contracts").ImageGenGenerateResponseValue>;
	/** Copy a flat attachment into the character's media gallery (server-side
	 *  copy; the message's attachment stays immutable). Throws
	 *  ImageGenNotFoundError for a missing asset/character (route → 404). */
	promoteImageGenAttachmentToGallery: (
		assetId: string,
		characterId: string,
	) => Promise<import("@vibe-tavern/api-contracts").ImageGenGalleryPromoteResponseValue>;
	/** Starred models of a saved profile (IG-12b — the LLM model-favorites
	 *  mechanic; deviations named on the domain type). Null = unknown
	 *  profile (route → 404). */
	listImageGenModelFavorites: (id: string) => Promise<import("@vibe-tavern/api-contracts").ImageGenModelFavoriteValue[] | null>;
	/** Star (or refresh a star's label) — idempotent on (profile, model). */
	addImageGenModelFavorite: (
		id: string,
		body: import("@vibe-tavern/api-contracts").FavoriteImageGenModelInput,
	) => Promise<import("@vibe-tavern/api-contracts").ImageGenModelFavoriteValue | null>;
	/** Un-star a model. Null = unknown profile (route → 404). */
	removeImageGenModelFavorite: (id: string, modelId: string) => Promise<void | null>;
	/** Per-model image-field overlay rows of a profile (IG-12b — the LLM
	 *  per-model settings mechanic). Null = unknown profile (route → 404). */
	listImageGenModelSettings: (id: string) => Promise<import("@vibe-tavern/api-contracts").ImageGenModelSettingsValue[] | null>;
	/** One model's overlay — null = no bound settings (inherit base) OR
	 *  unknown profile (the route distinguishes via a profile read, the
	 *  samplers-route ladder). */
	getImageGenModelSettings: (id: string, modelId: string) => Promise<import("@vibe-tavern/api-contracts").ImageGenModelSettingsValue | null>;
	/** Upsert a model's overlay — idempotent on (profile, model). The
	 *  optional `samplerSetId` rides the same upsert: absent = keep the
	 *  stored pointer, null = clear, string = set (IG-CF15). */
	upsertImageGenModelSettings: (
		id: string,
		modelId: string,
		overlay: import("@vibe-tavern/api-contracts").ImageGenModelSettingsOverlayValue,
		samplerSetId?: string | null,
	) => Promise<import("@vibe-tavern/api-contracts").ImageGenModelSettingsValue | null>;
	/** Delete a model's overlay (revert to profile base). Null = unknown
	 *  profile (route → 404). */
	deleteImageGenModelSettings: (id: string, modelId: string) => Promise<void | null>;

	// ── Image prompt families (IPT-3 — the registry read model; the
	//    per-cell template routes were RETIRED by IF-1e: templates live in
	//    image prompt profiles now — see ImagePromptProfileRuntimeApi) ──
	/** The families registry read model (grammar + authoring flags +
	 *  addendum availability — the pane's dropdown data source). */
	listPromptFamilies: () => Promise<import("@vibe-tavern/api-contracts").ImagePromptFamiliesValue>;

	// ── Profile family (IPT-3 — the family-override writer + the
	//    authoritative detection ladder) ──
	/** Set (a family id) or clear (null) the profile's manual family pin —
	 *  the ONLY family-override writer (create stays unpinned; PATCH
	 *  family keys strip). Clearing resumes the auto path; the stored
	 *  detection (if any) survives the pin and re-anchors after a clear.
	 *  Returns the updated wire profile; null = unknown profile (route →
	 *  404). */
	setImageGenProfileFamily: (
		id: string,
		family: import("@vibe-tavern/api-contracts").ImagePromptFamilyValue | null,
	) => Promise<import("@vibe-tavern/api-contracts").ImageGenProfileValue | null>;
	/** Run authoritative family detection against the profile's CURRENT
	 *  model; on success persists familyDetected + familyDetectedForModel
	 *  (the exact model id the detection ran against) and returns the
	 *  typed family + sourceLabel. A no-answer is DATA (ok:false + the
	 *  ordered tried[] ladder) — never a thrown error, never a guess;
	 *  backend transport failures degrade into tried[] reasons (the
	 *  probe's failures-as-data contract). Throws a validation
	 *  DomainError when neither the explicit `model` nor the profile's
	 *  saved modelId is set. Null = unknown profile (route → 404). The
	 *  optional `model` names the model the detection inspects — the
	 *  client sends the DISPLAYED model so a freshly picked unsaved
	 *  model is detectable on the spot (the save-first gate is gone,
	 *  owner correction 2026-09-25); the persisted anchor is that exact
	 *  model either way. */
	detectImageGenProfileFamily: (
		id: string,
		signal?: AbortSignal,
		model?: string,
	) => Promise<import("@vibe-tavern/api-contracts").ImageGenFamilyDetectionResultValue | null>;

	// ── Named image-gen sampler sets (IG-CF15 — the sampler_sets LS-5 twin;
	//    a GLOBAL library, no profile scoping) ──
	listImageGenSamplerSets: () => Promise<import("@vibe-tavern/api-contracts").ImageGenSamplerSetList>;
	/** IF-10: the learned per-(backend, model) prompt caps — advisory
	 *  counter/budget data, never a send gate. */
	listImageGenPromptCaps: () => Promise<import("@vibe-tavern/api-contracts").ImageGenPromptCapList>;
	createImageGenSamplerSet: (
		input: import("@vibe-tavern/api-contracts").ImageGenSamplerSetCreate,
	) => Promise<import("@vibe-tavern/api-contracts").ImageGenSamplerSet>;
	updateImageGenSamplerSet: (
		setId: string,
		input: import("@vibe-tavern/api-contracts").ImageGenSamplerSetUpdate,
	) => Promise<import("@vibe-tavern/api-contracts").ImageGenSamplerSet>;
	deleteImageGenSamplerSet: (setId: string) => Promise<void>;
	/** Point import (upload button): name + RAW parsed JSON — VT-native set
	 *  JSON only (no ST TextGen target for image-gen); empty/foreign shapes
	 *  fail loudly. */
	importImageGenSamplerSet: (
		input: import("@vibe-tavern/api-contracts").ImageGenSamplerSetImport,
	) => Promise<{ set: import("@vibe-tavern/api-contracts").ImageGenSamplerSet; notes: string[] }>;
}
