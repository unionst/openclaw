import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { logDebug, logError } from "../logger.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { isPlainObject } from "../utils.js";
import type { ClientToolDefinition } from "./pi-embedded-runner/run/params.js";
import type { HookContext } from "./pi-tools.before-tool-call.js";
import {
  consumeAdjustedParamsForToolCall,
  isToolWrappedWithBeforeToolCallHook,
  runBeforeToolCallHook,
} from "./pi-tools.before-tool-call.js";
import { normalizeToolName } from "./tool-policy.js";
import { jsonResult } from "./tools/common.js";

type AnyAgentTool = AgentTool;

type ToolExecuteArgsCurrent = [
  string,
  unknown,
  AbortSignal | undefined,
  AgentToolUpdateCallback<unknown> | undefined,
  unknown,
];
type ToolExecuteArgsLegacy = [
  string,
  unknown,
  AgentToolUpdateCallback<unknown> | undefined,
  unknown,
  AbortSignal | undefined,
];
type ToolExecuteArgs = ToolDefinition["execute"] extends (...args: infer P) => unknown
  ? P
  : ToolExecuteArgsCurrent;
type ToolExecuteArgsAny = ToolExecuteArgs | ToolExecuteArgsLegacy | ToolExecuteArgsCurrent;

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === "object" && value !== null && "aborted" in value;
}

function isLegacyToolExecuteArgs(args: ToolExecuteArgsAny): args is ToolExecuteArgsLegacy {
  const third = args[2];
  const fifth = args[4];
  if (typeof third === "function") {
    return true;
  }
  return isAbortSignal(fifth);
}

function describeToolExecutionError(err: unknown): {
  message: string;
  stack?: string;
} {
  if (err instanceof Error) {
    const message = err.message?.trim() ? err.message : String(err);
    return { message, stack: err.stack };
  }
  return { message: String(err) };
}

function splitToolExecuteArgs(args: ToolExecuteArgsAny): {
  toolCallId: string;
  params: unknown;
  onUpdate: AgentToolUpdateCallback<unknown> | undefined;
  signal: AbortSignal | undefined;
} {
  if (isLegacyToolExecuteArgs(args)) {
    const [toolCallId, params, onUpdate, _ctx, signal] = args;
    return {
      toolCallId,
      params,
      onUpdate,
      signal,
    };
  }
  const [toolCallId, params, signal, onUpdate] = args;
  return {
    toolCallId,
    params,
    onUpdate,
    signal,
  };
}

// Tools filtered out in compact mode — only available to subagents.
const COMPACT_EXCLUDED_TOOLS = new Set(["exec", "browser", "web_search", "web_fetch", "process"]);

// Minimal tool schemas for compact mode. Short descriptions, required params only.
// These replace the full schemas to reduce token usage for models like Hermes 4 405B.
const COMPACT_TOOL_SCHEMAS: Record<
  string,
  { description: string; parameters: Record<string, unknown> }
> = {
  read: {
    description: "Read file contents.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
    },
  },
  write: {
    description: "Write content to file.",
    parameters: {
      type: "object",
      required: ["content"],
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
    },
  },
  edit: {
    description: "Edit file by replacing text.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
      },
    },
  },
  message: {
    description: "Send iMessage. Actions: send, react, reply, sendAttachment.",
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["send", "react", "unsend", "reply", "sendWithEffect", "sendAttachment"],
        },
        target: { type: "string" },
        message: { type: "string" },
        media: { type: "string" },
        filename: { type: "string" },
      },
    },
  },
  memory_search: {
    description: "Search memory files.",
    parameters: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
      },
    },
  },
  memory_get: {
    description: "Read memory file snippet.",
    parameters: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" },
        from: { type: "number" },
        lines: { type: "number" },
      },
    },
  },
  sessions_spawn: {
    description: "Spawn a sub-agent session for complex tasks.",
    parameters: {
      type: "object",
      required: ["task"],
      properties: {
        task: { type: "string" },
        agentId: { type: "string" },
      },
    },
  },
  subagents: {
    description: "List, steer, or kill sub-agent runs.",
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string" },
        sessionId: { type: "string" },
      },
    },
  },
  cron: {
    description: "Manage cron jobs and reminders.",
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string" },
        schedule: { type: "string" },
        systemEvent: { type: "string" },
      },
    },
  },
};

export type ToToolDefinitionsOptions = {
  /** When true, use minimal schemas and filter out complex tools. */
  compact?: boolean;
};

