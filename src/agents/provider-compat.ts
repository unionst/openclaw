import { randomUUID } from "node:crypto";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  StopReason,
  TextContent,
  ToolCall,
  Usage,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { ModelProviderConfig, ProviderCompatConfig } from "../config/types.models.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agent/provider-compat");

export type { ProviderCompatConfig };

// ── OpenAI-compatible types (subset we care about) ──────────────────────────

interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIChatResponse {
  id: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenAIToolCall[];
      reasoning_content?: string | null;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ── Message conversion ──────────────────────────────────────────────────────

type InputContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return (content as InputContentPart[])
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function extractToolCalls(content: unknown): OpenAIToolCall[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const parts = content as InputContentPart[];
  const result: OpenAIToolCall[] = [];
  for (const part of parts) {
    if (part.type === "toolCall") {
      result.push({
        id: part.id,
        type: "function",
        function: {
          name: part.name,
          arguments: JSON.stringify(part.arguments),
        },
      });
    } else if (part.type === "tool_use") {
      result.push({
        id: part.id,
        type: "function",
        function: {
          name: part.name,
          arguments: JSON.stringify(part.input),
        },
      });
    }
  }
  return result;
}

function convertToOpenAIMessages(
  messages: Array<{ role: string; content: unknown; [k: string]: unknown }>,
  system?: string,
): OpenAIChatMessage[] {
  const result: OpenAIChatMessage[] = [];

  if (system) {
    result.push({ role: "system", content: system });
  }

  for (const msg of messages) {
    const { role } = msg;

    if (role === "user") {
      result.push({ role: "user", content: extractTextContent(msg.content) });
    } else if (role === "assistant") {
      const text = extractTextContent(msg.content);
      const toolCalls = extractToolCalls(msg.content);
      result.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else if (role === "tool" || role === "toolResult") {
      const text = extractTextContent(msg.content);
      const toolCallId =
        typeof (msg as { toolCallId?: unknown }).toolCallId === "string"
          ? (msg as { toolCallId?: string }).toolCallId
          : `unknown_${randomUUID()}`;
      result.push({
        role: "tool",
        content: text,
        tool_call_id: toolCallId,
      });
    }
  }

  return result;
}

// ── Tool extraction ─────────────────────────────────────────────────────────

type AgentTool = { name: string; description?: string; parameters?: Record<string, unknown> };

function extractOpenAITools(tools: AgentTool[] | undefined): OpenAITool[] {
  if (!tools || !Array.isArray(tools)) {
    return [];
  }
  const result: OpenAITool[] = [];
  for (const tool of tools) {
    if (typeof tool.name !== "string" || !tool.name) {
      continue;
    }
    result.push({
      type: "function",
      function: {
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: tool.parameters ?? {},
      },
    });
  }
  return result;
}

// ── Argument unwrapping ─────────────────────────────────────────────────────

/**
 * Nous Portal / vLLM non-streaming returns tool call arguments as
 * double-encoded JSON strings (a JSON string containing a JSON string).
 * This unwraps one layer when detected.
 */
function unwrapToolCallArgs(toolCalls: OpenAIToolCall[] | undefined): OpenAIToolCall[] | undefined {
  if (!toolCalls) {
    return toolCalls;
  }
  return toolCalls.map((tc) => {
    let args = tc.function.arguments;
    // Try to parse — if it's a string that itself parses to a string, unwrap again
    try {
      const parsed = JSON.parse(args);
      if (typeof parsed === "string") {
        // Double-encoded: the parsed result is itself a JSON string
        args = parsed;
      }
    } catch {
      // Not valid JSON, leave as-is
    }
    return {
      ...tc,
      function: {
        ...tc.function,
        arguments: args,
      },
    };
  });
}

// ── Text post-processing ────────────────────────────────────────────────────

/**
 * Strip reasoning content that Hermes-style models emit before their actual
 * response. Handles both well-formed `<think>...</think>` and malformed
 * variants (e.g. `<tool_call>...</think>`) where the model hallucinates
 * the opening tag but still closes with `</think>`.
 */
function stripThinkingBlock(text: string): string {
  if (!text) {
    return text;
  }
  // Fast path: no closing think tag means nothing to strip
  const closeIdx = text.lastIndexOf("</think>");
  if (closeIdx === -1) {
    return text;
  }
  // Strip everything up to and including the last </think>
  return text.slice(closeIdx + "</think>".length).trim();
}

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

/**
 * Extract `<tool_call>` blocks from text content. Hermes-style models
 * sometimes emit tool calls as `<tool_call>{"name":...,"arguments":...}</tool_call>`
 * in the text instead of structured `tool_calls`. This extracts them and
 * returns the remaining text plus parsed tool calls.
 */
function extractInlineToolCalls(text: string): {
  remainingText: string;
  toolCalls: OpenAIToolCall[];
} {
  if (!text || !text.includes("<tool_call>")) {
    return { remainingText: text, toolCalls: [] };
  }

  const toolCalls: OpenAIToolCall[] = [];
  const remainingText = text
    .replace(TOOL_CALL_RE, (_match, jsonStr: string) => {
      try {
        const parsed = JSON.parse(jsonStr.trim());
        if (parsed.name) {
          toolCalls.push({
            id: `inline_call_${randomUUID()}`,
            type: "function",
            function: {
              name: parsed.name,
              arguments:
                typeof parsed.arguments === "string"
                  ? parsed.arguments
                  : JSON.stringify(parsed.arguments ?? {}),
            },
          });
        }
      } catch {
        log.warn(`Failed to parse inline <tool_call>: ${jsonStr.slice(0, 200)}`);
      }
      return "";
    })
    .trim();

  return { remainingText, toolCalls };
}

// ── Response conversion ─────────────────────────────────────────────────────

function buildAssistantMessage(
  response: OpenAIChatResponse,
  modelInfo: { api: string; provider: string; id: string },
  compat: ProviderCompatConfig,
): AssistantMessage {
  const choice = response.choices?.[0];
  if (!choice) {
    throw new Error("OpenAI-compat API returned no choices");
  }

  const content: (TextContent | ToolCall)[] = [];

  const rawText = choice.message.content || "";
  const afterThinking = stripThinkingBlock(rawText);
  const { remainingText: text, toolCalls: inlineToolCalls } = extractInlineToolCalls(afterThinking);
  if (text) {
    content.push({ type: "text", text });
  }

  // vLLM thinking mode puts tool calls in reasoning_content as <tool_call> XML
  const reasoningText = choice.message.reasoning_content || "";
  const { toolCalls: reasoningToolCalls } = extractInlineToolCalls(reasoningText);

  let toolCalls = [...(choice.message.tool_calls ?? []), ...inlineToolCalls, ...reasoningToolCalls];
  if (compat.unwrapToolArgs) {
    toolCalls = unwrapToolCallArgs(toolCalls) ?? [];
  }
  if (toolCalls.length > 0) {
    for (const tc of toolCalls) {
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(tc.function.arguments);
      } catch {
        log.warn(
          `Failed to parse tool call arguments for ${tc.function.name}: ${tc.function.arguments}`,
        );
      }
      content.push({
        type: "toolCall",
        id: tc.id || `compat_call_${randomUUID()}`,
        name: tc.function.name,
        arguments: parsedArgs,
      });
    }
  }

  const hasToolCalls = toolCalls && toolCalls.length > 0;
  const stopReason: StopReason = hasToolCalls ? "toolUse" : "stop";

  const usage: Usage = {
    input: response.usage?.prompt_tokens ?? 0,
    output: response.usage?.completion_tokens ?? 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: response.usage?.total_tokens ?? 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  return {
    role: "assistant",
    content,
    stopReason,
    api: modelInfo.api,
    provider: modelInfo.provider,
    model: modelInfo.id,
    usage,
    timestamp: Date.now(),
  };
}

// ── StreamFn factory ────────────────────────────────────────────────────────

/**
 * Create a StreamFn that bypasses the SDK's streaming and makes direct
 * OpenAI-compatible API calls with `stream: false`. Designed for providers
 * (like Nous Portal / vLLM) whose streaming returns raw XML instead of
 * structured tool_calls.
 *
 * This follows the same pattern as `createOllamaStreamFn` — returns a
 * `StreamFn` that makes a direct HTTP call and emits the result as a
 * single "done" event.
 */
export function createProviderCompatStreamFn(
  baseUrl: string,
  modelId: string,
  compat: ProviderCompatConfig,
): StreamFn {
  const chatUrl = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      try {
        const openaiMessages = convertToOpenAIMessages(
          (context.messages ?? []) as Array<{ role: string; content: unknown }>,
          context.systemPrompt,
        );

        const openaiTools = extractOpenAITools(context.tools as AgentTool[] | undefined);

        const body: Record<string, unknown> = {
          model: modelId,
          messages: openaiMessages,
          stream: false,
        };
        if (openaiTools.length > 0) {
          body.tools = openaiTools;
        }
        if (typeof options?.temperature === "number") {
          body.temperature = options.temperature;
        }
        if (typeof options?.maxTokens === "number") {
          body.max_tokens = options.maxTokens;
        }

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          ...options?.headers,
        };
        if (options?.apiKey) {
          headers.Authorization = `Bearer ${options.apiKey}`;
        }

        log.debug(
          `[provider-compat] POST ${chatUrl} model=${modelId} msgs=${openaiMessages.length} tools=${openaiTools.length} stream=false`,
        );

        const response = await fetch(chatUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: options?.signal,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "unknown error");
          throw new Error(`OpenAI-compat API error ${response.status}: ${errorText}`);
        }

        const json = (await response.json()) as OpenAIChatResponse;

        const assistantMessage = buildAssistantMessage(
          json,
          {
            api: model.api,
            provider: model.provider,
            id: model.id,
          },
          compat,
        );

        const reason: Extract<StopReason, "stop" | "length" | "toolUse"> =
          assistantMessage.stopReason === "toolUse" ? "toolUse" : "stop";

        stream.push({
          type: "done",
          reason,
          message: assistantMessage,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.error(`[provider-compat] error: ${errorMessage}`);
        stream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant" as const,
            content: [],
            stopReason: "error" as StopReason,
            errorMessage,
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
          },
        });
      } finally {
        stream.end();
      }
    };

    queueMicrotask(() => void run());
    return stream;
  };
}

// ── Provider config helper ──────────────────────────────────────────────────

/**
 * Read ProviderCompatConfig from a provider config object.
 */
export function resolveProviderCompat(
  providerConfig: ModelProviderConfig | undefined,
): ProviderCompatConfig | null {
  if (!providerConfig?.providerCompat) {
    return null;
  }
  const pc = providerConfig.providerCompat;
  if (!pc.disableStreaming && !pc.unwrapToolArgs) {
    return null;
  }
  return pc;
}
