import { PROVIDER_PRESET_GROUP, PROVIDER_TYPE } from "@vibe-tavern/domain";
import type { ProviderPresetGroup } from "@vibe-tavern/domain";

export interface ProviderPreset {
  id: string;
  label: string;
  type: string;
  baseUrl: string;
  group: ProviderPresetGroup;
  noApiKey?: boolean;
  requiresAuthForModels?: boolean;
}

export const PRESET_GROUPS: Array<{ id: ProviderPresetGroup; label: string }> = [
  { id: PROVIDER_PRESET_GROUP.cloud, label: "Cloud" },
  { id: PROVIDER_PRESET_GROUP.native, label: "Native" },
  { id: PROVIDER_PRESET_GROUP.local, label: "Local" },
];

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "openai", label: "OpenAI", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.openai.com/v1", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "openrouter", label: "OpenRouter", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://openrouter.ai/api/v1", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "deepseek", label: "DeepSeek", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.deepseek.com", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "groq", label: "Groq", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.groq.com/openai/v1", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "xai", label: "xAI", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.x.ai/v1", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "mistral", label: "Mistral AI", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.mistral.ai/v1", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "fireworks", label: "Fireworks", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.fireworks.ai/inference/v1", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "perplexity", label: "Perplexity", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.perplexity.ai", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "moonshot", label: "Moonshot", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.moonshot.ai/v1", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "ai21", label: "AI21", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.ai21.com/studio/v1", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "mimo", label: "Xiaomi MiMo", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.xiaomimimo.com/v1", group: PROVIDER_PRESET_GROUP.cloud, requiresAuthForModels: true },
  { id: "nanogpt", label: "NanoGPT", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://nano-gpt.com/api/v1", group: PROVIDER_PRESET_GROUP.cloud, requiresAuthForModels: true },
  { id: "chutes", label: "Chutes", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://llm.chutes.ai/v1", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "electronhub", label: "ElectronHub", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.electronhub.ai/v1", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "zai", label: "ZAI", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.z.ai/api/paas/v4", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "zai-coding", label: "ZAI Coding", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.z.ai/api/coding/paas/v4", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "siliconflow", label: "SiliconFlow", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.siliconflow.com/v1", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "togetherai", label: "Together AI", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.together.xyz/v1", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "pollinations", label: "Pollinations", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://gen.pollinations.ai/v1", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "anthropic", label: "Anthropic Claude", type: PROVIDER_TYPE.anthropic, baseUrl: "https://api.anthropic.com/v1", group: PROVIDER_PRESET_GROUP.native, requiresAuthForModels: true },
  { id: "google", label: "Google AI Studio", type: PROVIDER_TYPE.google, baseUrl: "https://generativelanguage.googleapis.com", group: PROVIDER_PRESET_GROUP.native, requiresAuthForModels: true },
  { id: "ollama", label: "Ollama", type: PROVIDER_TYPE.ollama, baseUrl: "http://localhost:11434", group: PROVIDER_PRESET_GROUP.local, noApiKey: true },
  { id: "llamacpp", label: "llama.cpp server", type: PROVIDER_TYPE.llamaCpp, baseUrl: "http://localhost:8080", group: PROVIDER_PRESET_GROUP.local, noApiKey: true },
  { id: "koboldcpp", label: "KoboldCPP", type: PROVIDER_TYPE.koboldCpp, baseUrl: "http://localhost:5001", group: PROVIDER_PRESET_GROUP.local, noApiKey: true },
  { id: "vllm", label: "vLLM", type: PROVIDER_TYPE.openaiCompat, baseUrl: "http://localhost:8000/v1", group: PROVIDER_PRESET_GROUP.local, noApiKey: true },
  { id: "ooba", label: "text-generation-webui", type: PROVIDER_TYPE.openaiCompat, baseUrl: "http://localhost:5000/v1", group: PROVIDER_PRESET_GROUP.local, noApiKey: true },
  { id: "tabby", label: "TabbyAPI", type: PROVIDER_TYPE.openaiCompat, baseUrl: "http://localhost:5000/v1", group: PROVIDER_PRESET_GROUP.local, noApiKey: true },
  { id: "aphrodite", label: "Aphrodite", type: PROVIDER_TYPE.openaiCompat, baseUrl: "http://localhost:2242/v1", group: PROVIDER_PRESET_GROUP.local, noApiKey: true },
];

export const TYPE_LABELS: Record<string, string> = {
  [PROVIDER_TYPE.openaiCompat]: "OpenAI Compat",
  [PROVIDER_TYPE.anthropic]: "Anthropic",
  [PROVIDER_TYPE.google]: "Google API",
  [PROVIDER_TYPE.ollama]: "Ollama",
  [PROVIDER_TYPE.llamaCpp]: "llama.cpp",
  [PROVIDER_TYPE.koboldCpp]: "KoboldCPP",
};

export function getPresetGroup(presetId: string): ProviderPresetGroup | null {
  return PROVIDER_PRESETS.find((f) => f.id === presetId)?.group ?? null;
}
