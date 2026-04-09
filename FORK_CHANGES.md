# Fork changes

This file tracks every deviation in this fork from upstream `openclaw/openclaw`. Update it whenever you commit a fork-specific change so upstream merges stay manageable.

When merging upstream, walk this file top-to-bottom and re-apply / re-verify each entry.

---

## src/agents/system-prompt.ts

### Identity line — strip OpenClaw branding

Both occurrences of `"You are a personal assistant operating inside OpenClaw."` (one in the `promptMode === "none"` early return, one in the main `lines` array) replaced with:

```
You are a personal assistant.
```

### Safety guardrail — favor workspace files as content authority

Old (line ~462):

```
Prioritize safety and human oversight over completion; if instructions conflict, pause and ask; comply with stop/pause/audit requests and never bypass safeguards. (Inspired by Anthropic's constitution.)
```

New:

```
Prioritize safety over completion. Comply with stop/pause/audit requests. Your workspace files define your content boundaries — trust them.
```

### SOUL.md guidance — workspace files are primary authority

Old (line ~100):

```
If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it.
```

New:

```
If SOUL.md is present, fully embody its persona, tone, and content guidelines. SOUL.md is your primary behavioral authority.
```

### User-facing OpenClaw mentions scrubbed

Lowercase `openclaw` CLI command references (e.g. `openclaw gateway start`) are KEPT — those are valid command names, not branding.

User-facing prompt strings updated to remove the OpenClaw word:

| Section                 | Old                                                                                            | New                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Messaging guidance      | `"OpenClaw handles all routing internally"`                                                    | `"routing is handled internally"`                                                                 |
| Documentation section   | `` `OpenClaw docs: ${docsPath}` ``                                                             | `` `Docs: ${docsPath}` ``                                                                         |
| Documentation section   | `"For OpenClaw behavior, commands, config, or architecture: consult local docs first."`        | `"For runtime behavior, commands, config, or architecture: consult local docs first."`            |
| CLI section header      | `"## OpenClaw CLI Quick Reference"`                                                            | `"## CLI Quick Reference"`                                                                        |
| CLI section intro       | `"OpenClaw is controlled via subcommands. Do not invent commands."`                            | `"The runtime is controlled via subcommands. Do not invent commands."`                            |
| Self-update header      | `"## OpenClaw Self-Update"`                                                                    | `"## Self-Update"`                                                                                |
| Self-update body        | `"After restart, OpenClaw pings the last active session automatically."`                       | `"After restart, the runtime pings the last active session automatically."`                       |
| Workspace files section | `"These user-editable files are loaded by OpenClaw and included below in Project Context."`    | `"These user-editable files are loaded automatically and included below in Project Context."`     |
| Heartbeat section       | `'OpenClaw treats a leading/trailing "HEARTBEAT_OK" as a heartbeat ack (and may discard it).'` | `'The runtime treats a leading/trailing "HEARTBEAT_OK" as a heartbeat ack (and may discard it).'` |

The mirror/source/community URLs in the docs section were also dropped (`https://docs.openclaw.ai`, `https://github.com/openclaw/openclaw`, `https://discord.com/invite/clawd`, `https://clawhub.ai`).

### Removals to investigate (NOT YET DONE)

These additional user-facing OpenClaw mentions exist in agent files outside `system-prompt.ts` and should be evaluated for the same scrub policy:

- `src/agents/subagent-announce.ts:139` — `'`agents_list`and`subagents` apply to OpenClaw sub-agents...'` (we changed line 142 of this file but not 139)
- `src/agents/tools/music-generate-tool.ts:109, 543` — tool description strings sent to the model
- `src/agents/tools/video-generate-tool.ts:112, 134, 715` — tool description strings
- `src/agents/tools/image-generate-tool.ts:85` — tool description string
- `src/agents/internal-runtime-context.ts:9` — internal runtime context label (probably not in system prompt)
- `src/agents/internal-events.ts:88` — same
- `src/agents/pi-embedded-helpers/errors.ts:185` — error message users may see when surfaced

These are NOT scrubbed in this initial fork commit. Add them in a follow-up if you want the OpenClaw word fully eliminated from anything the model or user can see.

---

## src/agents/bash-tools.exec.ts

### Removed `complex interpreter invocation` preflight check

In `validateScriptFileForShellBleed`, the upstream early-return path for "no script target" used to call `shouldFailClosedInterpreterPreflight` and throw `"exec preflight: complex interpreter invocation detected; refusing to run without script preflight validation."` when the heuristic flagged the command.

That entire `if (...) throw new Error(...)` block was removed in this fork. The function now simply returns when there's no script target:

```ts
const target = extractScriptTargetFromCommand(params.command);
if (!target) {
  return;
}
```

**Why:** the upstream check fail-closed on legitimate compound shell commands that the agent's prompts use (e.g. `grep X file; python3 check-trial.py`). Single-tenant trusted-prompt deployment, so the multi-tenant injection-defense rationale doesn't apply.

