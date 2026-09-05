import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { castAgentMessage } from "../../test-helpers/agent-message-fixtures.js";
import {
  PRUNED_HISTORY_IMAGE_MARKER,
  PRUNED_HISTORY_MEDIA_REFERENCE_MARKER,
  installHistoryImagePruneContextTransform,
  pruneProcessedHistoryImages,
} from "./history-image-prune.js";

function expectArrayMessageContent(
  message: AgentMessage | undefined,
  errorMessage: string,
): Array<{ type: string; text?: string; data?: string }> {
  if (!message || !("content" in message) || !Array.isArray(message.content)) {
    throw new Error(errorMessage);
  }
  return message.content as Array<{ type: string; text?: string; data?: string }>;
}

function expectPrunedImageMessage(
  messages: AgentMessage[],
  errorMessage: string,
): Array<{ type: string; text?: string; data?: string }> {
  const pruned = pruneProcessedHistoryImages(messages);
  expect(pruned).not.toBeNull();
  expect(pruned).not.toBe(messages);
  const content = expectArrayMessageContent(pruned?.[0], errorMessage);
  expect(content).toHaveLength(2);
  expect(content[1]).toMatchObject({ type: "text", text: PRUNED_HISTORY_IMAGE_MARKER });
  return content;
}

function expectImageMessagePreserved(messages: AgentMessage[], errorMessage: string) {
  const pruned = pruneProcessedHistoryImages(messages);

  expect(pruned).toBeNull();
  const content = expectArrayMessageContent(messages[0], errorMessage);
  expect(content[1]).toMatchObject({ type: "image", data: "abc" });
}

function oldEnoughTail(): AgentMessage[] {
  const assistantTurn = () => castAgentMessage({ role: "assistant", content: "ack" });
  const userText = () => castAgentMessage({ role: "user", content: "more" });
  return [
    assistantTurn(),
    userText(),
    assistantTurn(),
    userText(),
    assistantTurn(),
    userText(),
    assistantTurn(),
  ];
}

