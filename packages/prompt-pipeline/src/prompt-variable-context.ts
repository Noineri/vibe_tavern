export interface NamesContext {
  userName: string;
  charName: string;
  groupName?: string | null;
  charIfNotGroup?: string;
  notChar?: string;
}

export interface CharacterVersionPromptContext {
  versionNumber: number;
  title: string;
  cardFormat: string;
  definition: Record<string, unknown>;
}

export interface CharacterPromptContext {
  name: string;
  description: string;
  personality: string | null;
  scenario: string | null;
  firstMessage: string | null;
  alternateGreetings: string[];
  mesExample: string | null;
  postHistoryInstructions: string | null;
  creatorNotes: string | null;
  depthPrompt: string | null;
  depthPromptDepth: number | null;
  depthPromptRole: string | null;
  systemPrompt: string | null;
  version: CharacterVersionPromptContext | null;
  tags: string[];
  characterBook: Record<string, unknown> | null;
  extensions: Record<string, unknown>;
}

export interface PersonaPromptContext {
  name: string;
  description: string;
  pronouns: string | null;
  avatarAssetId: string | null;
}

export interface PromptPresetContext {
  system: string;
  jailbreak: string;
  summary: string;
  tools: string;
  prefill: string | null;
  authorsNote: string | null;
  authorsNoteDepth: number | null;
  customInjections: Array<{
    identifier?: string;
    name: string;
    content: string;
    depth: number;
    role: string;
    enabled: boolean;
    injectionPosition?: 0 | 1 | "relative" | "absolute";
    injectionOrder?: number;
    promptOrderIndex?: number;
    promptOrderPlacement?: "before_chat" | "after_chat";
  }>;
  original: string | null;
  contextBudget: number | null;
  maxResponseTokens: number | null;
  instruct?: Record<string, string | string[] | null>;
}

export interface ChatPromptMessageContext {
  id: string;
  role: string;
  content: string;
}

export interface ChatPromptSwipeContext {
  id: string;
  index: number;
  content: string;
  isSelected: boolean;
}

export interface ChatPromptContext {
  messages: ChatPromptMessageContext[];
  lastMessage: string | null;
  lastUserMessage: string | null;
  lastCharMessage: string | null;
  messageIds: string[];
  swipes: Record<string, ChatPromptSwipeContext[]>;
  activeBranchId: string;
  firstIncludedMessageId: string | null;
  firstDisplayedMessageId: string | null;
  idleDuration: string | null;
}

export interface RuntimePromptContext {
  model: string | null;
  providerType: string | null;
  contextBudget: number | null;
  maxPromptTokens: number | null;
  maxResponseTokens: number | null;
  isMobile: boolean | null;
  lastGenerationType: string | null;
  hasExtension: (extensionName: string) => boolean;
}

export interface TimePromptContext {
  now: Date;
  time: string;
  date: string;
  weekday: string;
  isotime: string;
  isodate: string;
}

export type PromptVariableValue = string | number | boolean | null;

export interface PromptVariableStoreContext {
  local: Record<string, PromptVariableValue>;
  global: Record<string, PromptVariableValue>;
  scopeContract: {
    localScope: "session" | "chat" | "branch" | "character" | "unresolved";
    globalScope: "workspace" | "profile" | "unresolved";
    persistence: "memory" | "sqlite" | "unresolved";
    sideEffectsAllowed: boolean;
  };
}

export interface PromptVariableContext {
  names: NamesContext;
  character: CharacterPromptContext;
  persona: PersonaPromptContext;
  prompt: PromptPresetContext;
  chat: ChatPromptContext;
  runtime: RuntimePromptContext;
  time: TimePromptContext;
  variables: PromptVariableStoreContext;
}

export interface BuildPromptVariableContextInput {
  names?: Partial<NamesContext>;
  character?: Partial<CharacterPromptContext>;
  persona?: Partial<PersonaPromptContext>;
  prompt?: Partial<PromptPresetContext>;
  chat?: Partial<ChatPromptContext>;
  runtime?: Partial<RuntimePromptContext>;
  variables?: Partial<PromptVariableStoreContext>;
  now?: Date;
}

const pad2 = (value: number): string => value.toString().padStart(2, "0");

