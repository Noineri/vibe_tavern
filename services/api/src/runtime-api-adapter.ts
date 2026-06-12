import type { RuntimeApi } from "./routes/types.js";
import type { StoreContainer } from "@vibe-tavern/db";
import type { SessionRuntime } from "./session/session-runtime.js";
import type { ProviderProfileService } from "./providers/provider-profile-service.js";
import type { LiveChatOrchestrator } from "./chat/live-chat-orchestrator.js";
import type { ChatSummaryService } from "./chat/chat-summary-service.js";
import type { PromptPresetService } from "./prompt/prompt-preset-service.js";
import type { AssetService } from "./asset-service.js";
import type { MobileAccessService } from "./mobile-access-service.js";
import { BootstrapAdapter } from "./adapters/bootstrap-adapter.js";
import { ChatAdapter } from "./adapters/chat-adapter.js";
import { CharacterAdapter } from "./adapters/character-adapter.js";
import { PersonaAdapter } from "./adapters/persona-adapter.js";
import { LorebookAdapter } from "./adapters/lorebook-adapter.js";
import { ScriptAdapter } from "./adapters/script-adapter.js";
import { ProviderAdapter } from "./adapters/provider-adapter.js";
import { PresetAdapter } from "./adapters/preset-adapter.js";
import { ImportExportAdapter } from "./adapters/import-export-adapter.js";
import { AssetAdapter } from "./adapters/asset-adapter.js";
import { AiAssistantAdapter } from "./adapters/ai-assistant-adapter.js";
import { SettingsAdapter } from "./adapters/settings-adapter.js";
import { MobileAccessAdapter } from "./adapters/mobile-access-adapter.js";

/**
 * Thin composite that wires domain adapters into the RuntimeApi contract.
 * No business logic lives here — every method is owned by a sub-adapter.
 */
export class RuntimeApiAdapter implements RuntimeApi {
	readonly bootstrap: RuntimeApi["bootstrap"];
	readonly chat: ChatAdapter;
	readonly character: CharacterAdapter;
	readonly persona: PersonaAdapter;
	readonly lorebook: LorebookAdapter;
	readonly script: ScriptAdapter;
	readonly provider: ProviderAdapter;
	readonly preset: PresetAdapter;
	readonly importExport: ImportExportAdapter;
	readonly asset: AssetAdapter;
	readonly aiAssistant: AiAssistantAdapter;
	readonly settings: SettingsAdapter;
	readonly mobileAccess: MobileAccessAdapter;

	constructor(
		stores: StoreContainer,
		providerProfileService: ProviderProfileService,
		liveChatOrchestrator: LiveChatOrchestrator,
		chatSummaryService: ChatSummaryService,
		sessionRuntime: SessionRuntime,
		promptPresetService: PromptPresetService,
		assetService: AssetService,
		mobileAccessService: MobileAccessService,
	) {
		const bootstrapAdapter = new BootstrapAdapter(sessionRuntime);
		this.bootstrap = bootstrapAdapter.bootstrap;
		this.chat = new ChatAdapter(
			stores, sessionRuntime, liveChatOrchestrator,
			chatSummaryService, providerProfileService, assetService,
		);
		this.character = new CharacterAdapter(sessionRuntime, stores, assetService);
		this.persona = new PersonaAdapter(sessionRuntime, stores, assetService);
		this.lorebook = new LorebookAdapter(stores);
		this.script = new ScriptAdapter(stores);
		this.provider = new ProviderAdapter(stores, providerProfileService);
		this.preset = new PresetAdapter(promptPresetService);
		this.importExport = new ImportExportAdapter(sessionRuntime);
		this.asset = new AssetAdapter(assetService);
		this.aiAssistant = new AiAssistantAdapter(stores);
		this.settings = new SettingsAdapter(stores);
		this.mobileAccess = new MobileAccessAdapter(mobileAccessService);
	}
}
