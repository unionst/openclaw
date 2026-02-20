import type { AgentTool } from "@mariozechner/pi-agent-core";
import { toToolDefinitions, type ToToolDefinitionsOptions } from "../pi-tool-definition-adapter.js";

// We always pass tools via `customTools` so our policy filtering, sandbox integration,
// and extended toolset remain consistent across providers.
type AnyAgentTool = AgentTool;

export function splitSdkTools(options: {
  tools: AnyAgentTool[];
  sandboxEnabled: boolean;
  compact?: boolean;
}): {
  builtInTools: AnyAgentTool[];
  customTools: ReturnType<typeof toToolDefinitions>;
} {
  const { tools, compact } = options;
  const toolOpts: ToToolDefinitionsOptions | undefined = compact ? { compact } : undefined;
  return {
    builtInTools: [],
    customTools: toToolDefinitions(tools, toolOpts),
  };
}