export function computeTimeContext(now: Date = new Date()): TimePromptContext {
  const yyyy = now.getFullYear().toString();
  const mo = pad2(now.getMonth() + 1);
  const dd = pad2(now.getDate());
  const hh = pad2(now.getHours());
  const mm = pad2(now.getMinutes());
  const isodate = `${yyyy}-${mo}-${dd}`;
  const isotime = `${hh}:${mm}`;

  return {
    now,
    time: isotime,
    date: isodate,
    weekday: now.toLocaleDateString("en-US", { weekday: "long" }),
    isotime,
    isodate,
  };
}

export function buildPromptVariableContext(input: BuildPromptVariableContextInput): PromptVariableContext {
  const userName = input.names?.userName ?? input.persona?.name ?? "";
  const charName = input.names?.charName ?? input.character?.name ?? "";

  return {
    names: {
      userName,
      charName,
      groupName: input.names?.groupName ?? null,
      charIfNotGroup: input.names?.charIfNotGroup ?? charName,
      notChar: input.names?.notChar ?? "",
    },
    character: {
      name: input.character?.name ?? charName,
      description: input.character?.description ?? "",
      personality: input.character?.personality ?? null,
      scenario: input.character?.scenario ?? null,
      firstMessage: input.character?.firstMessage ?? null,
      alternateGreetings: input.character?.alternateGreetings ?? [],
      mesExample: input.character?.mesExample ?? null,
      postHistoryInstructions: input.character?.postHistoryInstructions ?? null,
      creatorNotes: input.character?.creatorNotes ?? null,
      depthPrompt: input.character?.depthPrompt ?? null,
      depthPromptDepth: input.character?.depthPromptDepth ?? null,
      depthPromptRole: input.character?.depthPromptRole ?? null,
      systemPrompt: input.character?.systemPrompt ?? null,
      version: input.character?.version ?? null,
      tags: input.character?.tags ?? [],
      characterBook: input.character?.characterBook ?? null,
      extensions: input.character?.extensions ?? {},
    },
    persona: {
      name: input.persona?.name ?? userName,
      description: input.persona?.description ?? "",
      pronouns: input.persona?.pronouns ?? null,
      avatarAssetId: input.persona?.avatarAssetId ?? null,
    },
    prompt: {
      system: input.prompt?.system ?? "",
      jailbreak: input.prompt?.jailbreak ?? "",
      summary: input.prompt?.summary ?? "",
      tools: input.prompt?.tools ?? "",
      prefill: input.prompt?.prefill ?? null,
      authorsNote: input.prompt?.authorsNote ?? null,
      authorsNoteDepth: input.prompt?.authorsNoteDepth ?? null,
      customInjections: input.prompt?.customInjections ?? [],
      original: input.prompt?.original ?? null,
      contextBudget: input.prompt?.contextBudget ?? null,
      maxResponseTokens: input.prompt?.maxResponseTokens ?? null,
      instruct: input.prompt?.instruct,
    },
    chat: {
      messages: input.chat?.messages ?? [],
      lastMessage: input.chat?.lastMessage ?? null,
      lastUserMessage: input.chat?.lastUserMessage ?? null,
      lastCharMessage: input.chat?.lastCharMessage ?? null,
      messageIds: input.chat?.messageIds ?? [],
      swipes: input.chat?.swipes ?? {},
      activeBranchId: input.chat?.activeBranchId ?? "",
      firstIncludedMessageId: input.chat?.firstIncludedMessageId ?? null,
      firstDisplayedMessageId: input.chat?.firstDisplayedMessageId ?? null,
      idleDuration: input.chat?.idleDuration ?? null,
    },
    runtime: {
      model: input.runtime?.model ?? null,
      providerType: input.runtime?.providerType ?? null,
      contextBudget: input.runtime?.contextBudget ?? input.prompt?.contextBudget ?? null,
      maxPromptTokens: input.runtime?.maxPromptTokens ?? input.prompt?.contextBudget ?? null,
      maxResponseTokens: input.runtime?.maxResponseTokens ?? input.prompt?.maxResponseTokens ?? null,
      isMobile: input.runtime?.isMobile ?? null,
      lastGenerationType: input.runtime?.lastGenerationType ?? null,
      hasExtension: input.runtime?.hasExtension ?? (() => false),
    },
    time: computeTimeContext(input.now),
    variables: {
      local: input.variables?.local ?? {},
      global: input.variables?.global ?? {},
      scopeContract: input.variables?.scopeContract ?? {
        localScope: "unresolved",
        globalScope: "unresolved",
        persistence: "unresolved",
        sideEffectsAllowed: false,
      },
    },
  };
}
