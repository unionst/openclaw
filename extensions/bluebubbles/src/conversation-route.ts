import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  getSessionBindingService,
  isPluginOwnedSessionBindingRecord,
  resolveConfiguredBindingRoute,
} from "openclaw/plugin-sdk/conversation-runtime";
import {
  buildAgentPeerSessionKey,
  deriveLastRoutePolicy,
  resolveAgentIdFromSessionKey,
  resolveAgentRoute,
} from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveBlueBubblesInboundConversationId } from "./conversation-id.js";

export function resolveBlueBubblesConversationRoute(params: {
  cfg: OpenClawConfig;
  accountId: string;
  isGroup: boolean;
  peerId: string;
  sender: string;
  chatId?: number | null;
  chatGuid?: string | null;
  chatIdentifier?: string | null;
  agentIdOverride?: string | null;
}): ReturnType<typeof resolveAgentRoute> {
  let route = resolveAgentRoute({
    cfg: params.cfg,
    channel: "bluebubbles",
    accountId: params.accountId,
    peer: {
      kind: params.isGroup ? "group" : "direct",
      id: params.peerId,
    },
  });

  if (params.agentIdOverride) {
    const bbCfg = (
      params.cfg.channels as { bluebubbles?: { allowAgentIdOverride?: string[] } } | undefined
    )?.bluebubbles;
    const allowList = bbCfg?.allowAgentIdOverride ?? [];
    if (allowList.includes(params.agentIdOverride)) {
      const overriddenSessionKey = buildAgentPeerSessionKey({
        agentId: params.agentIdOverride,
        mainKey: params.cfg.session?.mainKey,
        channel: "bluebubbles",
        accountId: params.accountId,
        peerKind: params.isGroup ? "group" : "direct",
        peerId: params.peerId,
        identityLinks: params.cfg.session?.identityLinks,
        dmScope: params.cfg.session?.dmScope,
      });
      logVerbose(
        `bluebubbles: agent override -> ${params.agentIdOverride} (sessionKey=${overriddenSessionKey})`,
      );
      return {
        ...route,
        agentId: params.agentIdOverride,
        sessionKey: overriddenSessionKey,
        lastRoutePolicy: deriveLastRoutePolicy({
          sessionKey: overriddenSessionKey,
          mainSessionKey: route.mainSessionKey,
        }),
      };
    }
    logVerbose(
      `bluebubbles: agent override rejected (not in allowList): ${params.agentIdOverride}`,
    );
  }

  const conversationId = resolveBlueBubblesInboundConversationId({
    isGroup: params.isGroup,
    sender: params.sender,
    chatId: params.chatId,
    chatGuid: params.chatGuid,
    chatIdentifier: params.chatIdentifier,
  });
  if (!conversationId) {
    return route;
  }

  route = resolveConfiguredBindingRoute({
    cfg: params.cfg,
    route,
    conversation: {
      channel: "bluebubbles",
      accountId: params.accountId,
      conversationId,
    },
  }).route;

  const runtimeBinding = getSessionBindingService().resolveByConversation({
    channel: "bluebubbles",
    accountId: params.accountId,
    conversationId,
  });
  const boundSessionKey = runtimeBinding?.targetSessionKey?.trim();
  if (!runtimeBinding || !boundSessionKey) {
    return route;
  }

  getSessionBindingService().touch(runtimeBinding.bindingId);
  if (isPluginOwnedSessionBindingRecord(runtimeBinding)) {
    logVerbose(`bluebubbles: plugin-bound conversation ${conversationId}`);
    return route;
  }

  logVerbose(`bluebubbles: routed via bound conversation ${conversationId} -> ${boundSessionKey}`);
  return {
    ...route,
    sessionKey: boundSessionKey,
    agentId: resolveAgentIdFromSessionKey(boundSessionKey),
    lastRoutePolicy: deriveLastRoutePolicy({
      sessionKey: boundSessionKey,
      mainSessionKey: route.mainSessionKey,
    }),
    matchedBy: "binding.channel",
  };
}