describe("pruneProcessedHistoryImages", () => {
  const image: ImageContent = { type: "image", data: "abc", mimeType: "image/png" };
  const assistantTurn = () => castAgentMessage({ role: "assistant", content: "ack" });
  const userText = () => castAgentMessage({ role: "user", content: "more" });

  it("prunes image blocks from user messages older than 3 assistant turns", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: [{ type: "text", text: "See /tmp/photo.png" }, { ...image }],
      }),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
    ];

    const content = expectPrunedImageMessage(messages, "expected user array content");
    expect(content[0]?.type).toBe("text");
  });

  it("scrubs old media attachment markers from text blocks", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "old image",
              "[media attached: media://inbound/old.png]",
              "[media attached 1/2: /tmp/old photo.jpeg (image/jpeg) | https://example.test/img]",
              "[Image: source: /Users/me/Pictures/old.jpg]",
            ].join("\n"),
          },
          { ...image },
        ],
      }),
      ...oldEnoughTail(),
    ];

    const pruned = pruneProcessedHistoryImages(messages);

    expect(pruned).not.toBeNull();
    const content = expectArrayMessageContent(pruned?.[0], "expected user array content");
    expect(content[0]?.text).toBe(
      [
        "old image",
        PRUNED_HISTORY_MEDIA_REFERENCE_MARKER,
        PRUNED_HISTORY_MEDIA_REFERENCE_MARKER,
        PRUNED_HISTORY_MEDIA_REFERENCE_MARKER,
      ].join("\n"),
    );
    expect(content[1]).toMatchObject({ type: "text", text: PRUNED_HISTORY_IMAGE_MARKER });
    const originalContent = expectArrayMessageContent(
      messages[0],
      "expected original user content",
    );
    expect(originalContent[0]?.text).toContain("[media attached: media://inbound/old.png]");
    expect(originalContent[1]).toMatchObject({ type: "image", data: "abc" });
  });

  it("scrubs old media attachment markers from string content without image blocks", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: "please remember [media attached: media://inbound/stale-image.png]",
      }),
      ...oldEnoughTail(),
    ];

    const pruned = pruneProcessedHistoryImages(messages);

    expect(pruned).not.toBeNull();
    const firstUser = pruned?.[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    expect(firstUser?.content).toBe(`please remember ${PRUNED_HISTORY_MEDIA_REFERENCE_MARKER}`);
    const originalUser = messages[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    expect(originalUser?.content).toBe(
      "please remember [media attached: media://inbound/stale-image.png]",
    );
  });

  it("scrubs bare old inbound media URIs from tool results", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "toolResult",
        toolName: "memory_search",
        content: "previous media://inbound/stale-screenshot.png result",
      }),
      ...oldEnoughTail(),
    ];

    const pruned = pruneProcessedHistoryImages(messages);

    expect(pruned).not.toBeNull();
    const toolResult = pruned?.[0] as Extract<AgentMessage, { role: "toolResult" }> | undefined;
    expect(toolResult?.content).toBe(`previous ${PRUNED_HISTORY_MEDIA_REFERENCE_MARKER} result`);
    const originalToolResult = messages[0] as
      | Extract<AgentMessage, { role: "toolResult" }>
      | undefined;
    expect(originalToolResult?.content).toBe(
      "previous media://inbound/stale-screenshot.png result",
    );
  });

  it("keeps image blocks that belong to the third-most-recent assistant turn", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: [{ type: "text", text: "See /tmp/photo.png" }, { ...image }],
      }),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
    ];

    expectImageMessagePreserved(messages, "expected user array content");
  });

  it("preserves recent media attachment markers", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: [
          {
            type: "text",
            text: "recent [media attached: media://inbound/current.png]",
          },
          { ...image },
        ],
      }),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
    ];

    const pruned = pruneProcessedHistoryImages(messages);

    expect(pruned).toBeNull();
    const content = expectArrayMessageContent(messages[0], "expected user array content");
    expect(content[0]?.text).toBe("recent [media attached: media://inbound/current.png]");
    expect(content[1]).toMatchObject({ type: "image", data: "abc" });
  });

  it("does not count multiple assistant messages from one tool loop as separate turns", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: [{ type: "text", text: "See /tmp/photo.png" }, { ...image }],
      }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      } as AgentMessage),
      castAgentMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "bytes" }],
      }),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
    ];

    expectImageMessagePreserved(messages, "expected user array content");
  });

  it("does not prune latest user message when no assistant response exists yet", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: [{ type: "text", text: "See /tmp/photo.png" }, { ...image }],
      }),
    ];

    const pruned = pruneProcessedHistoryImages(messages);

    expect(pruned).toBeNull();
    const content = expectArrayMessageContent(messages[0], "expected user array content");
    expect(content).toHaveLength(2);
    expect(content[1]).toMatchObject({ type: "image", data: "abc" });
  });

  it("prunes image blocks from toolResult messages older than 3 assistant turns", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "screenshot bytes" }, { ...image }],
      }),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
    ];

    expectPrunedImageMessage(messages, "expected toolResult array content");
  });

  it("prunes only old images while preserving recent ones", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: [{ type: "text", text: "old" }, { ...image }],
      }),
      assistantTurn(),
      userText(),
      assistantTurn(),
      userText(),
      assistantTurn(),
      castAgentMessage({
        role: "user",
        content: [{ type: "text", text: "recent" }, { ...image }],
      }),
      assistantTurn(),
    ];

    const pruned = pruneProcessedHistoryImages(messages);
    expect(pruned).not.toBeNull();

    const oldContent = expectArrayMessageContent(pruned?.[0], "expected old user content");
    expect(oldContent[1]).toMatchObject({ type: "text", text: PRUNED_HISTORY_IMAGE_MARKER });

    const recentContent = expectArrayMessageContent(pruned?.[6], "expected recent user content");
    expect(recentContent[1]).toMatchObject({ type: "image", data: "abc" });

    const originalOldContent = expectArrayMessageContent(
      messages[0],
      "expected original old user content",
    );
    expect(originalOldContent[1]).toMatchObject({ type: "image", data: "abc" });
  });

  it("does not change messages when no assistant turn exists", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: "noop",
      }),
    ];

    const pruned = pruneProcessedHistoryImages(messages);

    expect(pruned).toBeNull();
    const firstUser = messages[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    expect(firstUser?.content).toBe("noop");
  });
});