export function toToolDefinitions(
  tools: AnyAgentTool[],
  options?: ToToolDefinitionsOptions,
): ToolDefinition[] {
  const compact = options?.compact ?? false;

  // Filter out complex tools in compact mode
  const filteredTools = compact
    ? tools.filter((tool) => !COMPACT_EXCLUDED_TOOLS.has(normalizeToolName(tool.name)))
    : tools;

  return filteredTools.map((tool) => {
    const name = tool.name || "tool";
    const normalizedName = normalizeToolName(name);
    const beforeHookWrapped = isToolWrappedWithBeforeToolCallHook(tool);

    // In compact mode, use minimal schema if available
    const compactSchema = compact ? COMPACT_TOOL_SCHEMAS[normalizedName] : undefined;

    return {
      name,
      label: tool.label ?? name,
      description: compactSchema?.description ?? tool.description ?? "",
      parameters: (compactSchema?.parameters ?? tool.parameters) as ToolDefinition["parameters"],
      execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
        const { toolCallId, params, onUpdate, signal } = splitToolExecuteArgs(args);
        let executeParams = params;
        try {
          if (!beforeHookWrapped) {
            const hookOutcome = await runBeforeToolCallHook({
              toolName: name,
              params,
              toolCallId,
            });
            if (hookOutcome.blocked) {
              throw new Error(hookOutcome.reason);
            }
            executeParams = hookOutcome.params;
          }
          const result = await tool.execute(toolCallId, executeParams, signal, onUpdate);
          const afterParams = beforeHookWrapped
            ? (consumeAdjustedParamsForToolCall(toolCallId) ?? executeParams)
            : executeParams;

          // Call after_tool_call hook
          const hookRunner = getGlobalHookRunner();
          if (hookRunner?.hasHooks("after_tool_call")) {
            try {
              await hookRunner.runAfterToolCall(
                {
                  toolName: name,
                  params: isPlainObject(afterParams) ? afterParams : {},
                  result,
                },
                { toolName: name },
              );
            } catch (hookErr) {
              logDebug(
                `after_tool_call hook failed: tool=${normalizedName} error=${String(hookErr)}`,
              );
            }
          }

          return result;
        } catch (err) {
          if (signal?.aborted) {
            throw err;
          }
          const name =
            err && typeof err === "object" && "name" in err
              ? String((err as { name?: unknown }).name)
              : "";
          if (name === "AbortError") {
            throw err;
          }
          if (beforeHookWrapped) {
            consumeAdjustedParamsForToolCall(toolCallId);
          }
          const described = describeToolExecutionError(err);
          if (described.stack && described.stack !== described.message) {
            logDebug(`tools: ${normalizedName} failed stack:\n${described.stack}`);
          }
          logError(`[tools] ${normalizedName} failed: ${described.message}`);

          const errorResult = jsonResult({
            status: "error",
            tool: normalizedName,
            error: described.message,
          });

          // Call after_tool_call hook for errors too
          const hookRunner = getGlobalHookRunner();
          if (hookRunner?.hasHooks("after_tool_call")) {
            try {
              await hookRunner.runAfterToolCall(
                {
                  toolName: normalizedName,
                  params: isPlainObject(params) ? params : {},
                  error: described.message,
                },
                { toolName: normalizedName },
              );
            } catch (hookErr) {
              logDebug(
                `after_tool_call hook failed: tool=${normalizedName} error=${String(hookErr)}`,
              );
            }
          }

          return errorResult;
        }
      },
    } satisfies ToolDefinition;
  });
}

// Convert client tools (OpenResponses hosted tools) to ToolDefinition format
// These tools are intercepted to return a "pending" result instead of executing
export function toClientToolDefinitions(
  tools: ClientToolDefinition[],
  onClientToolCall?: (toolName: string, params: Record<string, unknown>) => void,
  hookContext?: HookContext,
): ToolDefinition[] {
  return tools.map((tool) => {
    const func = tool.function;
    return {
      name: func.name,
      label: func.name,
      description: func.description ?? "",
      parameters: func.parameters as ToolDefinition["parameters"],
      execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
        const { toolCallId, params } = splitToolExecuteArgs(args);
        const outcome = await runBeforeToolCallHook({
          toolName: func.name,
          params,
          toolCallId,
          ctx: hookContext,
        });
        if (outcome.blocked) {
          throw new Error(outcome.reason);
        }
        const adjustedParams = outcome.params;
        const paramsRecord = isPlainObject(adjustedParams) ? adjustedParams : {};
        // Notify handler that a client tool was called
        if (onClientToolCall) {
          onClientToolCall(func.name, paramsRecord);
        }
        // Return a pending result - the client will execute this tool
        return jsonResult({
          status: "pending",
          tool: func.name,
          message: "Tool execution delegated to client",
        });
      },
    } satisfies ToolDefinition;
  });
}
