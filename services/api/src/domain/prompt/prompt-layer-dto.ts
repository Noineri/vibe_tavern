import type { PromptLayerDto } from "@vibe-tavern/domain";

export function mapPromptLayerDto(layer: {
  id: string;
  sourceType: string;
  sourceId: string;
  sourceName: string;
  position: "before_prompt" | "in_prompt" | "in_chat" | "hidden_system";
  priority: number;
  enabled: boolean;
  reason: string;
  tokenCount: number;
  text: string;
  injectionDepth?: number;
  modes?: string[];
}): PromptLayerDto {
  return {
    id: layer.id,
    sourceType: layer.sourceType,
    sourceId: layer.sourceId,
    sourceName: layer.sourceName,
    position: layer.position,
    priority: layer.priority,
    enabled: layer.enabled,
    reason: layer.reason,
    tokenCount: layer.tokenCount,
    text: layer.text,
    injectionDepth: layer.injectionDepth,
    modes: layer.modes,
  };
}
