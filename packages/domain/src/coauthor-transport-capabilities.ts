export const PROVIDER_PRESET_ID = {
  openai: "openai",
  openrouter: "openrouter",
  deepseek: "deepseek",
  groq: "groq",
  xai: "xai",
  mistral: "mistral",
  fireworks: "fireworks",
  perplexity: "perplexity",
  moonshot: "moonshot",
  kimi: "kimi",
  ai21: "ai21",
  mimo: "mimo",
  nanogpt: "nanogpt",
  chutes: "chutes",
  electronhub: "electronhub",
  zai: "zai",
  zaiCoding: "zai-coding",
  siliconflow: "siliconflow",
  togetherai: "togetherai",
  pollinations: "pollinations",
  anthropic: "anthropic",
  google: "google",
  ollama: "ollama",
  llamacpp: "llamacpp",
  koboldcpp: "koboldcpp",
  unsloth: "unsloth",
  vllm: "vllm",
  ooba: "ooba",
  tabby: "tabby",
  aphrodite: "aphrodite",
} as const;

export type ProviderPresetId = typeof PROVIDER_PRESET_ID[keyof typeof PROVIDER_PRESET_ID];

export const COAUTHOR_TRANSPORT = {
  chatCompletions: "chat_completions",
  responses: "responses",
} as const;

export type CoauthorTransport = typeof COAUTHOR_TRANSPORT[keyof typeof COAUTHOR_TRANSPORT];

export const RESPONSES_SUPPORT = {
  supported: "supported",
  versionDependent: "version_dependent",
  unsupported: "unsupported",
} as const;

export type ResponsesSupport = typeof RESPONSES_SUPPORT[keyof typeof RESPONSES_SUPPORT];

export const COAUTHOR_TOOL_PATH = {
  responses: "responses",
  chatCompletions: "chat_completions",
  native: "native",
  conditional: "conditional",
  unsupported: "unsupported",
} as const;

export type CoauthorToolPath = typeof COAUTHOR_TOOL_PATH[keyof typeof COAUTHOR_TOOL_PATH];

export const COAUTHOR_TRANSPORT_CAVEAT = {
  vllmVersionDependent: "vllm_version_dependent",
  pollinationsUpstreamDependent: "pollinations_upstream_dependent",
  tabbyToolsUnsupported: "tabby_tools_unsupported",
} as const;

export type CoauthorTransportCaveat = typeof COAUTHOR_TRANSPORT_CAVEAT[keyof typeof COAUTHOR_TRANSPORT_CAVEAT];

export interface CoauthorTransportCapability {
  responsesSupport: ResponsesSupport;
  toolPath: CoauthorToolPath;
  caveat?: CoauthorTransportCaveat;
}

const responses = {
  responsesSupport: RESPONSES_SUPPORT.supported,
  toolPath: COAUTHOR_TOOL_PATH.responses,
} as const satisfies CoauthorTransportCapability;

const chatCompletions = {
  responsesSupport: RESPONSES_SUPPORT.unsupported,
  toolPath: COAUTHOR_TOOL_PATH.chatCompletions,
} as const satisfies CoauthorTransportCapability;

const native = {
  responsesSupport: RESPONSES_SUPPORT.unsupported,
  toolPath: COAUTHOR_TOOL_PATH.native,
} as const satisfies CoauthorTransportCapability;

/**
 * Explicit transport classification for every user-selectable provider preset.
 * Never infer Responses support from an endpoint or generic OpenAI compatibility.
 */
export const COAUTHOR_TRANSPORT_CAPABILITIES = {
  openai: responses,
  openrouter: responses,
  deepseek: chatCompletions,
  groq: responses,
  xai: responses,
  mistral: chatCompletions,
  fireworks: responses,
  perplexity: responses,
  moonshot: chatCompletions,
  kimi: chatCompletions,
  ai21: chatCompletions,
  mimo: responses,
  nanogpt: responses,
  chutes: chatCompletions,
  electronhub: chatCompletions,
  zai: chatCompletions,
  "zai-coding": chatCompletions,
  siliconflow: chatCompletions,
  togetherai: responses,
  pollinations: {
    responsesSupport: RESPONSES_SUPPORT.unsupported,
    toolPath: COAUTHOR_TOOL_PATH.conditional,
    caveat: COAUTHOR_TRANSPORT_CAVEAT.pollinationsUpstreamDependent,
  },
  anthropic: native,
  google: native,
  ollama: responses,
  llamacpp: responses,
  koboldcpp: responses,
  unsloth: responses,
  vllm: {
    responsesSupport: RESPONSES_SUPPORT.versionDependent,
    toolPath: COAUTHOR_TOOL_PATH.responses,
    caveat: COAUTHOR_TRANSPORT_CAVEAT.vllmVersionDependent,
  },
  ooba: chatCompletions,
  tabby: {
    responsesSupport: RESPONSES_SUPPORT.unsupported,
    toolPath: COAUTHOR_TOOL_PATH.unsupported,
    caveat: COAUTHOR_TRANSPORT_CAVEAT.tabbyToolsUnsupported,
  },
  aphrodite: chatCompletions,
} as const satisfies Record<ProviderPresetId, CoauthorTransportCapability>;

export function getCoauthorTransportCapability(presetId: string): CoauthorTransportCapability | null {
  return Object.hasOwn(COAUTHOR_TRANSPORT_CAPABILITIES, presetId)
    ? COAUTHOR_TRANSPORT_CAPABILITIES[presetId as ProviderPresetId]
    : null;
}

export function isCoauthorTransportAllowed(presetId: string, transport: CoauthorTransport): boolean {
  if (transport === COAUTHOR_TRANSPORT.chatCompletions) return true;
  const capability = getCoauthorTransportCapability(presetId);
  return capability?.responsesSupport === RESPONSES_SUPPORT.supported
    || capability?.responsesSupport === RESPONSES_SUPPORT.versionDependent;
}
