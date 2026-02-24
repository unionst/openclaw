# OpenClaw Fork Changes (unionst/openclaw)

This document tracks all modifications made to the upstream OpenClaw codebase.
Use it as a reference when syncing with upstream to understand what's different and why.

---

## Overview

Two features were added to support running Hermes 4 405B (via Nous Portal / vLLM)
as the primary conversational model with reliable tool calling:

1. **Provider Compat** — A non-streaming StreamFn for OpenAI-compatible providers
   whose streaming returns raw XML instead of structured `tool_calls`.
2. **Compact Mode** — Reduces system prompt and tool schema payload from ~54K to ~15K
   tokens so Hermes tool calling stays reliable.

Both features are opt-in via provider and agent config, and have zero effect when
not enabled.

3. **Subagent Prompt Mode** — Makes subagent `promptMode` configurable and keeps
   skills/docs sections in minimal mode so subagents can discover workspace skills.

---

## New Files

### `src/agents/provider-compat.ts`

Non-streaming StreamFn factory for quirky OpenAI-compatible providers (Nous Portal / vLLM).

**What it does:**

- Makes direct `fetch` calls with `stream: false` instead of using the SDK's streaming
- Converts OpenClaw message format to OpenAI chat format (system/user/assistant/tool)
- Converts OpenAI responses back to OpenClaw's `AssistantMessage` format
- Unwraps double-encoded tool call arguments (JSON string containing a JSON string)
- Emits the response as a single `done` event on the stream

**Key exports:**

- `createProviderCompatStreamFn(baseUrl, modelId, compat)` — Returns a `StreamFn`
- `resolveProviderCompat(providerConfig)` — Reads compat config from provider

**Activated by** `providerCompat.disableStreaming: true` in provider config.

---

## Modified Files

### `src/config/types.models.ts`

Added `ProviderCompatConfig` type and `providerCompat?` field to `ModelProviderConfig`:

```typescript
export type ProviderCompatConfig = {
  disableStreaming?: boolean; // Force stream: false on all requests
  unwrapToolArgs?: boolean; // Fix double-encoded JSON tool args
};
```

### `src/config/types.agent-defaults.ts`

Added `compact?: boolean` to `AgentDefaultsConfig`. When true, enables compact mode
for system prompts and tool schemas.

Added `promptMode?: "full" | "minimal" | "none"` to the `subagents` field inside
`AgentDefaultsConfig`. Defaults to `"minimal"` when not set.

### `src/config/zod-schema.agent-defaults.ts`

Added `promptMode` Zod field to the `subagents` object schema:
`z.union([z.literal("full"), z.literal("minimal"), z.literal("none")]).optional()`

### `src/agents/system-prompt.ts`

**Subagent prompt mode: keep skills and docs in minimal mode.** Removed `isMinimal`
guard from `buildSkillsSection` and `buildDocsSection` so subagents (promptMode=minimal)
still receive skills discovery prompts and docs paths. The `compact` guard remains,
so compact mode (for the primary agent) still strips these sections.

Added compact mode support to `buildAgentSystemPrompt`. When `compact: true`:

**Skipped sections** (wrapped in `if (!compact)` guards):

- Tooling docs / tool listing (redundant with API `tools` param)
- Reply tags
- Messaging routing details
- Inbound context JSON schema
- Runtime info block
- Group chat context
- Current date/time verbose block
- Workspace files injection header
- Skills section (subagent handles skill execution; primary agent delegates via workspace guidance)

**Kept sections** (always included):

- Identity / personality
- Safety guidelines
- Tool call style
- Workspace path
- Memory
- Project context
- Silent replies
- Heartbeats

**Merge strategy:** Each skippable section is wrapped with a simple `if (!compact)`
guard. The original code inside is untouched, so upstream changes to those sections
produce minimal merge conflicts.

### `src/agents/pi-tool-definition-adapter.ts`

Added compact mode support to `toToolDefinitions()`:

**Tool filtering** — `COMPACT_EXCLUDED_TOOLS` set removes complex tools in compact mode:
`exec`, `browser`, `web_search`, `web_fetch`, `process`

**Minimal schemas** — `COMPACT_TOOL_SCHEMAS` map provides stripped-down descriptions
and parameter schemas for the tools that remain:
`read`, `write`, `edit`, `message`, `memory_search`, `memory_get`, `sessions_spawn`,
`subagents`, `cron`

The `toToolDefinitions` function accepts an optional `{ compact?: boolean }` options
parameter. When compact, it filters tools and substitutes minimal schemas.

### `src/agents/pi-embedded-runner/tool-split.ts`

Passes `compact` option through to `toToolDefinitions`.

### `src/agents/pi-embedded-runner/system-prompt.ts`

Passes `compact` option through to `buildAgentSystemPrompt`.

### `src/agents/pi-embedded-runner/run/attempt.ts`

Two changes:

1. **Provider compat StreamFn** — In the streamFn selection block (non-ollama branch),
   checks for `providerCompat` config. If `disableStreaming` is true, creates a
   `createProviderCompatStreamFn` instead of using the SDK's default streaming.
   Inserted in the wrapper chain: base → providerCompat → applyExtraParams →
   cacheTrace → anthropicPayloadLogger.

2. **Compact flag passthrough** — Reads `compact` from
   `params.config?.agents?.defaults?.compact` and passes it to both
   `buildEmbeddedSystemPrompt` and `splitSdkTools`.

3. **Configurable subagent promptMode** — Reads `promptMode` from
   `params.config?.agents?.defaults?.subagents?.promptMode` instead of hardcoding
   `"minimal"`. Falls back to `"minimal"` when not configured.

---

## Config Example

```json
{
  "models": {
    "providers": {
      "nous": {
        "api": "openai-completions",
        "baseUrl": "https://inference-api.nousresearch.com/v1",
        "providerCompat": {
          "disableStreaming": true,
          "unwrapToolArgs": true
        },
        "models": [{ "id": "Hermes-4-405B", "name": "Hermes 4 405B" }]
      }
    }
  },
  "agents": {
    "defaults": {
      "compact": true
    }
  }
}
```

4. **Bootstrap Expiry** — Stops injecting BOOTSTRAP.md into the system prompt
   after a configurable number of user messages (`bootstrapExpiry`, default: 10).
   Prevents wasted context when the agent fails to delete BOOTSTRAP.md after onboarding.

5. **Typing Gate** — Pauses the debouncer and aborts active model runs when the
   user starts typing in iMessage, preventing the companion from talking over
   the user. Resumes when typing stops. On by default, configurable via
   `typingGate: false` per BlueBubbles account.

---

## Typing Gate

### `src/auto-reply/inbound-debounce.ts`

Added `isPaused` callback parameter and `resumeMatching(predicate)` method to
`createInboundDebouncer`. When `isPaused` returns true for a key, `scheduleFlush`
skips scheduling. `resumeMatching` re-schedules flush for all buffers matching a
predicate — used to resume after typing stops.

### `src/plugins/runtime/types.ts` + `src/plugins/runtime/index.ts`

Exposed three functions on `PluginRuntime.channel.session`:

- `loadSessionStore` — read session store to look up sessionId
- `abortEmbeddedPiRun` — cancel an active model run by sessionId
- `clearSessionQueues` — clear followup/command queues by session key

### `extensions/bluebubbles/src/monitor.ts`

- Added `typing-indicator` to `allowedEventTypes`
- Added typing indicator webhook handler with inline auth resolution
- Added `handleTypingIndicator()` — pause/resume debouncer + abort active runs
- Added `abortActiveRunForChat()` — resolves session key from chatGuid, looks up
  session store, calls `abortEmbeddedPiRun` + `clearSessionQueues`
- Added `isPaused` callback to `getOrCreateDebouncer()` that checks per-account
  paused chat state
- Respects `typingGate` (default: true) and `typingGateTimeoutMs` (default: 60s)
  from BlueBubbles account config

### `extensions/bluebubbles/src/types.ts`

Added `typingGate?: boolean` and `typingGateTimeoutMs?: number` to
`BlueBubblesAccountConfig`.

### `extensions/bluebubbles/src/config-schema.ts`

Added Zod validation for `typingGate` and `typingGateTimeoutMs`.

### `extensions/bluebubbles/src/monitor.test.ts`

Added mock stubs for the three new `PluginRuntime.channel.session` methods.

---

## Bootstrap Expiry

### `src/agents/bootstrap-files.ts`

Added `resolveBootstrapExpiry(config)` and `countUserMessagesInSession(sessionFile, limit)`.
The counter parses the session JSONL file and counts `{type: "message", message: {role: "user"}}`
entries, stopping early once the limit is reached.

### `src/agents/pi-embedded-runner/run/attempt.ts`

After `resolveBootstrapContextForRun`, checks user message count against the expiry threshold.
If exceeded, filters out `BOOTSTRAP.md` from both `bootstrapFiles` and `contextFiles`.

### `src/config/types.agent-defaults.ts`

Added `bootstrapExpiry?: number` to `AgentDefaultsConfig`.

### `src/config/zod-schema.agent-defaults.ts`

Added `bootstrapExpiry: z.number().int().nonnegative().optional()`.

---

## Upstream Sync Checklist

When pulling from upstream:

1. `git fetch upstream && git merge upstream/main`
2. Check for conflicts in the modified files listed above
3. Most likely conflicts: `system-prompt.ts` (if upstream adds/restructures sections)
   and `attempt.ts` (if upstream changes the streamFn wrapper chain)
4. `pi-tool-definition-adapter.ts` changes are mostly additive (new const + options param)
   so conflicts are unlikely
5. Run `pnpm build` to verify — zero errors expected if merge is clean
6. Update this document if any changes are needed
