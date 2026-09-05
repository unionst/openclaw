import type { AgentMessage } from "@mariozechner/pi-agent-core";

export const PRUNED_HISTORY_IMAGE_MARKER = "[image data removed - already processed by model]";
export const PRUNED_HISTORY_MEDIA_REFERENCE_MARKER =
  "[media reference removed - already processed by model]";

const MEDIA_ATTACHED_HISTORY_REF_PATTERN = /\[media attached(?:\s+\d+\/\d+)?:\s*[^\]]+\]/gi;
const MESSAGE_IMAGE_HISTORY_REF_PATTERN = /\[Image:\s*source:\s*[^\]]+\]/gi;
const INBOUND_MEDIA_URI_HISTORY_REF_PATTERN = /\bmedia:\/\/inbound\/[^\]\s/\\]+/g;

type PrunableContextAgent = {
  transformContext?: (
    messages: AgentMessage[],
    signal?: AbortSignal,
  ) => AgentMessage[] | Promise<AgentMessage[]>;
};

export type HistoryImagePruneCacheRetention = "none" | "short" | "long";

type PruneBoundaryStore = {
  appendCustomEntry?: (customType: string, data: unknown) => void;
  getEntries?: () => Array<{ type?: unknown; customType?: unknown; data?: unknown }>;
};

/**
 * Decides where the prune boundary sits for this request. Every prune rewrites
 * an old message, which invalidates every cached prefix that extends past it,
 * so while the provider prompt cache is warm the boundary stays where it was
 * on the last cold request instead of advancing one turn per call. It moves
 * again once the cache has gone cold (the rewrite is free) or once enough
 * prunable turns have piled up behind it to justify one deliberate rewrite.
 */
export type HistoryImagePrunePolicy = {
  cacheRetention?: HistoryImagePruneCacheRetention;
  lastCacheTouchAt?: number | null;
  maxDeferredImageTurns?: number;
  sessionManager?: PruneBoundaryStore;
  now?: number;
};

export const DEFAULT_MAX_DEFERRED_IMAGE_TURNS = 8;
export const HISTORY_IMAGE_PRUNE_BOUNDARY_CUSTOM_TYPE = "openclaw.image-prune-boundary";

const CACHE_RETENTION_TTL_MS: Record<HistoryImagePruneCacheRetention, number> = {
  none: 0,
  short: 5 * 60 * 1000,
  long: 60 * 60 * 1000,
};

export function resolveHistoryImagePruneCacheTtlMs(
  retention: HistoryImagePruneCacheRetention | undefined,
): number {
  return retention ? CACHE_RETENTION_TTL_MS[retention] : 0;
}

function isPromptCacheWarm(policy: HistoryImagePrunePolicy, now: number): boolean {
  const ttlMs = resolveHistoryImagePruneCacheTtlMs(policy.cacheRetention);
  if (ttlMs <= 0) {
    return false;
  }
  const lastTouch = policy.lastCacheTouchAt;
  if (typeof lastTouch !== "number" || !Number.isFinite(lastTouch)) {
    return false;
  }
  return now - lastTouch < ttlMs;
}

function messageCarriesPrunableMedia(message: AgentMessage | undefined): boolean {
  if (!message || (message.role !== "user" && message.role !== "toolResult")) {
    return false;
  }
  if (typeof message.content === "string") {
    return pruneHistoryMediaReferenceText(message.content) !== message.content;
  }
  if (!Array.isArray(message.content)) {
    return false;
  }
  return message.content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const blockType = (block as { type?: string }).type;
    if (blockType === "image") {
      return true;
    }
    if (blockType === "text" && typeof (block as { text?: unknown }).text === "string") {
      const text = (block as { text: string }).text;
      return pruneHistoryMediaReferenceText(text) !== text;
    }
    return false;
  });
}

