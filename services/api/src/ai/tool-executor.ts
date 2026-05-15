/**
 * Safe tool call executor for the AI SDK tool-calling loop (FW-AI6).
 *
 * Executes tool calls resolved from the {@link ToolRegistry} with:
 * - Zod schema validation of LLM-provided arguments
 * - Timeout enforcement (no infinite hangs)
 * - Normalized error results (never throws into the generation loop)
 * - Structured logging for debugging
 */

import type { ToolRegistry, ExecutedToolCall, ToolResult } from "./tool-registry.js";
import type { RawToolCall } from "./provider-execution-types.js";
import { logSendDebug } from "../send-debug-log.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default timeout for a single tool execution (10 seconds). */
const DEFAULT_TOOL_TIMEOUT_MS = 10_000;

/** Maximum number of tool calls in a single generation turn. */
const DEFAULT_MAX_TOOL_CALLS_PER_TURN = 8;

export interface ToolExecutorConfig {
  /** Per-tool timeout in milliseconds. Defaults to 10000. */
  timeoutMs?: number;
  /** Maximum tool calls per generation turn. Defaults to 8. */
  maxCallsPerTurn?: number;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Executes a batch of tool calls from the LLM against the registry.
 *
 * Returns results for every call — failed validations and timeouts produce
 * error results rather than throwing, so the generation loop can continue.
 */
export async function executeToolCalls(
  calls: RawToolCall[],
  registry: ToolRegistry,
  config: ToolExecutorConfig = {},
): Promise<ExecutedToolCall[]> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const maxCalls = config.maxCallsPerTurn ?? DEFAULT_MAX_TOOL_CALLS_PER_TURN;

  if (calls.length > maxCalls) {
    logSendDebug("tool.execute.truncated", {
      requested: calls.length,
      max: maxCalls,
    });
    calls = calls.slice(0, maxCalls);
  }

  const results = await Promise.all(
    calls.map((call) => executeSingle(call, registry, timeoutMs)),
  );

  logSendDebug("tool.execute.batch-done", {
    count: results.length,
    errors: results.filter((r) => r.result.isError).length,
  });

  return results;
}

// ---------------------------------------------------------------------------
// Single tool execution
// ---------------------------------------------------------------------------

async function executeSingle(
  call: RawToolCall,
  registry: ToolRegistry,
  timeoutMs: number,
): Promise<ExecutedToolCall> {
  const startedAt = Date.now();
  const tool = registry.resolve(call.toolName);

  if (!tool) {
    return {
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      args: call.args,
      result: {
        content: `Unknown tool "${call.toolName}". Available tools: ${registry.listAll().map((t) => t.name).join(", ") || "(none)"}`,
        isError: true,
      },
      latencyMs: Date.now() - startedAt,
    };
  }

  // Validate arguments against schema
  const parsed = tool.parameters.safeParse(call.args);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    logSendDebug("tool.execute.validation-failed", {
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      issues,
    });
    return {
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      args: call.args,
      result: {
        content: `Invalid arguments for "${call.toolName}": ${issues}`,
        isError: true,
      },
      latencyMs: Date.now() - startedAt,
    };
  }

  // Execute with timeout
  try {
    const result = await withTimeout(
      tool.execute(parsed.data),
      timeoutMs,
      `Tool "${call.toolName}" timed out after ${timeoutMs}ms`,
    );

    logSendDebug("tool.execute.done", {
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      latencyMs: Date.now() - startedAt,
      isError: result.isError ?? false,
    });

    return {
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      args: call.args,
      result,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logSendDebug("tool.execute.error", {
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      error: message,
      latencyMs: Date.now() - startedAt,
    });

    return {
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      args: call.args,
      result: {
        content: `Tool "${call.toolName}" failed: ${message}`,
        isError: true,
      },
      latencyMs: Date.now() - startedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
