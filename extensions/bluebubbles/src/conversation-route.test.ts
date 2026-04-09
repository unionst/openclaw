import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  __testing as sessionBindingTesting,
  registerSessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBlueBubblesConversationRoute } from "./conversation-route.js";

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
  agents: {
    list: [{ id: "main" }, { id: "codex" }],
  },
} satisfies OpenClawConfig;

describe("resolveBlueBubblesConversationRoute", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
  });

  afterEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
  });

  it("lets runtime BlueBubbles conversation bindings override default routing", () => {
    const touch = vi.fn();
    registerSessionBindingAdapter({
      channel: "bluebubbles",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === "+15555550123"
          ? {
              bindingId: "default:+15555550123",
              targetSessionKey: "agent:codex:acp:bound-1",
              targetKind: "session",
              conversation: {
                channel: "bluebubbles",
                accountId: "default",
                conversationId: "+15555550123",
              },
              status: "active",
              boundAt: Date.now(),
              metadata: { boundBy: "user-1" },
            }
          : null,
      touch,
    });

    const route = resolveBlueBubblesConversationRoute({
      cfg: baseCfg,
      accountId: "default",
      isGroup: false,
      peerId: "+15555550123",
      sender: "+15555550123",
    });

    expect(route.agentId).toBe("codex");
    expect(route.sessionKey).toBe("agent:codex:acp:bound-1");
    expect(route.matchedBy).toBe("binding.channel");
    expect(touch).toHaveBeenCalledWith("default:+15555550123", undefined);
  });

  it("honors ?agentId= override when allowlisted (fork: jesse dynamic routing)", () => {
    const cfg = {
      ...baseCfg,
      session: { mainKey: "main", dmScope: "per-peer" as const },
      agents: { list: [{ id: "main" }, { id: "jesse" }, { id: "jesse-gate" }] },
      channels: {
        bluebubbles: {
          allowAgentIdOverride: ["jesse", "jesse-gate"],
        },
      },
    } as unknown as OpenClawConfig;

    const route = resolveBlueBubblesConversationRoute({
      cfg,
      accountId: "default",
      isGroup: false,
      peerId: "+16198760251",
      sender: "+16198760251",
      agentIdOverride: "jesse",
    });

    expect(route.agentId).toBe("jesse");
    expect(route.sessionKey).toBe("agent:jesse:direct:+16198760251");
  });

  it("rejects ?agentId= override when not allowlisted", () => {
    const cfg = {
      ...baseCfg,
      session: { mainKey: "main", dmScope: "per-peer" as const },
      agents: { list: [{ id: "main" }, { id: "jesse" }] },
      channels: { bluebubbles: { allowAgentIdOverride: ["jesse"] } },
    } as unknown as OpenClawConfig;

    const route = resolveBlueBubblesConversationRoute({
      cfg,
      accountId: "default",
      isGroup: false,
      peerId: "+16198760251",
      sender: "+16198760251",
      agentIdOverride: "sneaky-other-agent",
    });

    // Falls through to the normal routing (default "main") since override was rejected
    expect(route.agentId).toBe("main");
  });
});
