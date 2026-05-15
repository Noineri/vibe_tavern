import { describe, it, expect } from "bun:test";
import { ToolRegistry, type ToolDefinition } from "../src/ai/tool-registry.js";
import { executeToolCalls } from "../src/ai/tool-executor.js";
import type { RawToolCall } from "../src/ai/provider-execution-types.js";
import { z } from "zod";

// ─── Test tool definitions ────────────────────────────────────────────────

const rollDiceTool: ToolDefinition<z.ZodObject<{ sides: z.ZodNumber }>> = {
  name: "roll_dice",
  description: "Roll a die with the specified number of sides.",
  parameters: z.object({ sides: z.number().int().min(2).max(100) }),
  execute: async (params) => ({
    content: `Rolled a ${Math.floor(Math.random() * params.sides) + 1} (d${params.sides})`,
  }),
};

const echoTool: ToolDefinition<z.ZodObject<{ text: z.ZodString }>> = {
  name: "echo",
  description: "Echo back the provided text.",
  parameters: z.object({ text: z.string() }),
  execute: async (params) => ({
    content: params.text,
  }),
};

const slowTool: ToolDefinition<z.ZodObject<{ ms: z.ZodNumber }>> = {
  name: "slow_tool",
  description: "Takes a long time.",
  parameters: z.object({ ms: z.number() }),
  execute: async (params) => {
    await new Promise((resolve) => setTimeout(resolve, params.ms));
    return { content: "done" };
  },
};

// ─── ToolRegistry ───────────────────────────────────────────────────────

describe("ToolRegistry", () => {
  it("registers and resolves a tool", () => {
    const registry = new ToolRegistry();
    registry.register(rollDiceTool);
    expect(registry.resolve("roll_dice")).toBe(rollDiceTool);
    expect(registry.has("roll_dice")).toBe(true);
    expect(registry.size).toBe(1);
  });

  it("returns undefined for unknown tool", () => {
    const registry = new ToolRegistry();
    expect(registry.resolve("nonexistent")).toBeUndefined();
    expect(registry.has("nonexistent")).toBe(false);
  });

  it("lists all registered tools", () => {
    const registry = new ToolRegistry();
    registry.register(rollDiceTool);
    registry.register(echoTool);
    const all = registry.listAll();
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.name).sort()).toEqual(["echo", "roll_dice"]);
  });

  it("throws on duplicate registration", () => {
    const registry = new ToolRegistry();
    registry.register(rollDiceTool);
    expect(() => registry.register(rollDiceTool)).toThrow("already registered");
  });

  it("starts empty", () => {
    const registry = new ToolRegistry();
    expect(registry.size).toBe(0);
    expect(registry.listAll()).toHaveLength(0);
  });
});

// ─── Tool executor ──────────────────────────────────────────────────────

describe("executeToolCalls", () => {
  it("executes a valid tool call", async () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);

    const calls: RawToolCall[] = [
      { toolCallId: "tc_1", toolName: "echo", args: { text: "hello" } },
    ];

    const results = await executeToolCalls(calls, registry);
    expect(results).toHaveLength(1);
    expect(results[0].toolCallId).toBe("tc_1");
    expect(results[0].toolName).toBe("echo");
    expect(results[0].result.content).toBe("hello");
    expect(results[0].result.isError).toBeFalsy();
    expect(results[0].latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns error result for unknown tool", async () => {
    const registry = new ToolRegistry();

    const calls: RawToolCall[] = [
      { toolCallId: "tc_1", toolName: "nonexistent", args: {} },
    ];

    const results = await executeToolCalls(calls, registry);
    expect(results[0].result.isError).toBe(true);
    expect(results[0].result.content).toContain("Unknown tool");
  });

  it("returns error result for invalid arguments", async () => {
    const registry = new ToolRegistry();
    registry.register(rollDiceTool);

    const calls: RawToolCall[] = [
      { toolCallId: "tc_1", toolName: "roll_dice", args: { sides: "not a number" } },
    ];

    const results = await executeToolCalls(calls, registry);
    expect(results[0].result.isError).toBe(true);
    expect(results[0].result.content).toContain("Invalid arguments");
  });

  it("returns error result for schema-violating args", async () => {
    const registry = new ToolRegistry();
    registry.register(rollDiceTool);

    const calls: RawToolCall[] = [
      { toolCallId: "tc_1", toolName: "roll_dice", args: { sides: 1 } },
    ];

    const results = await executeToolCalls(calls, registry);
    expect(results[0].result.isError).toBe(true);
  });

  it("times out slow tool executions", async () => {
    const registry = new ToolRegistry();
    registry.register(slowTool);

    const calls: RawToolCall[] = [
      { toolCallId: "tc_1", toolName: "slow_tool", args: { ms: 5000 } },
    ];

    const results = await executeToolCalls(calls, registry, { timeoutMs: 50 });
    expect(results[0].result.isError).toBe(true);
    expect(results[0].result.content).toContain("timed out");
  });

  it("executes multiple tool calls in parallel", async () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);

    const calls: RawToolCall[] = [
      { toolCallId: "tc_1", toolName: "echo", args: { text: "a" } },
      { toolCallId: "tc_2", toolName: "echo", args: { text: "b" } },
      { toolCallId: "tc_3", toolName: "echo", args: { text: "c" } },
    ];

    const results = await executeToolCalls(calls, registry);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.result.content).sort()).toEqual(["a", "b", "c"]);
  });

  it("truncates calls exceeding maxCallsPerTurn", async () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);

    const calls: RawToolCall[] = Array.from({ length: 20 }, (_, i) => ({
      toolCallId: `tc_${i}`,
      toolName: "echo",
      args: { text: `msg_${i}` },
    }));

    const results = await executeToolCalls(calls, registry, { maxCallsPerTurn: 3 });
    expect(results).toHaveLength(3);
  });

  it("handles empty call list", async () => {
    const registry = new ToolRegistry();
    const results = await executeToolCalls([], registry);
    expect(results).toHaveLength(0);
  });
});
