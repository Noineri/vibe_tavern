/**
 * The full historical trail of the test-hygiene RATCHET BUDGETS,
 * extracted from test-hygiene.ts (2026-11-11, supervisor maintenance,
 * same law as the quarantine extraction f4201172c): the file-size
 * ratchet's only remedies are EXTRACT or ESCALATE, and the as-never
 * changelog was the file's growing part. Every entry below moved
 * BYTE-IDENTICALLY from above the asNever field; the LATEST entry and
 * the current values stay in test-hygiene.ts, which carries a pointer.
 *
 * TRAIL: the as never budget 1243 -> 29 (steps 6a-15f; each entry names
 * its batch, the shapes that died, and the gate numbers of its day).
 */

	// 1243 (2026-10-04): ratcheted to the merged tree's count after PR #51.
	// 1246 (2026-10-11, PM-7): +3 — the restored-as-was todo describe in
	// experience-copilot-tools.test.ts carries the same three `as never`
	// result casts PM-6 deleted with the mechanic (deliberate growth, not
	// drift — the restore mandate forbids rewriting the old tests).
	// 1243 (2026-10-12, PM-7 fixup, owner ruling): those 3 casts were
	// eliminated — the todo results are typed as the seam's exported
	// ExperienceCopilotTodoResult — and the ratchet lowered back; the
	// ratchet exists to go DOWN.
	// 1246 (2026-10-12, CPF-2b): +3 — continue-fallback integration tests
	// (live-chat-continue-fallback.test.ts): (a) the chatRuntime DI stub for
	// the LiveChatOrchestrator constructor (ChatRuntime is nominal — private
	// deps — the same cast the existing live-chat-continue.test.ts harness
	// uses), (b) the ChatRuntimeDeps object for the real-ChatRuntime
	// attribution tests (members are nominal store classes; one whole-object
	// cast instead of a dozen), (c) one shared `UNSET` for the two
	// required-but-unused ctor deps. Minimized from 22 raw harness casts
	// (real RpModeStrategy instead of a stub, real executor types for the DI
	// stub, `satisfies` for the trace literal). Lower when the nominal DI
	// boundaries become structural.
	// 1245 (2026-10-15, RO-5): unused casts removed; ratchet lowered to match.
	// 1244 (2026-10-21, SC-11): one insights scene-harness stub typed — SC-11
	// reached 1246 mid-unit, paid back to 1244 at commit (SC-10's HEAD was
	// green at exactly 1245/1245).
	// 1245 (2026-10-26, DR-3a): +1 — story-plan-sync.test.ts constructs
	// ObjectiveService twice (main pair + the observer-failure case) with two
	// unused ctor deps (SessionRuntime/ProviderProfileService — no path under
	// test touches them); minimized to ONE shared `unusedObjectiveDeps` cast
	// from 4 raw `null as never`s. Lower when the ctor deps become optional
	// or the DI boundary becomes structural.
	// 1243 (2026-11-07, DK-4a): the suites' ObjectiveService unused-deps casts
	// consolidated into ONE shared fixture (test/objective-service-fixture.ts —
	// the guard counts *.test.ts files only); ratchet lowered to match (owner
	// ruling: a unit that lowers a count locks the lower budget in the same
	// commit — the DR-3a minimization extended across suites).
	// 1240 (2026-11-09, TYPE-SAFETY sweep 6f): 3 `as never` sites died WITH
	// their erased constructs (regex-assist's fakeRouter activation pair,
	// st-directory-scanner's realAssemble narrowing) when the batch replaced
	// the erasures with typed doubles — re-adding dead casts to hold the
	// number contradicts the ratchet's direction. The worker's packet barred
	// budget edits, so the supervisor locks the lower budget in the immediate
	// follow-up commit.
	// 1238 (2026-11-09, TYPE-SAFETY sweep 7b): 2 `as never` sites died WITH
	// their erased seed-tracker literals (message-edit-coordination +
	// scene-zone — normalizeInsightsConfig accepts the literal cast-free);
	// same law, same supervisor follow-up commit.
	// 1235 (2026-11-10, TYPE-SAFETY sweep 7g): 3 `as never` sites died WITH
	// their erased constructs in TopBar.narrate.test.tsx (TooltipProvider /
	// Popover.Root probe arms + the erased fetch install — the batch replaced
	// the probes with direct typed package exports); same law, same
	// supervisor follow-up commit.
	// 1227 (2026-11-10, TYPE-SAFETY sweep 8a): 8 `as never` sites died WITH
	// their erased constructs — 3 in chat-selectors.test.ts makeTrace and 5 in
	// trace-history-store.test.ts makeTrace (both trace DTOs completed to the
	// real PromptTraceRecordDto with brandId'd ids, killing the member-level
	// never-spells); same law, same supervisor follow-up commit.
	// 1056 (2026-11-11, TYPE-SAFETY wave D step 14a): objective-service.test.ts
	// zeroed — all 171 sites died WITH their erased constructs: ctor null seams
	// → the shared unusedObjectiveDeps token; fake executes/resolvePrompts →
	// ConstructorParameters<typeof ObjectiveService> seam types + real
	// GenerationResult results; "chat_1" ids → brandId<ChatId>;
	// sessionRuntime/providerProfiles doubles → makeSessionRuntime /
	// strictTestDouble with complete makeProviderProfileRow records (the
	// insights-test-builders SessionRuntimeFixture input widened with the real
	// buildPipelineContext branchId member). One commit with the test edits.
	// 979 (2026-11-11, TYPE-SAFETY wave D step 14b): the coauthor cluster
	// zeroed — all 77 sites died WITH their erased constructs
	// (coauthor-tools 45, coauthor-prompt 28, skill-read-tool 2, lore-model 1,
	// chat-api 1): the tool-call context fakes (a nonexistent `abort` member,
	// `context` missing) → the REAL AI SDK ToolExecutionOptions via ONE
	// makeToolContext helper / typed literals; result-side never-spells → the
	// ToolSet execute return (the script-agent-tools precedent); message-row
	// literals → the standing makeMessageRow builder (prompt bytes pinned
	// unchanged by the file's own sha256 test); branded ids → brandId;
	// `rows.slice(-limit) as never[]` → typed rows; promptService {} →
	// strictTestDouble<PromptAssemblyService>; listCoauthorChats/prepareLiveTurn
	// ids → brandId<CharacterId>/<ChatId>. One commit with the test edits.
	// 928 (2026-11-11, TYPE-SAFETY wave D step 14c): the copilot cluster
	// zeroed — all 51 sites died WITH their erased constructs (compaction 30,
	// copilot-tools 19, agent-plan-tools 1, stream 1): the compaction ctor
	// pairs were pure deletions (makeProviderProfilesFixture already returns
	// the ctor's ProviderProfileService; makeExecutor's execute already matches
	// typeof nonstreamingProviderExecute — the cast-free SC-8a block proved
	// both), the dedupe gate now resolves a REAL GenerationResult (the old
	// `{ text }` was 14a's fiction class); copilot-tools' file-local ctx fake
	// (the 14b fiction: nonexistent `abort`, missing required `context`) →
	// makeToolContext + executeTool<O> with per-tool real output types — the
	// seam PROMOTED to provider-boundary-test-builders.ts (one derivation, 3+
	// consumers: coauthor-tools imports it now too, its 81 tests re-run
	// unchanged); agent-plan-tools ctx → makeToolContext (execute sites left —
	// their possibly-undefined keys are baselined debt, untouched); stream's
	// single site was noise (the request type allows the mode-less input the
	// AP-9 guard rejects at runtime). One commit with the test edits.
	// 861 (2026-11-11, TYPE-SAFETY wave D step 14d): the tracker/scene cluster
	// zeroed — all 67 sites died WITH their erased constructs
	// (scene-cache-lifecycle 23, tracker-service 17, tracker-backfill 14,
	// tracker-coordinator 13): the 23 rebuildCurrentSceneCache casts died by
	// typing the harness variables (chatId: ChatId / branchId: ChatBranchId)
	// with brandId at the DB→test read boundary; SceneTarget literals →
	// brandId<ChatId>/<ChatBranchId>/<MessageId>/<MessageVariantId>;
	// SceneTrackerService ctor null-pairs → the standing unusedObjectiveDeps
	// token; sessionRuntime fragments → the standing makeSessionRuntime (its
	// fixture gained the REAL throughMessageId input member — the 14a
	// branchId-extension precedent — so the SCN-14 freeze pins keep their
	// captures); providerProfiles fragments → strictTestDouble<ProviderProfileService>
	// over makeProviderProfileRow rows; `{ text }` fakes → the shared
	// execResult builder (promoted to insights-test-builders.ts, fork #1 of
	// objective-service.test.ts's 14a original). One commit with the test edits.
	// 776 (2026-11-11, TYPE-SAFETY wave D step 14e): the experience spread
	// zeroed — all 85 sites died WITH their erased constructs
	// (model-effect-service 23, context-service 17, timer-scheduler 16,
	// timer-effect-service 6, round-service 5, replay-service 4, service 4,
	// resource-service 3, routes 3, playground 2, chatter-service 1,
	// effect-retry 1): the Aria/Olya/Rules store-create fragments died as
	// PURE DELETIONS (the literals already satisfy CreateCharacterData /
	// CreatePersonaData / CreateScriptData — the 14c compaction lesson);
	// createChat fragments completed with the REAL required member
	// `promptPresetId: null` (column default, runtime-identical — this also
	// killed the 10 live TS2741 CreateChatInput baseline errors); the
	// capabilityGrants casts died by typing GRANTS/seed params as
	// ExperienceCapability[]; `"openai"`/`"off"` profile members → real
	// CoauthorTransport/ProviderProxyMode values ("chat_completions" /
	// "inherit" — the store defaults; neither is read on the exercised
	// paths); execute/executeStructured doubles typed via
	// typeof nonstreamingProviderExecute + ExperienceModelEffectServiceDeps
	// and returning the shared execResult shape (the `{ text }` fiction);
	// the per-model getProviderModelSettings fake completed to a REAL
	// ProviderModelSettingsRecord; resource-service's hostile
	// "not_a_real_capability" re-cast as ExperienceCapability pinning the
	// isValidCapability runtime guard (the 14a agent-kind-registry
	// precedent); playground's comment mention reworded so the content-level
	// scanner regex no longer counts it. One commit with the test edits.
	// 722 (2026-11-11, TYPE-SAFETY wave D step 14f): the imports + stt/tts
	// clusters zeroed — all 54 sites died WITH their erased constructs
	// (import-batch 8, import-lean 8, import-vtf-monolith 8,
	// import-chat-swipe-selection 3, stt-routes 9, the four stt-backend-*
	// files 3 each, tts-adapter-voices 2, tts-narration-library 2,
	// tts-routes 2): importer mocks typed against makeImportExportDeps' real
	// fixture types — create/writeEntity/seedImportedOpening returns were
	// already honest (pure deletions), update returns a real makeCharacterRow
	// row, getSnapshot → makeSessionSnapshot, createChat ids and the default
	// resolvers → brandId<ChatId>/<PersonaId>/<PromptPresetId>; stt-routes
	// providers.create dropped the dead isDefault member (CreateProviderData
	// never carried one — the store ignores it and auto-key matches on
	// endpoint+apiKey only) and its tts.create literals completed to
	// CreateTtsProfileData with the tts_profiles column defaults
	// (runtime-identical), while the "openai-compatible"/"gemini" backend
	// slugs and stt.create (sortOrder is store-generated) were pure
	// deletions; the four stt-backend-* makeBackend helpers and
	// registry-slug tests carry ONE documented `as SttProfileConfig` each at
	// the ST-5a injected-key bag seam (production makes the same cast at
	// stt-adapter.ts:419 — parseConfig reads apiKey off the loose bag), and
	// their `{ model: "m" }` hostile pins died as deletions (a partial
	// config is a valid union member — the missing-key ConfigError is the
	// runtime guard under test); narration-library's pins died as deletions
	// (parseNarrationLibraryKey takes unknown; NarrationLibraryKey ids are
	// plain strings); tts-routes' addLink literals are the real TtsTargetType
	// members; tts-adapter-voices rebuilt the fake row as a real TtsProfile
	// (brandId edge) and the deps partial as strictTestDouble. One commit
	// with the test edits.
	// 679 (2026-11-11, TYPE-SAFETY wave D step 14g): the live-chat / sp5 /
	// dice clusters zeroed — all 43 sites died WITH their erased constructs
	// (live-chat-continue 13, live-chat-forward-state 8, sp5-service-prompts
	// 11, live-chat-continue-fallback 3, dice-send-stream-nonstream 8):
	// chatRuntime mocks → strictTestDouble<ChatRuntime> with the REAL member
	// returns (appendMessageVariant / buildMessageResponse completed with the
	// required promptTrace: null; appendAssistantReply a real
	// AppendedAssistantReply with brandId<ChatBranchId>/<MessageId>; prepare
	// snapshot → makeSessionSnapshot; assemblePromptPreview / assemblePrompt
	// completed to the full AssemblePromptResponse / ChatModeAssembleResult);
	// ctor null-triples (chatRuntime/chatApp/providers, never dereferenced on
	// the paths under test) → strictTestDouble tokens typed as the dep
	// intersections (objective-service-fixture.ts's unusedObjectiveDeps
	// semantics, file-local per the packet scope); strategy literals typed
	// ChatModeStrategy (mode + a throwing assemble added — the erased stub
	// lacked both required members); unexercised executor seam members →
	// a file-local throwing unusedExecutor (the fallback/dice precedent);
	// the CPF-2b whole-deps cast → strictTestDouble<ChatRuntimeDeps> with
	// completed store fragments (makeChatRow / makeVariantRow rows — the old
	// variant fragment carried isSelected: 1 and missed seven required
	// members) and the guarded-optional members the erased literals answered
	// with undefined now provided inert (peekPendingPresetName → null,
	// persistCoauthorReview → no-op — observable-identical); sp5 loaders →
	// the standing makeChatRow / makeCharacterRow rows (the erased character
	// literal carried NONEXISTENT members hasFileOnDisk / avatarCrop —
	// nothing reads them; assembleCoauthorPrompt reads only
	// chat.coauthorModuleId/activeBranchId and character.id) and its
	// promptService → strictTestDouble (grep-proven unread), chatId →
	// brandId<ChatId>, the copilot explicitProfile typed CopilotProfile with
	// the REQUIRED agentKind the cast omitted; dice's response-builder stubs
	// typed from ChatRuntimeDeps (getSnapshot → makeSessionSnapshot,
	// BranchResponse.activeBranch through the mapChatBranch funnel, chatOrder
	// a complete IChatOrder literal). test-type-gate stayed clean at 852
	// byte-untouched keys with zero new keys (no shrink — these casts
	// suppressed diagnostics, they never produced baselined ones). One commit
	// with the test edits.
	// 613 (2026-11-11, step 14i): −22 — the services/api tail (12 files:
	// ai-assistant-stream 3, attachment-delete 2, avatar-adapter 1,
	// chat-lifecycle-insights-context 1, chat-summary-assembly 2,
	// effective-profile-model-override 1, gallery-adapter 1,
	// gallery-avatar-repro 5, gallery-describe 1, prompt-assembly-dice-boundary
	// 2, provider-model-settings-routes 2, session-runtime-builders 1) —
	// **SERVICES/API TEST AS-NEVER = 0: STEP 14 CLOSES** (steps 15/16 own the
	// remaining apps/web ~611 + packages 2). The narrow `{ context }`
	// returns → makeBuiltPipelineContext promoted to
	// insights-test-builders.ts (one derivation; the makeSessionRuntime
	// wrapper now completes through it); the impersonation context bodies are
	// unchanged literals. resolveModel → the agent-suite `({}) as
	// LanguageModel` stub (7-file precedent). ChatAdapter unused ctor deps →
	// per-slot strictTestDouble tokens (the effective-profile precedent; a
	// dep-intersection token breaks PartialMembers — first draft tried it and
	// the mapped type collapsed to never, caught by the key-level tsc delta).
	// chatRuntime.deleteMessage stub → the real MessageResponse ({messages:
	// [], promptTrace: null}); sessionRuntime doubles → strictTestDouble with
	// the gallery-adapter cascade stub kept as a REAL character.delete member
	// (its stale "delegates to the store" comment corrected against the
	// :238 test comment); chat-summary promptTraceDraft → the 14h
	// chat-mode-strategy literal and the unread profiles → strictTestDouble
	// over makeProviderProfileRow; getProviderModelSettings → the real
	// ProviderModelSettingsRecord (overlay | null retyped to the non-null
	// overlays the tests actually pass); 6 PURE DELETIONS where the literals
	// already satisfied (getById(cid) ×4 — the store takes plain string;
	// upsert settings ×2 — the :113 twin already proved it). test-type-gate:
	// services/api 1750 errors / 637 keys before AND after — 0 dead, 0 new
	// (these casts suppressed nothing). One commit with the test edits.
	// 635 (2026-11-11, step 14h): −44 — the regex + insights + settings +
	// chat-mode clusters (44 sites / 7 files: regex-hooks 9 — one of them a
	// comment mention the word-bounded scanner counts, regex-reasoning 8,
	// regex-assist 2, insights-adapter 10, insights-feature 3,
	// settings-adapter 6, chat-mode-strategy 6). Session seams in the two RX
	// harnesses typed from ChatRuntimeDeps (makeSessionSnapshot; response
	// builders completed to the real contracts — MessageResponse's
	// promptTrace, BranchResponse through the mapChatBranch funnel — and a
	// complete IChatOrder for chatOrder, the dice harness shapes); the unused
	// ProviderOrchestrator ctor dep → strictTestDouble UNSET tokens;
	// regex-assist's resolveModel → the agent-suite LanguageModel stub and
	// the feature-mount runtime literal typed AiAssistantRuntimeApi (pure
	// noise: the literal already satisfied it); tracker doubles return real
	// SceneTrackerRecord rows; the InsightsAdapter objective slot →
	// makeObjectiveService({}) strict doubles (the file's own precedent);
	// insights-feature activates with a real bare Hono router (activate
	// reads only events); settings hostile inputs ride updateUiSettings's own
	// Record<string, unknown> parameter — pure deletions; chat-mode inputs
	// brand their ids, the unread promptService → strictTestDouble, the
	// resolveProvider profile → makeProviderProfileRow, and both assemble
	// inputs share a complete makeAssembleLoaders() (which also kills the
	// baselined loaders-missing TS2741 that the brandId edit would have
	// reworded). test-type-gate: exactly 1 dead key (that TS2741), 0 new
	// keys, 852 byte-untouched. One commit with the test edits.
	// 290 (2026-11-11, step 15a): −323 — the TtsProfileEditor.test.tsx
	// monster (323 occurrences / 204 lines, the repo's single biggest
	// as-never file). ONE typed fixture seam now carries the whole file:
	// asForm (the step-11c seam promoted to the file-wide completion point —
	// typed-key defaults mirror the hook's startCreate) + TtsFormFixture
	// (derived Parameters<typeof asForm>[0]) + TtsOverrides (Partial<
	// Omit<TtsHook, "form">> & { form? }): every per-test form literal wraps
	// in asForm(...) and types against the real TtsProfileForm; the 84
	// React.createElement(TtsProfileEditor, { tts }) call sites drop BOTH
	// casts (the component's Props are { tts: TtsHook } — pure noise, the
	// file's own mountEditor/rerender seams already proved it); 68 pure
	// deletions (TTS_BACKEND members ARE TtsBackendSlug — entities.ts:598;
	// headerMode "view"/"edit" is the real TtsHeaderMode union; editingId is
	// string | null; the voices-mock envelopes type TtsDraftVoicesResponse
	// directly — capableEnvelope/sfHint/capableNoHint now carry the
	// annotation; the TtsPreviewDeps synthesize/play mocks already matched).
	// FICTION fixed as values, not re-erased: the duplicate-name profiles row
	// carried a NONEXISTENT apiKey member (TtsProfileRecord never crosses
	// the wire with the secret — tts-api.ts) and every profile row/viewTts
	// record lacked the required autoKeyProviderName (+providerRef on the
	// derived viewTts record) — completed with null, mirroring the real
	// API rows; normalizeForm folded into asForm; the mock-implementation
	// envelope casts and the headerMode/editingId pins were the fiction
	// carriers. test-type-gate: apps/web workspace tsc 0 errors before AND
	// after (the file carried no baseline keys), 0 new keys, 852
	// byte-untouched. One commit with the test edits.
	// 216 (2026-11-11, step 15b): −74 — the provider-settings rest (74
	// sites / 7 files: SttProfileEditor 33 — the STT twin of 15a's monster,
	// SttSection 20, TtsApiKeyField 8, TtsSection 6, RegexAiAssistantModal 3,
	// WhisperModelPanel 2, ProviderSamplerPanel 2). MOSTLY PURE DELETIONS
	// where the files' own typed fixtures already satisfied: SttProfileEditor's
	// 33 React.createElement sites (Props { stt: SttHook }, the makeStt/
	// makeForm fixtures and the file's own typed props literal proved it);
	// SttSection's 4 MasterDetailModal blocks (its own JSX render is the
	// proof); TtsApiKeyField's component+props pairs (real props value/
	// onChange/placeholder?/stored?); TtsSection's pairs (its own JSX renders
	// again); WhisperModelPanel's stt literals (the panel takes
	// Pick<SttHook, "setForm">). TYPED SEAMS replacing fiction: the
	// RegexAiAssistantModal Harness now types onApply/currentRule as the real
	// Partial<RegexPresetDraft> props (regex-rule-draft.ts) and seeds the
	// provider store through the shared wireProviderProfile builder
	// (test/wire-fixtures.ts) instead of bare { id, name } rows;
	// ProviderSamplerPanel's capabilities param derives ComponentProps<
	// typeof ProviderSamplerPanel>["capabilities"] and its updateForm
	// harness satisfies ProviderSamplerOnChange (FormState extends
	// ProviderSamplerValues). test-type-gate: apps/web workspace tsc keys
	// identical before AND after — the batch files carried 0 keys, 0 new,
	// 852 byte-untouched. One commit with the test edits.
	// 166 (2026-11-11, step 15c): −50 — the hooks cluster (50 sites / 7
	// files: use-chat-controller 18, use-stt-profiles 17, use-tts-profiles
	// 11, use-character-import 1, use-copilot-model-favorites 1,
	// use-provider-models 1, use-quota-events 1). Chat-controller: 5
	// provider rows seed through wireProviderProfile; the activeChat
	// coauthor-mode row and seedRpSnapshot complete through
	// wireChat/wireBranch/wirePersona with normalizeInsightsConfig carrying
	// the persisted dice defaults (the seeded ids brandId'd at the seam);
	// the 3 identical Co-Author bootstrap blocks share ONE file-local
	// seedBootstrapUiSettings completion built over wireUiSettings (the
	// file's own earlier cast-free BootstrapData literal proved the shape);
	// makeRoll's faceShape "d20"/resolution "strict" were already valid
	// members (pure deletions) while createdAt 0 was a WRONG-TYPED FICTION
	// fixed as a real Timestamp string; refreshPending's mock gets the real
	// (chatId, branchId) => Promise<void> dice-store signature; the
	// setNormalLane scope literal was already complete; the seedRpSnapshot
	// header's comment mention REWORDED (the one non-code site of the
	// batch). stt/tts: ALL 28 setForm partials pure deletions (backend
	// slugs are real SttBackendType/TtsBackendSlug members, config is
	// Record<string, unknown>, autoKeyProviderName string | null).
	// use-character-import: the mock returns Promise<ImportJsonResponse>
	// with the FULL wire SessionSnapshot (empty chats/branches/messages/
	// summaries, promptTrace/persona null, the self-consistent
	// wireChat()/wireBranch() pair, wireCharacter carrying the avatarExt
	// the pin reads) + the branded activeChatId — the first draft's
	// partial snapshot drew a NEW TS2322 key in the key-level delta and was
	// COMPLETED, not re-erased. seedFavorites retyped
	// FavoriteProviderModelRecord[] (rows already complete); provider rows
	// in the two remaining files seed through wireProviderProfile.
	// apps/web tsc 0 errors before AND after, 0 new keys, 852
	// byte-untouched. One commit with the test edits. PROCESS RECORD: the
	// first 30-line draft of THIS entry pushed the file to 808 lines and
	// tripped [file-size-ratchet]; the mid-unit "fix" compressed the entry
	// to 20 lines — a VIOLATION of the ratchet's own law (trimming is
	// never a remedy; extraction or stop-and-escalate are the only paths —
	// owner ruling 2026-11-11). The sanctioned remedy landed as the
	// quarantine-guard extraction f4201172c (572/800), and this entry is
	// hereby restored to its full natural length.
	// 122 (2026-11-11, step 15d): −44 — the coauthor + modals batch, the
	// eight files 14/13/7/4/3/1/1/1 (CoauthorCharacterForm, provider-modal,
	// use-coauthor-input-area, CoauthorProviderModal, CoauthorInputArea,
	// CoauthorModuleModal, CoauthorSkillModal, AiAssistantModal). The repo
	// remainder is apps/web 120 + packages 2. THE SHAPES: CoauthorCharacterForm
	// — ONE file-local typed seam (installFetchMock, FetchImplementation
	// derived from typeof fetch, Object.assign carrying realFetch.preconnect —
	// the agent-kind-settings-api idiom) now carries all 12 fetch-mock sites:
	// the fake {ok,status,json,text} envelopes became real Response.json
	// bodies (production unwrapRpc reads ok + json only, apps/web/src/api/
	// unwrap.ts:26 supervisor-verified); the corrections-toast spy retyped
	// mock<typeof toast.warning> (sonner 2.0.8: (message, data?) =>
	// string | number); the E5 activeChat literal completed through wireChat
	// (the file's own idiom at three other sites). provider-modal —
	// ModalProps = ComponentProps<typeof ProviderModal> (the props interface
	// is unexported; the derivation keeps it one-place, the 15b
	// ProviderSamplerPanel precedent), renderModal's three casts PURE
	// DELETIONS, makeProfile completed over wireProviderProfile keeping every
	// real-member value 1:1 (the nonexistent emotionAnnotation member
	// dropped; cachedModels gains the REQUIRED cachedAt, also on the ollama
	// call site), baseProps typed and the eight callback returns real
	// (ProviderProbeResponse takes { success: true }), the setState cast
	// deleted. The two bootstrap seeds (use-coauthor-input-area,
	// CoauthorProviderModal) completed as real BootstrapData: the REQUIRED
	// agentKindSettings added, uiSettings built over wireUiSettings + the
	// binding override (the 15c seedBootstrapUiSettings shape). Action mocks
	// retyped through the real modules (Parameters<typeof
	// real.patchUiSettingsAction>[0] / [1], returning wireUiSettings /
	// wireProviderProfile — reorder put the real imports above the mocks).
	// The provider row in use-coauthor-input-area seeds wireProviderProfile
	// (+cachedAt); the two favorites rows fixed AS VALUES: profileId → the
	// real providerProfileId member, scope/contextLength/createdAt completed,
	// the fictional sortOrder dropped (grep: no consumer — array order drives
	// the list). CoauthorInputArea + CoauthorModuleModal: activeChat seeds
	// through wireChat with brandId'd chat/character ids; the chat-store
	// activeChatId branded at the seam. CoauthorSkillModal:
	// queryByTestId("Other") plain string — the erased assignment bypassed an
	// already-valid Matcher (pure deletion). AiAssistantModal: seedBootstrap
	// drops the nonexistent personas member, adds agentKindSettings. apps/web
	// key-level tsc delta EMPTY before and after (the 8 files carried 0
	// baseline keys; the 2 pre-existing harness.smoke keys byte-stable), 852
	// byte-untouched. One commit with the test edits.
	// 68 (2026-11-11, step 15e): −54 — the chat-cluster batch, the fourteen
	// files 18/6/4/4/4/4/3/3/2/2/1/1/1/1 (use-message-narration,
	// MessageShell.narrate, message-shell-continue, objective-zone,
	// MessageShell.annotate-mobile, MessageShell.annotate,
	// message-edit-coordination, dice-rolls, scene-zone, MessageAiEditorModal,
	// ChatImpersonateAiPill — the TQ-2-flagged bootstrap fixture,
	// ImageGenSlotControls, InputArea.per-send-prefill, message-block-isolation
	// — the TQ-1-flagged sceneTracker literal). The repo remainder is apps/web
	// 66 + packages 2. THE SHAPES: use-message-narration — the five
	// __setTtsPlaybackDepsForTests seams drop both casts (the fake player
	// satisfies NarrationPlayer's six required members with play resolving
	// "ended", a SegmentPlayResult member; the fake synthesize matches
	// SynthesizeFn — fewer parameters are legal by contravariance, the return
	// shape is exact); the store setState partials drop theirs (the
	// (...args: unknown[]) capture wrappers ARE assignable to the real
	// startNarration/stopNarration signatures); the playing re-seed gains the
	// REQUIRED NarrationState.synthesized (1 = the fake's one genuine
	// synthesis); the TPE-19 macro seed completes through wireCharacter /
	// wirePersona / wireChat — where the erasure hid a WRONG-VALUE fiction:
	// mode "chat" is not a ChatMode member (rp | coauthor | novel | group,
	// platform-constants.ts CHAT_MODE) → the real default "rp", the same
	// not-coauthor read. The MessageShell four (narrate / continue / annotate /
	// annotate-mobile) — all 18 casts PURE DELETIONS: the typed makeProps seam
	// (Parameters<typeof MessageShell>[0]) was already in place and its
	// literal satisfies MessageShellProps / MessageMetaContext as written
	// ({ current: null } fits RefObject<HTMLSpanElement | null>, narrating is
	// optional, the override actions spread the complete seven-member base);
	// createElement takes the typed Tooltip.Provider directly. objective-zone —
	// the insights-completion action seams brand the chat id at the edge
	// (brandId<ChatId>), seedState and the ingested message row complete
	// through wireChat / wireMessage with normalizeInsightsConfig carrying the
	// persisted insights column. dice-rolls — ONE file-local metaCtx()
	// returning the complete MessageMetaContext replaces the three erased
	// partial contexts (the badge reads ONLY ctx.diceRolls — the file header's
	// own structural invariant — so the identity members are inert). scene-zone
	// + message-edit-coordination — record() brands variantId at the fixture
	// edge (brandId<MessageVariantId>); both generatedAt casts were PURE
	// DELETIONS (the domain Timestamp is a plain string alias, entities.ts);
	// setActiveChatId takes brandId<ChatId>. MessageAiEditorModal —
	// seedBootstrap now matches the file's own cast-free seedPairs literal: the
	// NONEXISTENT personas member dropped (it lives on BootstrapState, never on
	// BootstrapData), the REQUIRED agentKindSettings added; the TPE-19 macro
	// seed completes through the same three wire rows (mode "chat" → "rp"
	// again). ChatImpersonateAiPill — the flagged fixture is a real
	// BootstrapData: uiSettings spreads wireUiSettings and keeps the three
	// pins the tests read as overrides (every other value of the old literal
	// equals a wireUiSettings default), personas dropped, agentKindSettings
	// added. ImageGenSlotControls — the minimal { id, attachments } row
	// completes through wireMessage(id, { attachments }) (attachments is an
	// optional member of the wire message); the SeededMessage alias, used only
	// by the cast, left with it. InputArea.per-send-prefill — the fake
	// controller object is untyped, the empty personas array needed no cast
	// (pure deletion). message-block-isolation — ONLY the erasure died: the m2
	// sceneTracker mutation keeps every value including the literal "h1"
	// schemaHash, plus the runtime-inert variantId brand, so the
	// assert-independent Profiler counts (mount 1, 0 after B's mutation) are
	// untouched. apps/web key-level tsc delta EMPTY before and after, measured
	// on the MAIN workspace config (its src/** include carries the collocated
	// tests; tsconfig.test.json covers apps/web/test/** only): 0 diagnostics at
	// the base commit and after, 0 new keys; the test tree's pre-existing
	// harness.smoke keys byte-stable; 852 byte-untouched. The fourteen
	// per-file spot runs carry identical counts before and after
	// (9/3/4/15/1/4/8/12/22/45/2/20/6/10, 0 fail). One commit with the test
	// edits.

