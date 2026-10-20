import { brandId, effectiveContextBudget } from "@vibe-tavern/domain";
import type { AssemblePromptResponse, ChatId, StoredProviderProfileRecord } from "@vibe-tavern/domain";
import type { ToolSet } from "ai";

interface ResolvedReplyProvider {
  profile: StoredProviderProfileRecord;
  model: string;
}

interface ReplyPromptRuntime {
  assemblePromptPreview(
    chatId: ChatId,
    options: {
      model: string;
      contextBudget?: number | null;
      responseReserve?: number;
      setPendingTrace?: boolean;
    },
  ): Promise<AssemblePromptResponse & {
    tools?: ToolSet;
    maxSteps?: number;
    coauthorModuleId?: string;
    coauthorSkillId?: string | null;
  }>;
}

export async function assembleReplyPrompt(
  chatRuntime: ReplyPromptRuntime,
  provider: ResolvedReplyProvider,
  chatId: string,
  withTokenContext: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<Awaited<ReturnType<ReplyPromptRuntime["assemblePromptPreview"]>>> {
  return await withTokenContext(() =>
    chatRuntime.assemblePromptPreview(brandId<ChatId>(chatId), {
      setPendingTrace: true,
      model: provider.model,
      contextBudget: effectiveContextBudget(provider.profile.contextBudget, provider.profile.tokenPadding),
      responseReserve: provider.profile.maxTokens,
    }),
  );
}