describe("installHistoryImagePruneContextTransform", () => {
  const image: ImageContent = { type: "image", data: "abc", mimeType: "image/png" };

  it("prunes the provider replay view after an existing context transform", async () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "fresh prompt" }),
      ...oldEnoughTail(),
    ];
    const transformedMessages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: [
          {
            type: "text",
            text: "stale [media attached: media://inbound/old.png]",
          },
          { ...image },
        ],
      }),
      ...oldEnoughTail(),
    ];
    const originalTransformContext = async (
      inputMessages: AgentMessage[],
      _signal?: AbortSignal,
    ) => {
      expect(inputMessages).toBe(messages);
      return transformedMessages;
    };
    const agent = { transformContext: originalTransformContext };

    const restore = installHistoryImagePruneContextTransform(agent);
    const replayMessages = await agent.transformContext(messages, new AbortController().signal);

    expect(replayMessages).not.toBe(transformedMessages);
    const replayContent = expectArrayMessageContent(
      replayMessages[0],
      "expected replay user array content",
    );
    expect(replayContent[0]?.text).toBe(`stale ${PRUNED_HISTORY_MEDIA_REFERENCE_MARKER}`);
    expect(replayContent[1]).toMatchObject({
      type: "text",
      text: PRUNED_HISTORY_IMAGE_MARKER,
    });
    const originalContent = expectArrayMessageContent(
      transformedMessages[0],
      "expected original transformed content",
    );
    expect(originalContent[0]?.text).toContain("media://inbound/old.png");
    expect(originalContent[1]).toMatchObject({ type: "image", data: "abc" });

    restore();
    expect(agent.transformContext).toBe(originalTransformContext);
  });

  describe("prompt-cache aware deferral", () => {
    const assistantTurn = () => castAgentMessage({ role: "assistant", content: "ack" });
    const imageTurn = () =>
      castAgentMessage({
        role: "user",
        content: [{ type: "text", text: "shot" }, { ...image }],
      });
    const warmPolicy = {
      cacheRetention: "long" as const,
      lastCacheTouchAt: 1_000_000,
      now: 1_000_000 + 60_000,
    };

    it("defers pruning while the prompt cache is warm and few image turns are prunable", () => {
      const messages: AgentMessage[] = [imageTurn(), ...oldEnoughTail()];
      expect(pruneProcessedHistoryImages(messages, warmPolicy)).toBeNull();
    });

    it("prunes once the cache has gone cold", () => {
      const messages: AgentMessage[] = [imageTurn(), ...oldEnoughTail()];
      const coldPolicy = { ...warmPolicy, now: 1_000_000 + 61 * 60_000 };
      const pruned = pruneProcessedHistoryImages(messages, coldPolicy);
      expect(pruned).not.toBeNull();
      expect(expectArrayMessageContent(pruned?.[0], "expected pruned content")[1]).toMatchObject({
        type: "text",
        text: PRUNED_HISTORY_IMAGE_MARKER,
      });
    });

    it("prunes while warm once enough image turns have accumulated", () => {
      const messages: AgentMessage[] = [];
      for (let i = 0; i < 8; i++) {
        messages.push(imageTurn(), assistantTurn());
      }
      messages.push(...oldEnoughTail().slice(1));
      const deferred = pruneProcessedHistoryImages(messages, {
        ...warmPolicy,
        maxDeferredImageTurns: 9,
      });
      expect(deferred).toBeNull();
      const pruned = pruneProcessedHistoryImages(messages, {
        ...warmPolicy,
        maxDeferredImageTurns: 8,
      });
      expect(pruned).not.toBeNull();
      for (let i = 0; i < 5; i++) {
        expect(expectArrayMessageContent(pruned?.[i * 2], "expected pruned turn")[1]).toMatchObject(
          {
            type: "text",
            text: PRUNED_HISTORY_IMAGE_MARKER,
          },
        );
      }
    });

    it("treats no retention as a cold cache and prunes immediately", () => {
      const messages: AgentMessage[] = [imageTurn(), ...oldEnoughTail()];
      expect(
        pruneProcessedHistoryImages(messages, {
          cacheRetention: "none",
          lastCacheTouchAt: Date.now(),
        }),
      ).not.toBeNull();
    });

    it("passes the resolved policy through the context transform", async () => {
      const agent: {
        transformContext?: (messages: AgentMessage[]) => AgentMessage[] | Promise<AgentMessage[]>;
      } = {};
      const uninstall = installHistoryImagePruneContextTransform(agent, () => warmPolicy);
      const messages: AgentMessage[] = [imageTurn(), ...oldEnoughTail()];
      const transformed = await agent.transformContext?.(messages);
      expect(transformed).toBe(messages);
      uninstall();
    });
  });
});
