import type {
  BootstrapRuntimeApi, ServicePromptRuntimeApi, ImagePromptProfileRuntimeApi,
  ChatRuntimeApi, CharacterRuntimeApi, CharacterAssetRuntimeApi, PersonaRuntimeApi,
  LorebookRuntimeApi, ScriptRuntimeApi, RegexRuntimeApi, TtsRuntimeApi, SttRuntimeApi,
  ImageGenRuntimeApi, ProviderRuntimeApi, ProxyRuntimeApi, PresetRuntimeApi,
  ImportExportRuntimeApi, AssetRuntimeApi, CoauthorSkillsRuntimeApi,
  CopilotSkillsByKindRuntimeApi, AiAssistantRuntimeApi, SettingsRuntimeApi,
  MobileAccessRuntimeApi, InsightsRuntimeApi, DiceRuntimeApi, ExperienceRuntimeApi,
  ExperienceCopilotRuntimeApi, AgentThreadProposalsRuntimeApi, CopilotProfileRuntimeApi,
  AgentPlanRuntimeApi, SamplerSetRuntimeApi, FormatTemplateRuntimeApi, AiInstructionTemplateRuntimeApi,
} from "./runtime-api.js";
import type { TrackerTemplateApi } from "./tracker-template-api.js";
import type { UserThemeRuntimeApi } from "./user-theme-api.js";
import type { SystemRuntimeApi } from "./system-api.js";

/** Composition only; feature contracts remain independently importable. */
export interface RuntimeApi extends TrackerTemplateApi {
  userThemes: UserThemeRuntimeApi;
  system: SystemRuntimeApi;
  bootstrap: BootstrapRuntimeApi["bootstrap"];
  servicePrompts: ServicePromptRuntimeApi;
  imagePromptProfiles: ImagePromptProfileRuntimeApi;
  chat: ChatRuntimeApi;
  character: CharacterRuntimeApi & CharacterAssetRuntimeApi;
  persona: PersonaRuntimeApi;
  lorebook: LorebookRuntimeApi;
  script: ScriptRuntimeApi;
  regex: RegexRuntimeApi;
  tts: TtsRuntimeApi;
  stt: SttRuntimeApi;
  imageGen: ImageGenRuntimeApi;
  provider: ProviderRuntimeApi;
  proxy: ProxyRuntimeApi;
  preset: PresetRuntimeApi;
  importExport: ImportExportRuntimeApi;
  asset: AssetRuntimeApi;
  coauthorSkills: CoauthorSkillsRuntimeApi;
  /** Copilot skills (CP-5, AS-8d1) — same wire contract as coauthorSkills,
   * keyed by agent kind: each kind with a skill library answers `?kind=`. */
  copilotSkills: CopilotSkillsByKindRuntimeApi;
  aiAssistant: AiAssistantRuntimeApi;
  settings: SettingsRuntimeApi;
  mobileAccess: MobileAccessRuntimeApi;
  insights: InsightsRuntimeApi;
  dice: DiceRuntimeApi;
  experience: ExperienceRuntimeApi;
  experienceCopilot: ExperienceCopilotRuntimeApi;
  /** Thread proposal resolution (SC-11) — the sidechat objective proposals'
   * apply/reject slice (its own adapter, like every sub-interface). */
  agentThreadProposals: AgentThreadProposalsRuntimeApi;
  copilotProfiles: CopilotProfileRuntimeApi;
  agentPlan: AgentPlanRuntimeApi;
  samplerSets: SamplerSetRuntimeApi;
  formatTemplates: FormatTemplateRuntimeApi;
  aiInstructionTemplates: AiInstructionTemplateRuntimeApi;
}
