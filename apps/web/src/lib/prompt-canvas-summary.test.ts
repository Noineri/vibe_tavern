import { describe, expect, mock, test } from "bun:test";
import {
  loadPromptCanvasSummaries,
  type PromptCanvasSummaryLoadDeps,
} from "./prompt-canvas-summary.js";

type SummarySourceRecord = Awaited<ReturnType<PromptCanvasSummaryLoadDeps["listChatSummaries"]>>[number];

function record(overrides: Partial<SummarySourceRecord> = {}): SummarySourceRecord {
  return {
    id: "s1",
    label: "Summary 1",
    content: "The heroes rested.",
    source: "manual",
    summarizedFrom: 0,
    summarizedTo: 10,
    includeInContext: true,
    branchId: "branch-1",
    ...overrides,
  };
}

function deps(records: SummarySourceRecord[]): PromptCanvasSummaryLoadDeps {
  return {
    listChatSummaries: mock(async () => records as never),
  };
}

describe("loadPromptCanvasSummaries", () => {
  test("keeps branch-scoped includable summaries and drops the rest", async () => {
    const api = deps([
      record({ id: "s1", branchId: "branch-1", content: "A", includeInContext: true }),
      record({ id: "s2", branchId: "branch-1", content: "B", includeInContext: false }),
      record({ id: "s3", branchId: "branch-1", content: "   ", includeInContext: true }),
      record({ id: "s4", branchId: "branch-2", content: "C", includeInContext: true }),
    ]);

    const result = await loadPromptCanvasSummaries(
      { chatId: "chat-1", branchId: "branch-1" },
      api,
    );

    expect(api.listChatSummaries).toHaveBeenCalledWith("chat-1");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: "s1",
      label: "Summary 1",
      content: "A",
      source: "manual",
      summarizedFrom: 0,
      summarizedTo: 10,
      includeInContext: true,
    });
  });

  test("falls back to the legacy chat.summary when no includable records exist", async () => {
    const api = deps([]);
    const result = await loadPromptCanvasSummaries(
      { chatId: "chat-1", branchId: "branch-1", legacySummary: "Legacy prose." },
      api,
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      source: "legacy",
      content: "Legacy prose.",
      label: "chat",
    });
  });

  test("returns [] when neither records nor a legacy summary exist", async () => {
    const api = deps([]);
    const result = await loadPromptCanvasSummaries(
      { chatId: "chat-1", branchId: "branch-1" },
      api,
    );
    expect(result).toEqual([]);
  });

  test("ignores branch filter when branchId is null", async () => {
    const api = deps([
      record({ id: "s1", branchId: "branch-1", content: "A", includeInContext: true }),
      record({ id: "s2", branchId: "branch-2", content: "B", includeInContext: true }),
    ]);

    const result = await loadPromptCanvasSummaries(
      { chatId: "chat-1", branchId: null },
      api,
    );

    expect(result).toHaveLength(2);
  });
});