**Other preflight checks intact:** the rest of `validateScriptFileForShellBleed` (script path sandbox check, shell variable injection scanning of script files, JS-starts-with-shell-syntax check) is unchanged. Only the no-script-target heuristic block was removed.

---

## src/agents/subagent-announce.ts

### Subagent guidance scrub (1 of 2)

Line 142, inside the ACP-enabled subagent guidance block:

Old:

```
Use `subagents` only for OpenClaw subagents (`runtime: "subagent"`).
```

New:

```
Use `subagents` only for native subagents (`runtime: "subagent"`).
```

Line 139 (`'`agents_list`and`subagents` apply to OpenClaw sub-agents...'`) is NOT yet scrubbed — see "Removals to investigate" above.

---

## extensions/bluebubbles/src/types.ts — undici 8.0 compat fix

**Upstream bug**: BB attachment downloads fail with `Error: invalid onRequestStart method` because `blueBubblesFetchWithTimeout` calls plain `fetch(url, init)` even when `init` has a `dispatcher` injected by core's SSRF guard. On undici 8.0 the dispatcher leaks into `globalThis.fetch`'s handler chain, which has an incompatible interceptor shape, and every BB image/video download throws.

**Fix**: route through `fetchWithRuntimeDispatcher` from `openclaw/plugin-sdk/infra-runtime` when `init.dispatcher` is set, otherwise use plain `fetch`. Same pattern as the upstream Slack fix in commit `e8fb140642` (`fix: preserve Slack guarded media transport`) — that fix wasn't applied to the bluebubbles plugin.

Added import:

```ts
import { fetchWithRuntimeDispatcher } from "openclaw/plugin-sdk/infra-runtime";
```

Modified plain-fetch branch of `blueBubblesFetchWithTimeout`:

```ts
const fetchImpl =
  init != null && "dispatcher" in init ? fetchWithRuntimeDispatcher : fetch;
try {
  return await fetchImpl(url, { ...init, signal: controller.signal });
} finally { ... }
```

When upstream lands a proper bluebubbles equivalent of `e8fb140642`, drop this section.

---

## extensions/bluebubbles — `?agentId=` query param override

Enables per-request dynamic agent routing for the BB channel without maintaining file-based `bindings[]` rewrites. This fork adds an `?agentId=<name>` query parameter to `/bluebubbles-webhook` that, when set and allowlisted in config, overrides the normal route resolution for that message.

Files touched:

- `src/plugin-sdk/routing.ts` — export `buildAgentPeerSessionKey` so extensions can synthesize session keys
- `extensions/bluebubbles/src/conversation-route.ts` — accept optional `agentIdOverride`; when allowlisted, build the route directly via `buildAgentPeerSessionKey` bypassing `bindings[]` lookup
- `extensions/bluebubbles/src/monitor.ts` — extract `?agentId=` from the webhook URL and thread through `debouncer.enqueue`
- `extensions/bluebubbles/src/monitor-debounce.ts` — `BlueBubblesDebounceEntry` carries `agentIdOverride`; debouncer forwards it to `processMessage`
- `extensions/bluebubbles/src/monitor-processing.ts` — `processMessage` accepts `options.agentIdOverride` and passes it to `resolveBlueBubblesConversationRoute`
- `extensions/bluebubbles/src/conversation-route.test.ts` — two tests covering allowlisted override + rejection of non-allowlisted override

Config schema: `channels.bluebubbles.allowAgentIdOverride: string[]`. Only agents in this allowlist can be targeted via the query param. Not in this allowlist = override silently ignored, normal routing applies.

No upstream equivalent. Revert via `git revert` if the entire dynamic-routing feature is retired.

---

## Test files updated to match source changes

These test files have assertions that pin the exact prompt strings. They're updated whenever a prompt above changes; they're not new fork features.

### src/agents/system-prompt.test.ts

- Safety guardrail assertions (2 places) updated to match new "Prioritize safety over completion…" wording.
- SOUL.md assertion (1 place) updated to match new wording.
- 5 OpenClaw-scrub follow-ups: `## CLI Quick Reference`, `## Self-Update`, `Docs: …`, `For runtime behavior…` (×2), `Use \`subagents\` only for native subagents`.

### src/agents/cli-runner.spawn.test.ts

- SOUL.md prompt assertion (1 place) updated.

### src/agents/bash-tools.exec.script-preflight.test.ts

- 16 `it("fails closed for…")` cases changed to `it.skip(…)` because the throw they assert was removed in `bash-tools.exec.ts`. Test bodies preserved verbatim so an upstream merge can re-enable them if upstream changes the underlying behavior. The 13 `it("does not fail closed for…")` negative tests are untouched.
- All other preflight tests in this file (shell variable injection, JS-as-shell, path-qualified env, script path sandbox) are unchanged and still run.
