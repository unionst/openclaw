import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  composeProviderStreamWrappers,
  streamWithPayloadPatch,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty, readStringValue } from "openclaw/plugin-sdk/text-runtime";

const log = createSubsystemLogger("vercel-ai-gateway-stream");

const ANTHROPIC_FAST_MODE_BETA = "fast-mode-2026-02-01";
const ANTHROPIC_FAST_MODE_MODEL_PREFIXES = [
  "anthropic/claude-opus-4.6",
  "anthropic/claude-opus-4-6",
] as const;

function isAnthropicFastModeEligibleModel(params: {
  modelId: string | undefined;
  modelApi: string | undefined;
}): boolean {
  if (!params.modelId) {
    return false;
  }
  if (
    params.modelApi &&
    normalizeLowercaseStringOrEmpty(params.modelApi) !== "anthropic-messages"
  ) {
    return false;
  }
  const id = normalizeLowercaseStringOrEmpty(params.modelId);
  return ANTHROPIC_FAST_MODE_MODEL_PREFIXES.some((prefix) => id.startsWith(prefix));
}

function parseHeaderList(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergeAnthropicBetaHeader(
  headers: Record<string, string> | undefined,
  beta: string,
): Record<string, string> {
  const merged = { ...headers };
  const existingKey = Object.keys(merged).find(
    (key) => normalizeLowercaseStringOrEmpty(key) === "anthropic-beta",
  );
  const existing = existingKey ? parseHeaderList(merged[existingKey]) : [];
  const key = existingKey ?? "anthropic-beta";
  merged[key] = Array.from(new Set([...existing, beta])).join(",");
  return merged;
}

function normalizeFastMode(raw?: string | boolean | null): boolean | undefined {
  if (typeof raw === "boolean") {
    return raw;
  }
  if (!raw) {
    return undefined;
  }
  const key = normalizeLowercaseStringOrEmpty(raw);
  if (["off", "false", "no", "0", "disable", "disabled", "normal"].includes(key)) {
    return false;
  }
  if (["on", "true", "yes", "1", "enable", "enabled", "fast"].includes(key)) {
    return true;
  }
  return undefined;
}

export function resolveVercelAiGatewayFastMode(
  extraParams: Record<string, unknown> | undefined,
): boolean | undefined {
  return normalizeFastMode(
    (extraParams?.fastMode ?? extraParams?.fast_mode) as string | boolean | null | undefined,
  );
}

export function createVercelAiGatewayAnthropicFastModeWrapper(
  baseStreamFn: StreamFn | undefined,
  enabled: boolean,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!enabled) {
      return underlying(model, context, options);
    }
    if (
      !isAnthropicFastModeEligibleModel({
        modelId: readStringValue(model.id),
        modelApi: readStringValue(model.api),
      })
    ) {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(
      underlying,
      model,
      context,
      {
        ...options,
        headers: mergeAnthropicBetaHeader(options?.headers, ANTHROPIC_FAST_MODE_BETA),
      },
      (payloadObj) => {
        if (payloadObj.speed === undefined) {
          payloadObj.speed = "fast";
        }
      },
    );
  };
}

export function wrapVercelAiGatewayProviderStream(
  ctx: ProviderWrapStreamFnContext,
): StreamFn | undefined {
  const fastMode = resolveVercelAiGatewayFastMode(ctx.extraParams);
  return composeProviderStreamWrappers(
    ctx.streamFn,
    fastMode === true
      ? (streamFn) => createVercelAiGatewayAnthropicFastModeWrapper(streamFn, true)
      : undefined,
  );
}

export const __testing = { log };
