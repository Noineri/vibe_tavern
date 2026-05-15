/**
 * Tool calling foundation for the AI SDK execution boundary (FW-AI6).
 *
 * Provides a typed tool registry where tools are defined with JSON-schema
 * parameters, a description, and a sandboxed executor function. The registry
 * is injected into the streaming provider executor when the active tool
 * profile is not `disabled`.
 *
 * Design constraints:
 * - Tools are never hardcoded inline in generation code.
 * - Tool execution is gated by {@link ToolProfileMode}.
 * - User-defined tools cannot access filesystem/network unless explicitly
 *   granted via capability flags (future).
 * - All tool calls have a timeout and produce normalized results.
 */

import type { z } from "zod";
import type { RawToolCall as RawToolCallBase } from "./provider-execution-types.js";

// Re-export RawToolCall from the canonical location.
export type { RawToolCallBase as RawToolCall };

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

/**
 * A registered tool with schema, metadata, and executor.
 *
 * @typeParam T - Zod schema type for the tool's parameters.
 */
export interface ToolDefinition<T extends z.ZodType = z.ZodType> {
  /** Unique tool name (e.g. "roll_dice", "get_weather"). */
  name: string;
  /** Human-readable description sent to the LLM. */
  description: string;
  /** Zod schema for validating tool call parameters. */
  parameters: T;
  /**
   * Executes the tool with validated parameters.
   *
   * Must be pure/sandboxed — no filesystem, no network, no side effects
   * outside the tool's declared capabilities.
   */
  execute: (params: z.infer<T>) => Promise<ToolResult>;
}

/**
 * Normalized result from a tool execution.
 */
export interface ToolResult {
  /** The result content to send back to the LLM. */
  content: string;
  /** If true, the tool call failed but the error is recoverable. */
  isError?: boolean;
  /** Optional metadata for debugging / trace. */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tool call from the LLM
// ---------------------------------------------------------------------------

// RawToolCall is re-exported from provider-execution-types.js above.

/**
 * Result of executing a single tool call.
 */
export interface ExecutedToolCall {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: ToolResult;
  /** Execution time in milliseconds. */
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Central registry for tool definitions.
 *
 * Tools are registered at startup and resolved by name during generation.
 * The registry is immutable after registration — no dynamic add/remove during
 * a generation pass.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  /** Register a tool definition. Throws on duplicate name. */
  register<T extends z.ZodType>(tool: ToolDefinition<T>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered.`);
    }
    this.tools.set(tool.name, tool as unknown as ToolDefinition);
  }

  /** Look up a tool by name. Returns undefined if not found. */
  resolve(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** List all registered tool definitions. */
  listAll(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** Check if a tool is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Number of registered tools. */
  get size(): number {
    return this.tools.size;
  }
}