function countPrunableMediaTurns(messages: AgentMessage[], from: number, to: number): number {
  let count = 0;
  for (let i = Math.max(0, from); i < to; i++) {
    if (messageCarriesPrunableMedia(messages[i])) {
      count += 1;
    }
  }
  return count;
}

function readFrozenBoundary(store: PruneBoundaryStore | undefined): number | null {
  if (!store?.getEntries) {
    return null;
  }
  try {
    const entries = store.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (
        entry?.type !== "custom" ||
        entry?.customType !== HISTORY_IMAGE_PRUNE_BOUNDARY_CUSTOM_TYPE
      ) {
        continue;
      }
      const index = (entry.data as { index?: unknown } | undefined)?.index;
      return typeof index === "number" && Number.isFinite(index) ? index : null;
    }
  } catch {
    return null;
  }
  return null;
}

function writeFrozenBoundary(store: PruneBoundaryStore | undefined, index: number): void {
  store?.appendCustomEntry?.(HISTORY_IMAGE_PRUNE_BOUNDARY_CUSTOM_TYPE, { index });
}

export function resolveEffectivePruneBoundary(
  messages: AgentMessage[],
  policy: HistoryImagePrunePolicy | undefined,
): number {
  const natural = resolvePruneBeforeIndex(messages);
  if (natural < 0 || !policy) {
    return natural;
  }
  const frozen = readFrozenBoundary(policy.sessionManager);
  const warm = isPromptCacheWarm(policy, policy.now ?? Date.now());
  if (!warm || frozen === null || frozen > natural) {
    if (frozen !== natural) {
      writeFrozenBoundary(policy.sessionManager, natural);
    }
    return natural;
  }
  const maxDeferred = policy.maxDeferredImageTurns ?? DEFAULT_MAX_DEFERRED_IMAGE_TURNS;
  if (countPrunableMediaTurns(messages, frozen, natural) >= maxDeferred) {
    writeFrozenBoundary(policy.sessionManager, natural);
    return natural;
  }
  return frozen;
}

/**
 * Number of most-recent completed turns whose preceding user/toolResult image
 * blocks are kept intact. Counts all completed turns, not just image-bearing
 * ones, so text-only turns consume the window.
 */
const PRESERVE_RECENT_COMPLETED_TURNS = 3;

function resolvePruneBeforeIndex(messages: AgentMessage[]): number {
  const completedTurnStarts: number[] = [];
  let currentTurnStart = -1;
  let currentTurnHasAssistantReply = false;

  for (let i = 0; i < messages.length; i++) {
    const role = messages[i]?.role;
    if (role === "user") {
      if (currentTurnStart >= 0 && currentTurnHasAssistantReply) {
        completedTurnStarts.push(currentTurnStart);
      }
      currentTurnStart = i;
      currentTurnHasAssistantReply = false;
      continue;
    }
    if (role === "toolResult") {
      if (currentTurnStart < 0) {
        currentTurnStart = i;
      }
      continue;
    }
    if (role === "assistant" && currentTurnStart >= 0) {
      currentTurnHasAssistantReply = true;
    }
  }

  if (currentTurnStart >= 0 && currentTurnHasAssistantReply) {
    completedTurnStarts.push(currentTurnStart);
  }

  if (completedTurnStarts.length <= PRESERVE_RECENT_COMPLETED_TURNS) {
    return -1;
  }
  return completedTurnStarts[completedTurnStarts.length - PRESERVE_RECENT_COMPLETED_TURNS];
}

function pruneHistoryMediaReferenceText(text: string): string {
  return text
    .replace(MEDIA_ATTACHED_HISTORY_REF_PATTERN, PRUNED_HISTORY_MEDIA_REFERENCE_MARKER)
    .replace(MESSAGE_IMAGE_HISTORY_REF_PATTERN, PRUNED_HISTORY_MEDIA_REFERENCE_MARKER)
    .replace(INBOUND_MEDIA_URI_HISTORY_REF_PATTERN, PRUNED_HISTORY_MEDIA_REFERENCE_MARKER);
}

