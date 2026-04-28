import type { ProviderType } from "./types.js";

export type ProviderPresetGroup = "cloud" | "native" | "local";

export interface ProviderPreset {
  id: string;
  label: string;
  type: ProviderType;
  baseUrl: string;
  group: ProviderPresetGroup;
  noApiKey?: boolean;
}

export const PRESET_GROUPS: Array<{ id: ProviderPresetGroup; label: string }> = [
  { id: "cloud", label: "Cloud" },
  { id: "native", label: "Native" },
  { id: "local", label: "Local" },
];

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "openai", label: "OpenAI", type: "openai_compat", baseUrl: "https://api.openai.com/v1", group: "cloud" },
  { id: "openrouter", label: "OpenRouter", type: "openai_compat", baseUrl: "https://openrouter.ai/api/v1", group: "cloud" },
  { id: "deepseek", label: "DeepSeek", type: "openai_compat", baseUrl: "https://api.deepseek.com", group: "cloud" },
  { id: "groq", label: "Groq", type: "openai_compat", baseUrl: "https://api.groq.com/openai/v1", group: "cloud" },
  { id: "xai", label: "xAI", type: "openai_compat", baseUrl: "https://api.x.ai/v1", group: "cloud" },
  { id: "mistral", label: "Mistral AI", type: "openai_compat", baseUrl: "https://api.mistral.ai/v1", group: "cloud" },
  { id: "fireworks", label: "Fireworks", type: "openai_compat", baseUrl: "https://api.fireworks.ai/inference/v1", group: "cloud" },
  { id: "perplexity", label: "Perplexity", type: "openai_compat", baseUrl: "https://api.perplexity.ai", group: "cloud" },
  { id: "moonshot", label: "Moonshot", type: "openai_compat", baseUrl: "https://api.moonshot.ai/v1", group: "cloud" },
  { id: "ai21", label: "AI21", type: "openai_compat", baseUrl: "https://api.ai21.com/studio/v1", group: "cloud" },
  { id: "nanogpt", label: "NanoGPT", type: "openai_compat", baseUrl: "https://nano-gpt.com/api/v1", group: "cloud" },
  { id: "chutes", label: "Chutes", type: "openai_compat", baseUrl: "https://llm.chutes.ai/v1", group: "cloud" },
  { id: "electronhub", label: "ElectronHub", type: "openai_compat", baseUrl: "https://api.electronhub.ai/v1", group: "cloud" },
  { id: "zai", label: "ZAI", type: "openai_compat", baseUrl: "https://api.z.ai/api/paas/v4", group: "cloud" },
  { id: "siliconflow", label: "SiliconFlow", type: "openai_compat", baseUrl: "https://api.siliconflow.com/v1", group: "cloud" },
  { id: "togetherai", label: "Together AI", type: "openai_compat", baseUrl: "https://api.together.xyz/v1", group: "cloud" },
  { id: "pollinations", label: "Pollinations", type: "openai_compat", baseUrl: "https://gen.pollinations.ai/v1", group: "cloud" },
  { id: "anthropic", label: "Anthropic Claude", type: "anthropic", baseUrl: "https://api.anthropic.com/v1", group: "native" },
  { id: "google", label: "Google AI Studio", type: "google", baseUrl: "https://generativelanguage.googleapis.com", group: "native" },
  { id: "ollama", label: "Ollama", type: "ollama", baseUrl: "http://localhost:11434", group: "local", noApiKey: true },
  { id: "llamacpp", label: "llama.cpp server", type: "llamacpp", baseUrl: "http://localhost:8080", group: "local", noApiKey: true },
  { id: "koboldcpp", label: "KoboldCPP", type: "koboldcpp", baseUrl: "http://localhost:5001", group: "local", noApiKey: true },
  { id: "vllm", label: "vLLM", type: "openai_compat", baseUrl: "http://localhost:8000/v1", group: "local", noApiKey: true },
  { id: "ooba", label: "text-generation-webui", type: "openai_compat", baseUrl: "http://localhost:5000/v1", group: "local", noApiKey: true },
  { id: "tabby", label: "TabbyAPI", type: "openai_compat", baseUrl: "http://localhost:5000/v1", group: "local", noApiKey: true },
  { id: "aphrodite", label: "Aphrodite", type: "openai_compat", baseUrl: "http://localhost:2242/v1", group: "local", noApiKey: true },
];