function cloneMessageWithContent(
  message: Extract<AgentMessage, { role: "user" | "toolResult" }>,
  content: typeof message.content,
): AgentMessage {
  return { ...message, content } as AgentMessage;
}

/**
 * Idempotent cleanup: prune persisted image blocks from completed turns older
 * than {@link PRESERVE_RECENT_COMPLETED_TURNS}. The delay also reduces
 * prompt-cache churn, though prefix stability additionally depends on the
 * replay sanitizer being idempotent. Textual media markers are scrubbed on the
 * same boundary because detectAndLoadPromptImages treats them as fresh prompt
 * image references when old history is replayed into a later prompt.
 */
export function pruneProcessedHistoryImages(
  messages: AgentMessage[],
  policy?: HistoryImagePrunePolicy,
): AgentMessage[] | null {
  const pruneBeforeIndex = resolveEffectivePruneBoundary(messages, policy);
  if (pruneBeforeIndex < 0) {
    return null;
  }

  let prunedMessages: AgentMessage[] | null = null;
  for (let i = 0; i < pruneBeforeIndex; i++) {
    const message = messages[i];
    if (!message || (message.role !== "user" && message.role !== "toolResult")) {
      continue;
    }

    if (typeof message.content === "string") {
      const prunedText = pruneHistoryMediaReferenceText(message.content);
      if (prunedText !== message.content) {
        prunedMessages ??= messages.slice();
        prunedMessages[i] = cloneMessageWithContent(message, prunedText);
      }
      continue;
    }

    if (!Array.isArray(message.content)) {
      continue;
    }

    for (let j = 0; j < message.content.length; j++) {
      const block = message.content[j];
      if (!block || typeof block !== "object") {
        continue;
      }
      const blockType = (block as { type?: string }).type;
      if (blockType === "text" && typeof (block as { text?: unknown }).text === "string") {
        const text = (block as { text: string }).text;
        const prunedText = pruneHistoryMediaReferenceText(text);
        if (prunedText !== text) {
          prunedMessages ??= messages.slice();
          const baseMessage = prunedMessages[i];
          const baseContent =
            baseMessage && "content" in baseMessage && Array.isArray(baseMessage.content)
              ? baseMessage.content
              : message.content;
          const nextContent = baseContent.slice() as typeof message.content;
          nextContent[j] = { ...block, text: prunedText } as (typeof message.content)[number];
          prunedMessages[i] = cloneMessageWithContent(message, nextContent);
        }
        continue;
      }
      if (blockType === "image") {
        prunedMessages ??= messages.slice();
        const baseMessage = prunedMessages[i];
        const baseContent =
          baseMessage && "content" in baseMessage && Array.isArray(baseMessage.content)
            ? baseMessage.content
            : message.content;
        const nextContent = baseContent.slice() as typeof message.content;
        nextContent[j] = {
          type: "text",
          text: PRUNED_HISTORY_IMAGE_MARKER,
        } as (typeof message.content)[number];
        prunedMessages[i] = cloneMessageWithContent(message, nextContent);
      }
    }
  }

  return prunedMessages;
}

export function installHistoryImagePruneContextTransform(
  agent: PrunableContextAgent,
  resolvePolicy?: () => HistoryImagePrunePolicy | undefined,
): () => void {
  const originalTransformContext = agent.transformContext;
  agent.transformContext = async (messages: AgentMessage[], signal?: AbortSignal) => {
    const transformed = originalTransformContext
      ? await originalTransformContext.call(agent, messages, signal)
      : messages;
    const sourceMessages = Array.isArray(transformed) ? transformed : messages;
    return pruneProcessedHistoryImages(sourceMessages, resolvePolicy?.()) ?? sourceMessages;
  };
  return () => {
    agent.transformContext = originalTransformContext;
  };
}
